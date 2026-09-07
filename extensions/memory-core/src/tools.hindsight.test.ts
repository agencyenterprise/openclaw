// Memory Core tests cover Hindsight merging inside the memory tools.
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as hindsightTesting } from "./hindsight.js";
import {
  getMemorySearchManagerMockCalls,
  resetMemoryToolMockState,
  setMemoryCustomStatus,
  setMemorySearchImpl,
  setMemorySearchManagerImpl,
} from "./memory-tool-manager.test-mocks.js";
import { testing as memoryToolsTesting } from "./tools.js";
import {
  asOpenClawConfig,
  createDefaultMemoryToolConfig,
  createMemoryGetToolOrThrow,
  createMemorySearchToolOrThrow,
} from "./tools.test-helpers.js";

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

type SearchDetails = {
  results: Array<{ path: string; source?: string; id?: string; snippet: string; date?: string }>;
  disabled?: boolean;
  sources: {
    markdown: { hits: number; error?: string; warning?: string; action?: string };
    hindsight: {
      enabled: boolean;
      hits: number;
      fetched?: number;
      ms?: number;
      error?: string;
      code?: string;
      abandoned?: true;
    };
  };
};

type GetDetails = {
  path: string;
  text: string;
  id?: string;
  source?: string;
  kind?: string;
  code?: string;
  error?: string;
  disabled?: boolean;
  notFound?: boolean;
  unavailable?: boolean;
};

const MARKDOWN_HITS = ["a.md", "b.md", "c.md", "d.md"].map((path, index) => ({
  path,
  startLine: 1,
  endLine: 2,
  score: 0.9 - index * 0.1,
  snippet: `markdown ${path}`,
  source: "memory" as const,
}));

const HINDSIGHT_ID = "27b68d76-a055-4cee-812d-31a22355b12a";

function createHindsightConfig(overrides?: Record<string, unknown>) {
  return asOpenClawConfig({
    agents: { list: [{ id: "main", default: true }] },
    plugins: {
      entries: {
        "memory-core": {
          config: { hindsight: { enabled: true, timeoutMs: 50, ...overrides } },
        },
      },
    },
  });
}

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

function stubRecallFetch(results: unknown[]) {
  return stubFetch(async () => jsonResponse({ results }));
}

function stubHangingFetch() {
  const signals: AbortSignal[] = [];
  const startedAt: number[] = [];
  const fetchMock = stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        startedAt.push(Date.now());
        if (init?.signal) {
          signals.push(init.signal);
          init.signal.addEventListener("abort", () => reject(init.signal?.reason));
        }
      }),
  );
  return { fetchMock, signals, startedAt };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Hold a promise we will assert on later without leaving its rejection unobserved meanwhile. */
function observe<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

function collectUnhandledRejections() {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  return {
    seen,
    stop: () => process.off("unhandledRejection", listener),
  };
}

async function search(
  config = createHindsightConfig(),
  params: Record<string, unknown> = { query: "gate windows" },
  signal?: AbortSignal,
): Promise<SearchDetails> {
  const result = await createMemorySearchToolOrThrow({ config }).execute("call", params, signal);
  return (result as { details: SearchDetails }).details;
}

async function get(path: string, config = createHindsightConfig()): Promise<GetDetails> {
  const result = await createMemoryGetToolOrThrow(config).execute("call", { path });
  return (result as { details: GetDetails }).details;
}

function paths(details: SearchDetails): string[] {
  return details.results.map((hit) => hit.path);
}

beforeEach(() => {
  clearMemoryPluginState();
  resetMemoryToolMockState({ searchImpl: async () => MARKDOWN_HITS });
  memoryToolsTesting.resetMemorySearchToolCooldowns();
  hindsightTesting.resetHindsightWarningThrottle();
  loggerMock.warn.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memory_search with Hindsight", () => {
  it("never calls Hindsight when the flag is off and reports it in sources", async () => {
    const fetchMock = stubRecallFetch([{ id: HINDSIGHT_ID, text: "should not appear" }]);

    const details = await search(createDefaultMemoryToolConfig());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(paths(details)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(details.sources).toEqual({
      markdown: { hits: 4 },
      hindsight: { enabled: false, hits: 0 },
    });
  });

  it("merges unscored Hindsight hits after the top three markdown hits", async () => {
    stubRecallFetch([
      { id: "h1", text: "lesson one", occurred_start: "2026-08-06T13:06:00+00:00" },
      { id: "h2", text: "lesson two" },
    ]);

    const details = await search();

    expect(paths(details)).toEqual([
      "a.md",
      "b.md",
      "c.md",
      "hindsight:h1",
      "hindsight:h2",
      "d.md",
    ]);
    expect(details.results[3]).toMatchObject({
      source: "hindsight",
      id: "h1",
      snippet: "lesson one",
      date: "2026-08-06T13:06:00+00:00",
    });
    expect(details.sources.markdown).toEqual({ hits: 4 });
    expect(details.sources.hindsight).toMatchObject({ enabled: true, hits: 2, fetched: 2 });
    expect(details.sources.hindsight.error).toBeUndefined();
  });

  it("never returns more than the caller's maxResults", async () => {
    stubRecallFetch([
      { id: "h1", text: "one" },
      { id: "h2", text: "two" },
      { id: "h3", text: "three" },
    ]);

    const details = await search(createHindsightConfig(), { query: "q", maxResults: 4 });

    expect(paths(details)).toEqual(["a.md", "b.md", "c.md", "hindsight:h1"]);
    expect(details.sources).toEqual({
      markdown: { hits: 3 },
      hindsight: { enabled: true, hits: 1, fetched: 3, ms: expect.any(Number) },
    });
  });

  it("reports fetched as the raw provider count, hits as returned", async () => {
    stubRecallFetch([
      { id: "h1", text: "one" },
      { id: "h1", text: "dup" },
      { id: "h2", text: "two" },
    ]);
    const details = await search(createHindsightConfig({ maxResults: 1 }), {
      query: "q",
      maxResults: 2,
    });
    expect(details.sources.hindsight).toMatchObject({ hits: 0, fetched: 3 });
    expect(paths(details)).toEqual(["a.md", "b.md"]);
  });

  it("keeps the markdown hit when maxResults is one", async () => {
    stubRecallFetch([{ id: "h1", text: "one" }]);
    const details = await search(createHindsightConfig(), { query: "q", maxResults: 1 });
    expect(paths(details)).toEqual(["a.md"]);
  });

  it("caps the Hindsight stream by the smaller of config and caller limits", async () => {
    stubRecallFetch([
      { id: "h1", text: "one" },
      { id: "h2", text: "two" },
      { id: "h3", text: "three" },
    ]);
    resetMemoryToolMockState({ searchImpl: async () => [] });

    const details = await search(createHindsightConfig({ maxResults: 2 }), {
      query: "q",
      maxResults: 5,
    });

    expect(paths(details)).toEqual(["hindsight:h1", "hindsight:h2"]);
  });

  it("interleaves scored Hindsight hits through the tool", async () => {
    stubRecallFetch([{ id: "h1", text: "scored", relevance_score: 0.85 }]);
    const details = await search();
    expect(paths(details)).toEqual(["a.md", "hindsight:h1", "b.md", "c.md", "d.md"]);
  });

  it("falls back to markdown results and logs once when Hindsight times out", async () => {
    stubHangingFetch();

    const details = await search(createHindsightConfig({ timeoutMs: 20 }));

    expect(paths(details)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(details.sources.hindsight).toMatchObject({ enabled: true, hits: 0, code: "timeout" });
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed Hindsight response as a provider error", async () => {
    stubFetch(async () => jsonResponse({ results: null }));
    const details = await search();
    expect(paths(details)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(details.sources.hindsight.code).toBe("parse_error");
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("returns Hindsight hits with the markdown error when the markdown search throws", async () => {
    stubRecallFetch([{ id: "h1", text: "still here" }]);
    setMemorySearchImpl(async () => {
      throw new Error("sqlite exploded");
    });

    const details = await search();

    expect(paths(details)).toEqual(["hindsight:h1"]);
    expect(details.disabled).toBeUndefined();
    expect(details.sources.markdown).toMatchObject({ hits: 0, error: "sqlite exploded" });
    expect(details.sources.markdown.warning).toBeTruthy();
    expect(details.sources.markdown.action).toBeTruthy();
    expect(details.sources.hindsight).toMatchObject({ hits: 1 });
  });

  it("keeps the unavailable payload when both backends fail", async () => {
    stubFetch(async () => jsonResponse({ detail: "down" }, 503));
    setMemorySearchImpl(async () => {
      throw new Error("sqlite exploded");
    });

    const details = await search();

    expect(details).toMatchObject({
      results: [],
      disabled: true,
      error: "sqlite exploded",
      sources: {
        markdown: { hits: 0, error: "sqlite exploded" },
        hindsight: { hits: 0, code: "http_503" },
      },
    });
  });

  it("serves Hindsight hits while the markdown backend is on cooldown", async () => {
    stubRecallFetch([{ id: "h1", text: "during cooldown" }]);
    setMemorySearchImpl(async () => {
      throw new Error("first failure");
    });
    await search();
    setMemorySearchImpl(async () => MARKDOWN_HITS);

    const details = await search();

    expect(paths(details)).toEqual(["hindsight:h1"]);
    expect(details.sources.markdown.error).toBe("first failure");
  });

  it("waits for a slow Hindsight when the markdown search fails, then reports the timeout", async () => {
    const { signals } = stubHangingFetch();
    setMemorySearchImpl(async () => {
      throw new Error("markdown broke");
    });

    const details = await search(createHindsightConfig({ timeoutMs: 20 }));

    expect(details.sources.hindsight).toMatchObject({ hits: 0, code: "timeout" });
    expect(signals[0]?.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("returns Hindsight hits when the memory manager cannot be created", async () => {
    stubRecallFetch([{ id: "h1", text: "manager down" }]);
    setMemorySearchManagerImpl(async () => ({ error: "embedding provider down" }));

    const details = await search();

    expect(paths(details)).toEqual(["hindsight:h1"]);
    expect(details.sources.markdown).toMatchObject({ hits: 0, error: "embedding provider down" });
  });

  it("returns Hindsight hits when the markdown index is paused", async () => {
    stubRecallFetch([{ id: "h1", text: "paused index" }]);
    setMemoryCustomStatus({ indexIdentity: { status: "mismatched", reason: "provider changed" } });

    const details = await search();

    expect(paths(details)).toEqual(["hindsight:h1"]);
    expect(details.sources.markdown).toMatchObject({
      hits: 0,
      error: "provider changed",
      warning: expect.stringContaining("paused"),
    });
  });

  it("abandons a pending Hindsight recall at once when a non-markdown backend fails", async () => {
    const { signals, startedAt } = stubHangingFetch();
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => {
        throw new Error("wiki exploded");
      },
      get: async () => null,
    });

    const details = await search(createHindsightConfig({ timeoutMs: 5_000 }), {
      query: "q",
      corpus: "all",
    });

    expect(Date.now() - (startedAt[0] ?? 0)).toBeLessThan(2_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).not.toMatchObject({ name: "TimeoutError" });
    expect(details).toMatchObject({ disabled: true, error: "wiki exploded" });
    expect(details.sources.hindsight).toMatchObject({ hits: 0, abandoned: true });
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("uses already-fetched Hindsight hits when a non-markdown backend fails", async () => {
    stubRecallFetch([{ id: "h1", text: "already here" }]);
    const wiki = deferred<never>();
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => await wiki.promise,
      get: async () => null,
    });

    const pending = search(createHindsightConfig(), { query: "q", corpus: "all" });
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    wiki.reject(new Error("wiki exploded"));

    const details = await pending;
    expect(paths(details)).toEqual(["hindsight:h1"]);
    expect(details.sources.markdown.error).toBe("wiki exploded");
  });

  it("propagates caller cancellation instead of returning a markdown fallback", async () => {
    const { signals } = stubHangingFetch();
    const controller = new AbortController();
    setMemorySearchImpl(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("search aborted")));
        }),
    );

    const pending = search(
      createHindsightConfig({ timeoutMs: 5_000 }),
      { query: "q" },
      controller.signal,
    );
    controller.abort(new Error("caller cancelled"));

    await expect(pending).rejects.toThrow("caller cancelled");
    expect(signals[0]?.aborted).toBe(true);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("still rejects on caller cancellation when Hindsight already fulfilled, without a cooldown", async () => {
    const unhandled = collectUnhandledRejections();
    try {
      stubRecallFetch([{ id: "h1", text: "fast" }]);
      const controller = new AbortController();
      const markdown = deferred<typeof MARKDOWN_HITS>();
      setMemorySearchImpl(async () => await markdown.promise);

      const pending = observe(search(createHindsightConfig(), { query: "q" }, controller.signal));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      controller.abort(new Error("late cancel"));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      markdown.resolve(MARKDOWN_HITS);

      await expect(pending).rejects.toThrow("late cancel");

      const managerCallsBefore = getMemorySearchManagerMockCalls();
      const next = await search(createHindsightConfig(), { query: "q" });
      expect(getMemorySearchManagerMockCalls()).toBe(managerCallsBefore + 1);
      expect(next.disabled).toBeUndefined();
      expect(paths(next)).toContain("a.md");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it("does not leave an unhandled rejection when cancelled while markdown is slow", async () => {
    const unhandled = collectUnhandledRejections();
    try {
      stubHangingFetch();
      const controller = new AbortController();
      const markdown = deferred<typeof MARKDOWN_HITS>();
      setMemorySearchImpl(async () => await markdown.promise);

      const pending = observe(
        search(createHindsightConfig({ timeoutMs: 5_000 }), { query: "q" }, controller.signal),
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      controller.abort(new Error("cancelled"));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      markdown.reject(new Error("search aborted"));

      await expect(pending).rejects.toThrow("cancelled");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it("skips Hindsight for the sessions corpus", async () => {
    const fetchMock = stubRecallFetch([{ id: "h1", text: "lesson one" }]);
    const details = await search(createHindsightConfig(), { query: "q", corpus: "sessions" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(details.sources.hindsight).toEqual({ enabled: true, hits: 0 });
  });
});

describe("memory_get with Hindsight", () => {
  const RAW_TEXT = "  indented\n\ntrailing newline\n";

  it("round-trips a Hindsight id from memory_search into memory_get with exact text", async () => {
    const fetchMock = stubFetch(async (url) => {
      if (String(url).endsWith("/memories/recall")) {
        return jsonResponse({ results: [{ id: HINDSIGHT_ID, text: "short snippet" }] });
      }
      return jsonResponse({ id: HINDSIGHT_ID, text: RAW_TEXT, type: "world" });
    });

    const searchDetails = await search();
    const hindsightHit = searchDetails.results.find((hit) => hit.source === "hindsight");
    expect(hindsightHit?.path).toBe(`hindsight:${HINDSIGHT_ID}`);

    const details = await get(hindsightHit?.path ?? "");

    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      `http://127.0.0.1:8888/v1/default/banks/openclaw/memories/${HINDSIGHT_ID}`,
    );
    expect(details).toEqual({
      path: `hindsight:${HINDSIGHT_ID}`,
      id: HINDSIGHT_ID,
      source: "hindsight",
      text: RAW_TEXT,
      kind: "world",
    });
  });

  it("reports not_found without logging", async () => {
    stubFetch(async () => jsonResponse({ detail: "Memory unit 'missing' not found" }, 404));
    const details = await get("hindsight:missing");
    expect(details).toMatchObject({
      path: "hindsight:missing",
      text: "",
      code: "not_found",
      notFound: true,
      error: expect.stringContaining("Memory unit 'missing' not found"),
    });
    expect(details.disabled).toBeUndefined();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", () => stubHangingFetch(), "timeout"],
    ["http_500", () => stubFetch(async () => jsonResponse({ detail: "boom" }, 500)), "http_500"],
    [
      "parse_error",
      () => stubFetch(async () => new Response("nope", { status: 200 })),
      "parse_error",
    ],
    [
      "id_mismatch",
      () => stubFetch(async () => jsonResponse({ id: "other", text: "wrong" })),
      "id_mismatch",
    ],
    ["missing id", () => stubFetch(async () => jsonResponse({ text: "no id" })), "parse_error"],
  ])("reports %s as unavailable and logs a warning", async (_label, arrange, code) => {
    arrange();
    const details = await get("hindsight:h1", createHindsightConfig({ timeoutMs: 20 }));
    expect(details).toMatchObject({ path: "hindsight:h1", text: "", code, unavailable: true });
    expect(details.disabled).toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("propagates caller cancellation from memory_get", async () => {
    stubHangingFetch();
    const controller = new AbortController();
    const pending = createMemoryGetToolOrThrow(createHindsightConfig({ timeoutMs: 5_000 })).execute(
      "get",
      { path: "hindsight:h1" },
      controller.signal,
    );
    controller.abort(new Error("get cancelled"));
    await expect(pending).rejects.toThrow("get cancelled");
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it.each(["hindsight:", "hindsight:   "])("rejects the blank Hindsight path %j", async (path) => {
    const fetchMock = stubFetch(async () => jsonResponse({}));
    const details = await get(path);
    expect(fetchMock).not.toHaveBeenCalled();
    // The tool trims the path argument before echoing it back.
    expect(details).toMatchObject({
      path: path.trim(),
      text: "",
      code: "parse_error",
      unavailable: true,
    });
  });

  it("refuses Hindsight reads when the flag is off", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}));
    const details = await get("hindsight:anything", createDefaultMemoryToolConfig());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(details).toMatchObject({ disabled: true, code: "disabled" });
  });
});
