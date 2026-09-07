// Memory Core tests cover Hindsight recall plugin behavior.
import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HINDSIGHT_CONFIG,
  HindsightError,
  buildHindsightPath,
  mergeHindsightSearchResults,
  parseHindsightMemoryId,
  readHindsightMemory,
  recallHindsightMemories,
  recallHindsightMemoriesSafely,
  resolveHindsightConfig,
  testing as hindsightTesting,
  type HindsightConfig,
  type HindsightSearchResult,
  warnHindsightFailureThrottled,
} from "./hindsight.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return { ...actual, createSubsystemLogger: () => loggerMock };
});

const ENABLED_CONFIG: HindsightConfig = {
  ...DEFAULT_HINDSIGHT_CONFIG,
  enabled: true,
  timeoutMs: 50,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubHangingFetch() {
  return stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
}

function hindsightHit(id: string, score = 0): HindsightSearchResult {
  return {
    corpus: "hindsight",
    source: "hindsight",
    id,
    path: buildHindsightPath(id),
    score,
    snippet: `hindsight ${id}`,
  };
}

function markdownHit(path: string, score: number) {
  return { path, score, snippet: `markdown ${path}` };
}

function markdownHits(count: number) {
  return Array.from({ length: count }, (_value, index) =>
    markdownHit(`${String.fromCharCode(97 + index)}.md`, 0.9 - index * 0.1),
  );
}

function paths(results: Array<{ path: string }>): string[] {
  return results.map((result) => result.path);
}

async function expectHindsightError(
  promise: Promise<unknown>,
  code: string,
): Promise<HindsightError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HindsightError);
  expect((error as HindsightError).code).toBe(code);
  return error as HindsightError;
}

describe("resolveHindsightConfig", () => {
  it("is disabled with defaults when the plugin config has no hindsight block", () => {
    const config = resolveHindsightConfig(asOpenClawConfig({}));
    expect(config).toEqual(DEFAULT_HINDSIGHT_CONFIG);
    expect(config.enabled).toBe(false);
  });

  it("reads overrides and falls back per field on invalid values", () => {
    const config = resolveHindsightConfig(
      asOpenClawConfig({
        plugins: {
          entries: {
            "memory-core": {
              config: {
                hindsight: {
                  enabled: true,
                  baseUrl: "http://hindsight.internal:9999/",
                  bank: "   ",
                  budget: "extreme",
                  timeoutMs: 1500,
                  maxResults: -2,
                },
              },
            },
          },
        },
      }),
    );
    expect(config).toEqual({
      enabled: true,
      baseUrl: "http://hindsight.internal:9999/",
      bank: DEFAULT_HINDSIGHT_CONFIG.bank,
      budget: "mid",
      timeoutMs: 1500,
      maxResults: DEFAULT_HINDSIGHT_CONFIG.maxResults,
    });
  });
});

describe("hindsight path ids", () => {
  it("round-trips a memory id through the path form", () => {
    const id = "27b68d76-a055-4cee-812d-31a22355b12a";
    expect(parseHindsightMemoryId(buildHindsightPath(id))).toBe(id);
  });

  it("does not treat markdown paths or empty ids as hindsight ids", () => {
    expect(parseHindsightMemoryId("memory/2026-09-02.md")).toBeUndefined();
    expect(parseHindsightMemoryId("hindsight:   ")).toBeUndefined();
  });
});

describe("mergeHindsightSearchResults", () => {
  it("returns capped markdown results when there are no hindsight hits", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: markdownHits(4),
      hindsightResults: [],
      maxResults: 2,
    });
    expect(paths(merged)).toEqual(["a.md", "b.md"]);
  });

  it("returns capped hindsight results when there are no markdown hits", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: [],
      hindsightResults: [hindsightHit("h1"), hindsightHit("h2")],
      maxResults: 1,
    });
    expect(paths(merged)).toEqual(["hindsight:h1"]);
  });

  it("places unscored hindsight hits after the top three markdown hits", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: markdownHits(5),
      hindsightResults: [hindsightHit("h1"), hindsightHit("h2")],
      maxResults: 10,
    });
    expect(paths(merged)).toEqual([
      "a.md",
      "b.md",
      "c.md",
      "hindsight:h1",
      "hindsight:h2",
      "d.md",
      "e.md",
    ]);
  });

  it("puts unscored hindsight hits last when markdown has fewer than three hits", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: markdownHits(1),
      hindsightResults: [hindsightHit("h1")],
      maxResults: 10,
    });
    expect(paths(merged)).toEqual(["a.md", "hindsight:h1"]);
  });

  it("interleaves scored hindsight hits by score", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: [markdownHit("a.md", 0.9), markdownHit("b.md", 0.4)],
      hindsightResults: [hindsightHit("h1", 0.7), hindsightHit("h2", 0.3)],
      maxResults: 10,
    });
    expect(paths(merged)).toEqual(["a.md", "hindsight:h1", "b.md", "hindsight:h2"]);
  });

  it("applies the zero-score placement per item when scores are mixed", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: markdownHits(5),
      hindsightResults: [hindsightHit("scored", 0.75), hindsightHit("unscored", 0)],
      maxResults: 10,
    });
    expect(paths(merged)).toEqual([
      "a.md",
      "b.md",
      "hindsight:scored",
      "c.md",
      "hindsight:unscored",
      "d.md",
      "e.md",
    ]);
  });

  it("sorts negative scores last but keeps them as scored hits", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: [markdownHit("a.md", 0.9), markdownHit("b.md", 0.1)],
      hindsightResults: [
        hindsightHit("neg", -0.5),
        hindsightHit("zero", 0),
        hindsightHit("pos", 0.5),
      ],
      maxResults: 10,
    });
    expect(paths(merged)).toEqual([
      "a.md",
      "hindsight:pos",
      "b.md",
      "hindsight:zero",
      "hindsight:neg",
    ]);
  });

  it("never spends the reserved Hindsight slot on a negative-scored hit", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: markdownHits(4),
      hindsightResults: [hindsightHit("neg", -100)],
      maxResults: 4,
    });
    expect(paths(merged)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });

  it("reserves a zero-scored hit even when a negative one comes with it", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: markdownHits(4),
      hindsightResults: [hindsightHit("neg", -1), hindsightHit("zero", 0)],
      maxResults: 4,
    });
    expect(paths(merged)).toEqual(["a.md", "b.md", "c.md", "hindsight:zero"]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite score %s in either stream",
    (score) => {
      expect(() =>
        mergeHindsightSearchResults({
          markdownResults: [markdownHit("a.md", score)],
          hindsightResults: [hindsightHit("h1")],
          maxResults: 5,
        }),
      ).toThrow(RangeError);
      expect(() =>
        mergeHindsightSearchResults({
          markdownResults: markdownHits(1),
          hindsightResults: [hindsightHit("h1", score)],
          maxResults: 5,
        }),
      ).toThrow(RangeError);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2.5])(
    "rejects maxResults %s",
    (maxResults) => {
      expect(() =>
        mergeHindsightSearchResults({
          markdownResults: markdownHits(2),
          hindsightResults: [hindsightHit("h1")],
          maxResults,
        }),
      ).toThrow(RangeError);
    },
  );

  it("never exceeds maxResults and keeps three markdown plus one hindsight hit", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: markdownHits(6),
      hindsightResults: [hindsightHit("h1"), hindsightHit("h2"), hindsightHit("h3")],
      maxResults: 4,
    });
    expect(paths(merged)).toEqual(["a.md", "b.md", "c.md", "hindsight:h1"]);
  });

  it("keeps the top markdown hits when scored hindsight hits would otherwise crowd them out", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: [
        markdownHit("a.md", 0.5),
        markdownHit("b.md", 0.4),
        markdownHit("c.md", 0.3),
      ],
      hindsightResults: [hindsightHit("h1", 0.9), hindsightHit("h2", 0.8), hindsightHit("h3", 0.7)],
      maxResults: 4,
    });
    expect(merged).toHaveLength(4);
    expect(paths(merged)).toEqual(["hindsight:h1", "a.md", "b.md", "c.md"]);
  });

  it("prefers the markdown hit when maxResults is one", () => {
    const merged = mergeHindsightSearchResults({
      markdownResults: markdownHits(2),
      hindsightResults: [hindsightHit("h1")],
      maxResults: 1,
    });
    expect(paths(merged)).toEqual(["a.md"]);
  });
});

describe("recallHindsightMemories", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a recall request and maps hits into the search result shape", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({
        results: [
          {
            id: "h1",
            text: "Gate windows are 2h",
            type: "observation",
            occurred_start: "2026-08-06T13:06:00+00:00",
            mentioned_at: "2026-08-10T14:39:06+00:00",
          },
          { id: "h1", text: "duplicate of h1" },
          { id: "h2", text: "Only mentioned", mentioned_at: "2026-08-11T00:00:00+00:00" },
          { id: "h3", text: "Capped away" },
        ],
      }),
    );

    const { results, fetched } = await recallHindsightMemories({
      config: { ...ENABLED_CONFIG, bank: "team bank", baseUrl: "http://127.0.0.1:8888/" },
      query: "gate windows",
      maxResults: 2,
    });
    expect(fetched).toBe(4);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8888/v1/default/banks/team%20bank/memories/recall");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "gate windows",
      types: ["world", "experience", "observation"],
      budget: "mid",
      max_tokens: 4096,
    });
    expect(results).toEqual([
      {
        corpus: "hindsight",
        source: "hindsight",
        id: "h1",
        path: "hindsight:h1",
        score: 0,
        snippet: "Gate windows are 2h",
        kind: "observation",
        date: "2026-08-06T13:06:00+00:00",
      },
      {
        corpus: "hindsight",
        source: "hindsight",
        id: "h2",
        path: "hindsight:h2",
        score: 0,
        snippet: "Only mentioned",
        date: "2026-08-11T00:00:00+00:00",
      },
    ]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 2.5])(
    "rejects an invalid caller maxResults %s before calling the API",
    async (maxResults) => {
      const fetchMock = stubFetch(async () => jsonResponse({ results: [] }));
      await expect(
        recallHindsightMemories({ config: ENABLED_CONFIG, query: "q", maxResults }),
      ).rejects.toThrow(RangeError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("classifies a non-2xx error body that never finishes streaming as timeout", async () => {
    stubFetch(
      async (_url, init) =>
        ({
          ok: false,
          status: 500,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            }),
        }) as unknown as Response,
    );
    await expectHindsightError(
      recallHindsightMemories({ config: { ...ENABLED_CONFIG, timeoutMs: 20 }, query: "q" }),
      "timeout",
    );
  });

  it("propagates caller cancellation while reading a non-2xx error body", async () => {
    stubFetch(
      async (_url, init) =>
        ({
          ok: false,
          status: 404,
          json: () =>
            new Promise((_resolve, reject) => {
              if (init?.signal?.aborted) {
                reject(init.signal.reason);
                return;
              }
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            }),
        }) as unknown as Response,
    );
    const controller = new AbortController();
    const pending = recallHindsightMemories({
      config: ENABLED_CONFIG,
      query: "q",
      cancellation: { callerSignal: controller.signal },
    });
    const reason = new Error("gone");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("classifies a body that never finishes streaming as timeout", async () => {
    stubFetch(
      async (_url, init) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            }),
        }) as unknown as Response,
    );
    await expectHindsightError(
      recallHindsightMemories({ config: { ...ENABLED_CONFIG, timeoutMs: 20 }, query: "q" }),
      "timeout",
    );
  });

  it.each([
    ["an empty object", {}],
    ["a null results field", { results: null }],
    ["a bare array", []],
    ["a result without text", { results: [{ id: "h1" }] }],
    ["a result without id", { results: [{ text: "orphan" }] }],
  ])("classifies %s as parse_error", async (_label, body) => {
    stubFetch(async () => jsonResponse(body));
    await expectHindsightError(
      recallHindsightMemories({ config: ENABLED_CONFIG, query: "q" }),
      "parse_error",
    );
  });

  it("classifies invalid JSON as parse_error", async () => {
    stubFetch(async () => new Response("<html>", { status: 200 }));
    await expectHindsightError(
      recallHindsightMemories({ config: ENABLED_CONFIG, query: "q" }),
      "parse_error",
    );
  });

  it("classifies a recall 404 as http_404, never not_found", async () => {
    stubFetch(async () => jsonResponse({ detail: "bank missing" }, 404));
    const error = await expectHindsightError(
      recallHindsightMemories({ config: ENABLED_CONFIG, query: "q" }),
      "http_404",
    );
    expect(error.message).toContain("bank missing");
  });

  it("classifies a non-2xx response as http_<status> with the server detail", async () => {
    stubFetch(async () => jsonResponse({ detail: "bank exploded" }, 500));
    const error = await expectHindsightError(
      recallHindsightMemories({ config: ENABLED_CONFIG, query: "q" }),
      "http_500",
    );
    expect(error.message).toContain("bank exploded");
  });

  it("classifies a fetch transport failure as unreachable", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expectHindsightError(
      recallHindsightMemories({ config: ENABLED_CONFIG, query: "q" }),
      "unreachable",
    );
  });

  it("classifies the provider timeout as timeout", async () => {
    stubHangingFetch();
    await expectHindsightError(
      recallHindsightMemories({ config: { ...ENABLED_CONFIG, timeoutMs: 20 }, query: "q" }),
      "timeout",
    );
  });

  it("propagates caller cancellation untouched", async () => {
    stubHangingFetch();
    const controller = new AbortController();
    const pending = recallHindsightMemories({
      config: ENABLED_CONFIG,
      query: "q",
      cancellation: { callerSignal: controller.signal },
    });
    const reason = new Error("caller went away");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("recallHindsightMemoriesSafely", () => {
  beforeEach(() => {
    hindsightTesting.resetHindsightWarningThrottle();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("degrades to no hits with the failure code and logs one warning on timeout", async () => {
    stubHangingFetch();
    const outcome = await recallHindsightMemoriesSafely({
      config: { ...ENABLED_CONFIG, timeoutMs: 20 },
      query: "slow",
    });
    expect(outcome.results).toEqual([]);
    expect(outcome.code).toBe("timeout");
    expect(outcome.error).toContain("timed out");
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn.mock.calls[0]?.[0]).toContain("timeout");
  });

  it("treats a structurally invalid response as a provider failure, not an empty success", async () => {
    stubFetch(async () => jsonResponse({}));
    const outcome = await recallHindsightMemoriesSafely({ config: ENABLED_CONFIG, query: "q" });
    expect(outcome.results).toEqual([]);
    expect(outcome.code).toBe("parse_error");
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("settles silently as abandoned when the tool cancels the recall", async () => {
    stubHangingFetch();
    const abandon = new AbortController();
    const pending = recallHindsightMemoriesSafely({
      config: ENABLED_CONFIG,
      query: "q",
      cancellation: { abandonSignal: abandon.signal },
    });
    abandon.abort();
    await expect(pending).resolves.toMatchObject({ results: [], abandoned: true });
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("logs a recall 404 as a provider failure", async () => {
    stubFetch(async () => jsonResponse({ detail: "no such bank" }, 404));
    const outcome = await recallHindsightMemoriesSafely({ config: ENABLED_CONFIG, query: "q" });
    expect(outcome.code).toBe("http_404");
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("reports an unexpected exception as internal and logs it unthrottled", async () => {
    stubFetch(
      async () =>
        ({
          get ok(): boolean {
            throw new RangeError("response object is broken");
          },
        }) as unknown as Response,
    );
    const first = await recallHindsightMemoriesSafely({ config: ENABLED_CONFIG, query: "q" });
    const second = await recallHindsightMemoriesSafely({ config: ENABLED_CONFIG, query: "q" });
    expect(first.code).toBe("internal");
    expect(first.error).toContain("response object is broken");
    expect(second.code).toBe("internal");
    expect(loggerMock.error).toHaveBeenCalledTimes(2);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("rejects invalid caller maxResults instead of reporting an internal failure", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }));
    await expect(
      recallHindsightMemoriesSafely({ config: ENABLED_CONFIG, query: "q", maxResults: -1 }),
    ).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it("reports the raw provider count as fetched", async () => {
    stubFetch(async () =>
      jsonResponse({
        results: [
          { id: "h1", text: "one" },
          { id: "h1", text: "dup" },
          { id: "h2", text: "two" },
        ],
      }),
    );
    const outcome = await recallHindsightMemoriesSafely({
      config: { ...ENABLED_CONFIG, maxResults: 1 },
      query: "q",
    });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.fetched).toBe(3);
  });

  it("rethrows caller cancellation without logging", async () => {
    stubHangingFetch();
    const controller = new AbortController();
    const pending = recallHindsightMemoriesSafely({
      config: ENABLED_CONFIG,
      query: "q",
      cancellation: { callerSignal: controller.signal },
    });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});

describe("warnHindsightFailureThrottled", () => {
  beforeEach(() => {
    hindsightTesting.resetHindsightWarningThrottle();
    loggerMock.warn.mockClear();
  });

  const timeout = new HindsightError("timeout", "slow");

  it("logs at most once per minute per operation and endpoint", () => {
    const start = 1_000_000;
    const warn = (now: number, operation: "recall" | "get" = "recall", bank = "openclaw") =>
      warnHindsightFailureThrottled({
        operation,
        config: { ...ENABLED_CONFIG, bank },
        error: timeout,
        now,
      });
    expect(warn(start)).toBe(true);
    expect(warn(start + 30_000)).toBe(false);
    expect(warn(start + 30_000, "get")).toBe(true);
    expect(warn(start + 30_000, "recall", "other-bank")).toBe(true);
    expect(warn(start + 60_000)).toBe(true);
    expect(loggerMock.warn).toHaveBeenCalledTimes(4);
  });

  it("does not collide keys whose parts contain the delimiter", () => {
    const now = 1_000_000;
    const warn = (baseUrl: string, bank: string) =>
      warnHindsightFailureThrottled({
        operation: "recall",
        config: { ...ENABLED_CONFIG, baseUrl, bank },
        error: timeout,
        now,
      });
    expect(warn("http://a:1", "b:c")).toBe(true);
    expect(warn("http://a", "1:b:c")).toBe(true);
  });

  it("logs again when the clock goes backwards", () => {
    const warn = (now: number) =>
      warnHindsightFailureThrottled({
        operation: "recall",
        config: ENABLED_CONFIG,
        error: timeout,
        now,
      });
    expect(warn(1_000_000)).toBe(true);
    expect(warn(500_000)).toBe(true);
  });

  it("keeps the throttle map bounded", () => {
    const now = 5_000_000;
    for (let index = 0; index < 200; index += 1) {
      warnHindsightFailureThrottled({
        operation: "recall",
        config: { ...ENABLED_CONFIG, bank: `bank-${index}` },
        error: timeout,
        now,
      });
    }
    expect(loggerMock.warn).toHaveBeenCalledTimes(200);
    expect(
      warnHindsightFailureThrottled({
        operation: "recall",
        config: { ...ENABLED_CONFIG, bank: "bank-199" },
        error: timeout,
        now: now + 1,
      }),
    ).toBe(false);
  });

  it("uses operation-specific wording", () => {
    warnHindsightFailureThrottled({ operation: "get", config: ENABLED_CONFIG, error: timeout });
    expect(loggerMock.warn.mock.calls[0]?.[0]).toContain("memory_get cannot read");
  });

  it("never logs not_found", () => {
    const logged = warnHindsightFailureThrottled({
      operation: "get",
      config: ENABLED_CONFIG,
      error: new HindsightError("not_found", "nope"),
    });
    expect(logged).toBe(false);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});

describe("readHindsightMemory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const RAW_TEXT = "  ```ts\nconst x = 1;\n```\n\n";

  it("fetches a memory by id and returns its text byte-for-byte", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ id: "h1", text: RAW_TEXT, type: "world", date: "2026-08-06T13:06:00+00:00" }),
    );

    const result = await readHindsightMemory({ config: ENABLED_CONFIG, id: "h1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8888/v1/default/banks/openclaw/memories/h1");
    expect(init.method).toBe("GET");
    expect(result).toEqual({
      path: "hindsight:h1",
      id: "h1",
      source: "hindsight",
      text: RAW_TEXT,
      kind: "world",
      date: "2026-08-06T13:06:00+00:00",
    });
  });

  it("encodes ids in the request path", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ id: "a b/c", text: "x" }));
    await readHindsightMemory({ config: ENABLED_CONFIG, id: "a b/c" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8888/v1/default/banks/openclaw/memories/a%20b%2Fc",
    );
  });

  it("classifies a missing memory as not_found", async () => {
    stubFetch(async () => jsonResponse({ detail: "Memory unit 'missing' not found" }, 404));
    const error = await expectHindsightError(
      readHindsightMemory({ config: ENABLED_CONFIG, id: "missing" }),
      "not_found",
    );
    expect(error.message).toContain("Memory unit 'missing' not found");
  });

  it("rejects a response whose id does not match the request", async () => {
    stubFetch(async () => jsonResponse({ id: "other", text: "wrong memory" }));
    await expectHindsightError(
      readHindsightMemory({ config: ENABLED_CONFIG, id: "h1" }),
      "id_mismatch",
    );
  });

  it.each([
    ["no id", { text: "orphan" }],
    ["a blank id", { id: "   ", text: "orphan" }],
  ])("rejects a response with %s as parse_error", async (_label, body) => {
    stubFetch(async () => jsonResponse(body));
    await expectHindsightError(
      readHindsightMemory({ config: ENABLED_CONFIG, id: "h1" }),
      "parse_error",
    );
  });

  it("propagates caller cancellation", async () => {
    stubHangingFetch();
    const controller = new AbortController();
    const pending = readHindsightMemory({
      config: ENABLED_CONFIG,
      id: "h1",
      callerSignal: controller.signal,
    });
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("rejects a response without text as parse_error", async () => {
    stubFetch(async () => jsonResponse({ id: "h1", text: "   " }));
    await expectHindsightError(
      readHindsightMemory({ config: ENABLED_CONFIG, id: "h1" }),
      "parse_error",
    );
  });
});

describe("memory-core manifest hindsight schema", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
  ) as {
    configSchema: JsonSchemaObject;
    uiHints: Record<string, { label?: string; help?: string }>;
  };

  it("carries a labelled ui hint for every hindsight key", () => {
    for (const key of Object.keys(DEFAULT_HINDSIGHT_CONFIG)) {
      const hint = manifest.uiHints[`hindsight.${key}`];
      expect(hint?.label, key).toBeTruthy();
      expect(hint?.help, key).toBeTruthy();
    }
  });

  it("accepts every hindsight key and matches the runtime defaults", () => {
    const { enabled: _enabled, ...defaults } = DEFAULT_HINDSIGHT_CONFIG;
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-core.manifest.hindsight",
      value: { hindsight: { enabled: true, ...defaults } },
    });
    expect(result.ok).toBe(true);
    const properties = (
      manifest.configSchema.properties as {
        hindsight: { properties: Record<string, { default?: unknown }> };
      }
    ).hindsight.properties;
    expect(
      Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value.default])),
    ).toEqual(DEFAULT_HINDSIGHT_CONFIG);
  });

  it("rejects unknown hindsight keys", () => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-core.manifest.hindsight-unknown",
      value: { hindsight: { enabled: true, bogus: 1 } },
    });
    expect(result.ok).toBe(false);
  });
});
