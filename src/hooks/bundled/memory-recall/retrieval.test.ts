import { afterEach, describe, expect, it, vi } from "vitest";
import type { HindsightSearchResult } from "../../../../extensions/memory-core/src/hindsight.js";
import type { MemorySearchResult } from "../../../plugin-sdk/memory-core-host-engine-storage.js";
import { isInjectableMemoryPath, retrieveMemory, type MemoryRetrievers } from "./retrieval.js";

function hindsightHit(
  id: string,
  overrides: Partial<HindsightSearchResult> = {},
): HindsightSearchResult {
  return {
    corpus: "hindsight",
    source: "hindsight",
    id,
    path: `hindsight:${id}`,
    score: 0.9,
    snippet: `hindsight ${id}`,
    date: "2026-07-30",
    ...overrides,
  };
}

function markdownHit(path: string, startLine: number, score = 0.8): MemorySearchResult {
  return {
    path,
    startLine,
    endLine: startLine + 2,
    score,
    snippet: `markdown ${path}`,
    source: "memory",
  };
}

function retrievers(overrides: Partial<MemoryRetrievers> = {}): MemoryRetrievers {
  return {
    recallHindsight: async () => ({ results: [hindsightHit("h1")], fetched: 1, ms: 5 }),
    searchMarkdown: async () => [markdownHit("memory/2026-08-01.md", 12)],
    ...overrides,
  };
}

const BASE = { query: "q", maxItems: 6, timeoutMs: 1000 };

afterEach(() => {
  vi.useRealTimers();
});

describe("isInjectableMemoryPath", () => {
  it("accepts .md files strictly under memory/", () => {
    expect(isInjectableMemoryPath("memory/2026-08-01.md")).toBe(true);
    expect(isInjectableMemoryPath("memory/people/flavio.md")).toBe(true);
  });

  it("rejects traversal, empty segments, other trees and non-markdown files", () => {
    for (const path of [
      "MEMORY.md",
      "memory/../secrets.md",
      "memory/a/../../outside.md",
      "memory//notes.md",
      "memory/./notes.md",
      "memory/.md",
      "memory\\notes.md",
      "sessions/2026-08-01.jsonl",
      "memory/notes.txt",
      "/memory/notes.md",
      "memory/notes#L3.md",
      "memory/my notes.md",
      "",
    ]) {
      expect(isInjectableMemoryPath(path), path).toBe(false);
    }
  });
});

describe("retrieveMemory", () => {
  it("merges both sources into refs the model can follow", async () => {
    const outcome = await retrieveMemory({ ...BASE, retrievers: retrievers() });
    expect(outcome).toMatchObject({ hindsightHits: 1, markdownHits: 1, failedSources: [] });
    expect(outcome.error).toBeUndefined();
    expect(outcome.items).toEqual([
      { source: "hindsight", date: "2026-07-30", text: "hindsight h1", ref: "hindsight:h1" },
      {
        source: "memory",
        date: "2026-08-01",
        text: "markdown memory/2026-08-01.md",
        ref: "memory/2026-08-01.md#L12",
      },
    ]);
  });

  it("builds the Hindsight ref from the id and trims the date to a day", async () => {
    const outcome = await retrieveMemory({
      ...BASE,
      retrievers: retrievers({
        recallHindsight: async () => ({
          results: [
            hindsightHit("h9", { path: "hindsight:tampered", date: "2026-07-30T12:00:00Z" }),
          ],
          fetched: 1,
          ms: 1,
        }),
        searchMarkdown: async () => [],
      }),
    });
    expect(outcome.items).toEqual([
      { source: "hindsight", date: "2026-07-30", text: "hindsight h9", ref: "hindsight:h9" },
    ]);
  });

  it("drops Hindsight hits with an empty id or snippet", async () => {
    const outcome = await retrieveMemory({
      ...BASE,
      retrievers: retrievers({
        recallHindsight: async () => ({
          results: [
            hindsightHit(" \n", { snippet: "text" }),
            hindsightHit("ok", { snippet: "  " }),
            hindsightHit("kept"),
          ],
          fetched: 3,
          ms: 1,
        }),
        searchMarkdown: async () => [],
      }),
    });
    expect(outcome.hindsightHits).toBe(3);
    expect(outcome.items.map((item) => item.ref)).toEqual(["hindsight:kept"]);
  });

  it("only turns valid memory/*.md hits with positive line numbers into refs", async () => {
    const outcome = await retrieveMemory({
      ...BASE,
      retrievers: retrievers({
        recallHindsight: async () => ({ results: [], fetched: 0, ms: 1 }),
        searchMarkdown: async () => [
          markdownHit("MEMORY.md", 1),
          markdownHit("sessions/2026-08-01-abc.jsonl", 3),
          markdownHit("memory/../secrets.md", 2),
          markdownHit("memory/zero.md", 0),
          markdownHit("memory/nan.md", Number.NaN),
          markdownHit("memory/notes.md", 5),
        ],
      }),
    });
    expect(outcome.markdownHits).toBe(6);
    expect(outcome.items.map((item) => item.ref)).toEqual(["memory/notes.md#L5"]);
  });

  it("does not let an uninjectable hit take a merge slot from a valid one", async () => {
    const outcome = await retrieveMemory({
      ...BASE,
      maxItems: 1,
      retrievers: retrievers({
        recallHindsight: async () => ({
          results: [hindsightHit("valid", { score: 0.5 })],
          fetched: 1,
          ms: 1,
        }),
        searchMarkdown: async () => [markdownHit("sessions/top-ranked.jsonl", 1, 0.99)],
      }),
    });
    expect(outcome.items.map((item) => item.ref)).toEqual(["hindsight:valid"]);
  });

  it("caps merged items at maxItems", async () => {
    const outcome = await retrieveMemory({
      ...BASE,
      maxItems: 2,
      retrievers: retrievers({
        recallHindsight: async () => ({
          results: [hindsightHit("a"), hindsightHit("b")],
          fetched: 2,
          ms: 1,
        }),
        searchMarkdown: async () => [markdownHit("memory/a.md", 1), markdownHit("memory/x.md", 3)],
      }),
    });
    expect(outcome.items).toHaveLength(2);
    expect(outcome).toMatchObject({ hindsightHits: 2, markdownHits: 2 });
  });

  it("keeps the other source's hits when one retriever fails, and names the failed source", async () => {
    const outcome = await retrieveMemory({
      ...BASE,
      retrievers: retrievers({
        searchMarkdown: async () => {
          throw new Error("index locked");
        },
      }),
    });
    expect(outcome.items.map((item) => item.ref)).toEqual(["hindsight:h1"]);
    expect(outcome).toMatchObject({
      markdownHits: 0,
      failedSources: ["markdown"],
      error: "markdown: index locked",
    });
  });

  it("treats a synchronous throw like any other failure and still runs the other source", async () => {
    const outcome = await retrieveMemory({
      ...BASE,
      retrievers: retrievers({
        recallHindsight: () => {
          throw new Error("sync boom");
        },
      }),
    });
    expect(outcome.items.map((item) => item.ref)).toEqual(["memory/2026-08-01.md#L12"]);
    expect(outcome).toMatchObject({ failedSources: ["hindsight"], error: "hindsight: sync boom" });
  });

  it("surfaces a soft Hindsight failure from the safe recall outcome", async () => {
    const outcome = await retrieveMemory({
      ...BASE,
      retrievers: retrievers({
        recallHindsight: async () => ({
          results: [],
          fetched: 0,
          ms: 3,
          error: "timed out",
          code: "timeout",
        }),
      }),
    });
    expect(outcome.items.map((item) => item.ref)).toEqual(["memory/2026-08-01.md#L12"]);
    expect(outcome).toMatchObject({ failedSources: ["hindsight"], error: "hindsight: timed out" });
  });

  it("reports both sources when both fail and returns no items", async () => {
    const outcome = await retrieveMemory({
      ...BASE,
      retrievers: {
        recallHindsight: async () => {
          throw new Error("down");
        },
        searchMarkdown: async () => {
          throw new Error("locked");
        },
      },
    });
    expect(outcome.items).toEqual([]);
    expect(outcome).toMatchObject({
      failedSources: ["hindsight", "markdown"],
      error: "hindsight: down; markdown: locked",
    });
  });

  it("runs both retrievers in parallel under one abort signal", async () => {
    vi.useFakeTimers();
    const seen: AbortSignal[] = [];
    const started: string[] = [];
    const pending = retrieveMemory({
      ...BASE,
      retrievers: {
        recallHindsight: async (_query, signal) => {
          started.push("hindsight");
          seen.push(signal);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
          });
          return { results: [], fetched: 0, ms: 20 };
        },
        searchMarkdown: async (_query, signal) => {
          started.push("markdown");
          seen.push(signal);
          return [];
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["hindsight", "markdown"]);
    await vi.advanceTimersByTimeAsync(20);
    const outcome = await pending;
    expect(seen[0]).toBe(seen[1]);
    expect(outcome.failedSources).toEqual([]);
  });

  it("enforces timeoutMs even when a retriever ignores the abort signal, and aborts it", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const promise = retrieveMemory({
      ...BASE,
      timeoutMs: 3000,
      retrievers: {
        recallHindsight: async () => ({ results: [hindsightHit("fast")], fetched: 1, ms: 1 }),
        searchMarkdown: (_query, signal) =>
          new Promise<MemorySearchResult[]>(() => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      },
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;
    expect(aborted).toBe(true);
    expect(outcome.items.map((item) => item.ref)).toEqual(["hindsight:fast"]);
    expect(outcome).toMatchObject({
      failedSources: ["markdown"],
      error: "markdown: timed out after 3000ms",
    });
  });
});
