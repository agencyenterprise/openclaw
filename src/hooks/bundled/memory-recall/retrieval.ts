// Runs Hindsight recall and the markdown memory search in parallel under one
// enforced deadline and merges the hits. A source that fails or times out is
// reported; the other source's hits are still returned (partial success).
import {
  HINDSIGHT_SOURCE,
  mergeHindsightSearchResults,
  type HindsightRecallOutcome,
  type HindsightSearchResult,
} from "../../../../extensions/memory-core/src/hindsight.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { MemorySearchResult } from "../../../plugin-sdk/memory-core-host-engine-storage.js";

export type RetrievalSource = "hindsight" | "markdown";

export type RetrievedItem = {
  source: "hindsight" | "memory";
  date?: string;
  text: string;
  ref: string;
};

export type RetrievalOutcome = {
  items: RetrievedItem[];
  hindsightHits: number;
  markdownHits: number;
  ms: number;
  failedSources: RetrievalSource[];
  error?: string;
};

export type MemoryRetrievers = {
  recallHindsight: (query: string, signal: AbortSignal) => Promise<HindsightRecallOutcome>;
  searchMarkdown: (query: string, signal: AbortSignal) => Promise<MemorySearchResult[]>;
};

type SourceResult<T> = { value: T } | { failure: string };

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;
const MEMORY_DIR_PREFIX = "memory/";

function toSingleLine(value: string): string {
  return value.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

function normalizeDate(value: string | undefined): string | undefined {
  return value ? toSingleLine(value).match(DATE_PREFIX_RE)?.[0] : undefined;
}

/**
 * A `.md` file strictly under `memory/` (the specified `memory/<file>#L<n>` ref form)
 * with no empty, `.` or `..` segments and none of the characters that would make
 * `path#L<n>` ambiguous. Root `MEMORY.md` hits are counted but not injected.
 */
export function isInjectableMemoryPath(path: string): boolean {
  if (!path.startsWith(MEMORY_DIR_PREFIX) || !path.endsWith(".md") || /[\\#\s]/.test(path)) {
    return false;
  }
  const segments = path.slice(MEMORY_DIR_PREFIX.length).split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".." && segment !== ".md",
  );
}

function isInjectableMarkdown(result: MemorySearchResult): boolean {
  return (
    isInjectableMemoryPath(toSingleLine(result.path)) &&
    Number.isInteger(result.startLine) &&
    result.startLine >= 1 &&
    toSingleLine(result.snippet).length > 0
  );
}

function isInjectableHindsight(result: HindsightSearchResult): boolean {
  return toSingleLine(result.id).length > 0 && toSingleLine(result.snippet).length > 0;
}

function isHindsightResult(
  result: MemorySearchResult | HindsightSearchResult,
): result is HindsightSearchResult {
  return result.source === HINDSIGHT_SOURCE;
}

function toRetrievedItem(result: MemorySearchResult | HindsightSearchResult): RetrievedItem {
  if (isHindsightResult(result)) {
    const date = normalizeDate(result.date);
    return {
      source: "hindsight",
      ...(date ? { date } : {}),
      text: result.snippet,
      ref: `hindsight:${toSingleLine(result.id)}`,
    };
  }
  const path = toSingleLine(result.path);
  const date = normalizeDate(path.match(/\d{4}-\d{2}-\d{2}/)?.[0]);
  return {
    source: "memory",
    ...(date ? { date } : {}),
    text: result.snippet,
    ref: `${path}#L${result.startLine}`,
  };
}

/** Start a retriever so that a synchronous throw becomes a rejection like any other failure. */
function start<T>(retriever: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(retriever);
}

/**
 * Await both sources for at most `timeoutMs`. Whatever has not settled by then
 * is aborted and reported as a failure; settled results are kept.
 */
async function settleUnderDeadline<H, M>(
  run: (signal: AbortSignal) => { hindsight: Promise<H>; markdown: Promise<M> },
  timeoutMs: number,
): Promise<{ hindsight: SourceResult<H>; markdown: SourceResult<M> }> {
  const controller = new AbortController();
  let hindsight: SourceResult<H> | undefined;
  let markdown: SourceResult<M> | undefined;
  const started = run(controller.signal);
  const settled = Promise.all([
    started.hindsight.then(
      (value) => (hindsight = { value }),
      (reason: unknown) => (hindsight = { failure: formatErrorMessage(reason) }),
    ),
    started.markdown.then(
      (value) => (markdown = { value }),
      (reason: unknown) => (markdown = { failure: formatErrorMessage(reason) }),
    ),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    if ((await Promise.race([settled, deadline])) === "timeout") {
      controller.abort();
    }
  } finally {
    clearTimeout(timer);
  }
  const timedOut = { failure: `timed out after ${timeoutMs}ms` };
  return { hindsight: hindsight ?? timedOut, markdown: markdown ?? timedOut };
}

function describeFailure(
  source: RetrievalSource,
  result: SourceResult<unknown>,
): string | undefined {
  return "failure" in result ? `${source}: ${result.failure}` : undefined;
}

export async function retrieveMemory(params: {
  query: string;
  maxItems: number;
  timeoutMs: number;
  retrievers: MemoryRetrievers;
}): Promise<RetrievalOutcome> {
  const startedAt = Date.now();
  const { retrievers, query } = params;
  const { hindsight, markdown } = await settleUnderDeadline(
    (signal) => ({
      hindsight: start(() => retrievers.recallHindsight(query, signal)),
      markdown: start(() => retrievers.searchMarkdown(query, signal)),
    }),
    params.timeoutMs,
  );
  const hindsightResults = "value" in hindsight ? hindsight.value.results : [];
  const markdownResults = "value" in markdown ? markdown.value : [];
  const failures: Array<[RetrievalSource, string]> = [];
  const hindsightFailure =
    describeFailure("hindsight", hindsight) ??
    ("value" in hindsight && hindsight.value.error
      ? `hindsight: ${hindsight.value.error}`
      : undefined);
  if (hindsightFailure) {
    failures.push(["hindsight", hindsightFailure]);
  }
  const markdownFailure = describeFailure("markdown", markdown);
  if (markdownFailure) {
    failures.push(["markdown", markdownFailure]);
  }
  // Drop uninjectable hits before ranking so they cannot occupy a merge slot.
  const merged = mergeHindsightSearchResults({
    markdownResults: markdownResults.filter(isInjectableMarkdown),
    hindsightResults: hindsightResults.filter(isInjectableHindsight),
    maxResults: params.maxItems,
  });
  return {
    items: merged.map(toRetrievedItem),
    hindsightHits: hindsightResults.length,
    markdownHits: markdownResults.length,
    ms: Date.now() - startedAt,
    failedSources: failures.map(([source]) => source),
    ...(failures.length > 0 ? { error: failures.map(([, message]) => message).join("; ") } : {}),
  };
}
