// Memory Core plugin module implements Hindsight long-term memory recall.
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemoryCorpusSearchResult,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryCorePluginConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { asRecord, normalizeTrimmedString } from "./dreaming-shared.js";
import { mergeRankedStreamsByScore } from "./search-merge.js";

export const HINDSIGHT_SOURCE = "hindsight";
export const HINDSIGHT_PATH_PREFIX = "hindsight:";

const HINDSIGHT_BUDGETS = ["low", "mid", "high"] as const;
const HINDSIGHT_RECALL_TYPES = ["world", "experience", "observation"];
const HINDSIGHT_RECALL_MAX_TOKENS = 4096;
const HINDSIGHT_WARNING_INTERVAL_MS = 60_000;
const HINDSIGHT_WARNING_MAX_KEYS = 64;
const MARKDOWN_HITS_BEFORE_UNSCORED_HINDSIGHT = 3;
const MARKDOWN_HITS_RESERVED_UNDER_CAP = 3;
const HINDSIGHT_HITS_RESERVED_UNDER_CAP = 1;

export type HindsightBudget = (typeof HINDSIGHT_BUDGETS)[number];

export type HindsightConfig = {
  enabled: boolean;
  baseUrl: string;
  bank: string;
  budget: HindsightBudget;
  timeoutMs: number;
  maxResults: number;
};

export const DEFAULT_HINDSIGHT_CONFIG: HindsightConfig = {
  enabled: false,
  baseUrl: "http://127.0.0.1:8888",
  bank: "openclaw",
  budget: "mid",
  timeoutMs: 4000,
  maxResults: 8,
};

export type HindsightSearchResult = MemoryCorpusSearchResult & {
  corpus: typeof HINDSIGHT_SOURCE;
  source: typeof HINDSIGHT_SOURCE;
  id: string;
  date?: string;
};

export type HindsightMemoryReadResult = {
  path: string;
  id: string;
  source: typeof HINDSIGHT_SOURCE;
  text: string;
  kind?: string;
  date?: string;
};

export type HindsightOperation = "recall" | "get";

/**
 * Failure classes for Hindsight calls. `not_found` is a caller error (only a
 * GET for one memory can produce it) and is never logged as an outage;
 * every other class is a server-side or integration failure.
 */
export type HindsightFailureCode =
  | "timeout"
  | "unreachable"
  | "not_found"
  | "parse_error"
  | "id_mismatch"
  | "internal"
  | `http_${number}`;

export class HindsightError extends Error {
  constructor(
    readonly code: HindsightFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "HindsightError";
  }
}

/**
 * Outcome of a recall that never rejects on provider failure. `abandoned`
 * means the tool cancelled the request itself (not the caller).
 */
export type HindsightRecallOutcome = {
  results: HindsightSearchResult[];
  /** Raw provider result count before dedupe and capping. */
  fetched: number;
  ms: number;
  error?: string;
  code?: HindsightFailureCode;
  abandoned?: true;
};

/**
 * Two cancellation lanes: the caller's signal is propagated (rethrown) so
 * cancellation reaches the tool runner; the abandon signal is the tool's own
 * "stop, I no longer need this" and settles silently.
 */
export type HindsightCancellation = {
  callerSignal?: AbortSignal;
  abandonSignal?: AbortSignal;
};

const log = createSubsystemLogger("memory/hindsight");
const lastFailureWarningAtByKey = new Map<string, number>();

export const testing = {
  resetHindsightWarningThrottle() {
    lastFailureWarningAtByKey.clear();
  },
} as const;

function isHindsightBudget(value: unknown): value is HindsightBudget {
  return HINDSIGHT_BUDGETS.includes(value as HindsightBudget);
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function resolveHindsightConfig(cfg: OpenClawConfig): HindsightConfig {
  const raw = asRecord(resolveMemoryCorePluginConfig(cfg)?.hindsight);
  return {
    enabled: raw?.enabled === true,
    baseUrl: normalizeTrimmedString(raw?.baseUrl) ?? DEFAULT_HINDSIGHT_CONFIG.baseUrl,
    bank: normalizeTrimmedString(raw?.bank) ?? DEFAULT_HINDSIGHT_CONFIG.bank,
    budget: isHindsightBudget(raw?.budget) ? raw.budget : DEFAULT_HINDSIGHT_CONFIG.budget,
    timeoutMs: readPositiveInteger(raw?.timeoutMs) ?? DEFAULT_HINDSIGHT_CONFIG.timeoutMs,
    maxResults: readPositiveInteger(raw?.maxResults) ?? DEFAULT_HINDSIGHT_CONFIG.maxResults,
  };
}

export function buildHindsightPath(id: string): string {
  return `${HINDSIGHT_PATH_PREFIX}${id}`;
}

export function parseHindsightMemoryId(path: string): string | undefined {
  if (!path.startsWith(HINDSIGHT_PATH_PREFIX)) {
    return undefined;
  }
  return normalizeTrimmedString(path.slice(HINDSIGHT_PATH_PREFIX.length));
}

export function isHindsightSearchResult(result: unknown): result is HindsightSearchResult {
  return asRecord(result)?.source === HINDSIGHT_SOURCE;
}

function buildMemoriesUrl(config: HindsightConfig, suffix: string): string {
  const base = config.baseUrl.replace(/\/+$/, "");
  return `${base}/v1/default/banks/${encodeURIComponent(config.bank)}/memories${suffix}`;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancelled(cancellation: HindsightCancellation): boolean {
  return (
    cancellation.callerSignal?.aborted === true || cancellation.abandonSignal?.aborted === true
  );
}

function buildRequestSignal(
  config: HindsightConfig,
  cancellation: HindsightCancellation,
): AbortSignal {
  const signals = [AbortSignal.timeout(config.timeoutMs)];
  if (cancellation.callerSignal) {
    signals.push(cancellation.callerSignal);
  }
  if (cancellation.abandonSignal) {
    signals.push(cancellation.abandonSignal);
  }
  return AbortSignal.any(signals);
}

type HindsightRequestContext = {
  config: HindsightConfig;
  operation: HindsightOperation;
  url: string;
  cancellation: HindsightCancellation;
  /** The combined caller + abandon + timeout signal the request runs under. */
  signal: AbortSignal;
};

function buildTimeoutFailure(context: HindsightRequestContext): HindsightError {
  return new HindsightError(
    "timeout",
    `Hindsight ${context.operation} ${context.url} timed out after ${context.config.timeoutMs}ms`,
  );
}

/**
 * Consume a JSON body. Cancellation is rethrown; a body that never finishes
 * streaming is a timeout; anything else is handed to `onInvalidJson`.
 */
async function readJsonBody<T>(
  response: Response,
  context: HindsightRequestContext,
  onInvalidJson: (error: unknown) => T,
): Promise<unknown | T> {
  try {
    return await response.json();
  } catch (error) {
    if (isCancelled(context.cancellation)) {
      throw error;
    }
    if (context.signal.aborted && isTimeoutError(context.signal.reason)) {
      throw buildTimeoutFailure(context);
    }
    return onInvalidJson(error);
  }
}

async function readResponseDetail(
  response: Response,
  context: HindsightRequestContext,
): Promise<string | undefined> {
  const body = await readJsonBody(response, context, () => undefined);
  return normalizeTrimmedString(asRecord(body)?.detail);
}

async function throwHttpFailure(
  response: Response,
  context: HindsightRequestContext,
): Promise<never> {
  const { url, operation } = context;
  const detail = await readResponseDetail(response, context);
  const suffix = detail ? `: ${detail}` : "";
  // Only a GET for one memory can legitimately 404; a 404 from /recall is a
  // wrong bank or route and must surface as an integration failure.
  if (response.status === 404 && operation === "get") {
    throw new HindsightError("not_found", `Hindsight memory not found (${url})${suffix}`);
  }
  throw new HindsightError(
    `http_${response.status}`,
    `Hindsight ${operation} ${url} failed with HTTP ${response.status}${suffix}`,
  );
}

/**
 * Perform one Hindsight HTTP call. Cancellation from either lane is rethrown
 * untouched; every other failure becomes a classified HindsightError.
 */
async function requestHindsightJson(params: {
  config: HindsightConfig;
  operation: HindsightOperation;
  url: string;
  init: RequestInit;
  cancellation: HindsightCancellation;
}): Promise<unknown> {
  const context: HindsightRequestContext = {
    config: params.config,
    operation: params.operation,
    url: params.url,
    cancellation: params.cancellation,
    signal: buildRequestSignal(params.config, params.cancellation),
  };
  let response: Response;
  try {
    response = await fetch(params.url, { ...params.init, signal: context.signal });
  } catch (error) {
    if (isCancelled(params.cancellation)) {
      throw error;
    }
    if (isTimeoutError(error)) {
      throw buildTimeoutFailure(context);
    }
    throw new HindsightError(
      "unreachable",
      `Hindsight ${params.operation} ${params.url} unreachable: ${describeError(error)}`,
    );
  }
  if (!response.ok) {
    await throwHttpFailure(response, context);
  }
  return await readJsonBody(response, context, (error) => {
    throw new HindsightError(
      "parse_error",
      `Hindsight ${params.operation} ${params.url} returned invalid JSON: ${describeError(error)}`,
    );
  });
}

function resolveHindsightDate(record: Record<string, unknown>): string | undefined {
  return (
    normalizeTrimmedString(record.occurred_start) ??
    normalizeTrimmedString(record.mentioned_at) ??
    normalizeTrimmedString(record.date)
  );
}

function toHindsightSearchResult(raw: unknown, index: number): HindsightSearchResult {
  const record = asRecord(raw);
  const id = normalizeTrimmedString(record?.id);
  const text = normalizeTrimmedString(record?.text);
  if (!record || !id || !text) {
    throw new HindsightError(
      "parse_error",
      `Hindsight recall result #${index} is missing a string id or text`,
    );
  }
  const kind = normalizeTrimmedString(record.type);
  const date = resolveHindsightDate(record);
  return {
    corpus: HINDSIGHT_SOURCE,
    source: HINDSIGHT_SOURCE,
    id,
    path: buildHindsightPath(id),
    score: readFiniteNumber(record.relevance_score) ?? 0,
    snippet: text,
    ...(kind ? { kind } : {}),
    ...(date ? { date } : {}),
  };
}

function parseRecallResults(body: unknown): HindsightSearchResult[] {
  const results = asRecord(body)?.results;
  if (!Array.isArray(results)) {
    throw new HindsightError("parse_error", "Hindsight recall response has no `results` array");
  }
  return results.map(toHindsightSearchResult);
}

function dedupeById(results: HindsightSearchResult[]): HindsightSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.id)) {
      return false;
    }
    seen.add(result.id);
    return true;
  });
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a finite integer >= 1, got ${String(value)}`);
  }
}

function resolveRecallLimit(config: HindsightConfig, requested: number | undefined): number {
  if (requested === undefined) {
    return config.maxResults;
  }
  assertPositiveInteger(requested, "maxResults");
  return Math.min(config.maxResults, requested);
}

export type HindsightRecall = {
  results: HindsightSearchResult[];
  /** Raw provider result count before dedupe and capping. */
  fetched: number;
};

export async function recallHindsightMemories(params: {
  config: HindsightConfig;
  query: string;
  maxResults?: number;
  cancellation?: HindsightCancellation;
}): Promise<HindsightRecall> {
  const limit = resolveRecallLimit(params.config, params.maxResults);
  const body = await requestHindsightJson({
    config: params.config,
    operation: "recall",
    url: buildMemoriesUrl(params.config, "/recall"),
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: params.query,
        types: HINDSIGHT_RECALL_TYPES,
        budget: params.config.budget,
        max_tokens: HINDSIGHT_RECALL_MAX_TOKENS,
      }),
    },
    cancellation: params.cancellation ?? {},
  });
  const parsed = parseRecallResults(body);
  return { results: dedupeById(parsed).slice(0, limit), fetched: parsed.length };
}

function buildWarningKey(operation: HindsightOperation, config: HindsightConfig): string {
  return JSON.stringify([operation, config.baseUrl, config.bank]);
}

function pruneWarningKeys(now: number): void {
  for (const [key, warnedAt] of lastFailureWarningAtByKey) {
    if (now - warnedAt >= HINDSIGHT_WARNING_INTERVAL_MS) {
      lastFailureWarningAtByKey.delete(key);
    }
  }
  while (lastFailureWarningAtByKey.size >= HINDSIGHT_WARNING_MAX_KEYS) {
    const oldestKey = lastFailureWarningAtByKey.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    lastFailureWarningAtByKey.delete(oldestKey);
  }
}

function describeWarningConsequence(operation: HindsightOperation): string {
  return operation === "recall"
    ? "memory_search continues without Hindsight hits"
    : "memory_get cannot read Hindsight memories";
}

/**
 * Log a server-side Hindsight failure at most once per minute per
 * operation+endpoint, so a down container is visible without flooding logs.
 * `not_found` is a caller error and is never logged here.
 */
export function warnHindsightFailureThrottled(params: {
  operation: HindsightOperation;
  config: HindsightConfig;
  error: HindsightError;
  now?: number;
}): boolean {
  if (params.error.code === "not_found") {
    return false;
  }
  const now = params.now ?? Date.now();
  const key = buildWarningKey(params.operation, params.config);
  const lastWarnedAt = lastFailureWarningAtByKey.get(key);
  const clockWentBackwards = lastWarnedAt !== undefined && now < lastWarnedAt;
  if (
    lastWarnedAt !== undefined &&
    !clockWentBackwards &&
    now - lastWarnedAt < HINDSIGHT_WARNING_INTERVAL_MS
  ) {
    return false;
  }
  lastFailureWarningAtByKey.delete(key);
  pruneWarningKeys(now);
  lastFailureWarningAtByKey.set(key, now);
  log.warn(
    `Hindsight ${params.operation} failed (${params.error.code}); ${describeWarningConsequence(params.operation)}: ${params.error.message}`,
  );
  return true;
}

/**
 * Recall that rejects only on caller cancellation. Provider failures are
 * logged (throttled) and reported in the outcome; an abandon is silent;
 * an unexpected exception is logged unthrottled and reported as `internal`.
 */
export async function recallHindsightMemoriesSafely(params: {
  config: HindsightConfig;
  query: string;
  maxResults?: number;
  cancellation?: HindsightCancellation;
}): Promise<HindsightRecallOutcome> {
  // Invalid caller input is a programming error: reject before the provider try.
  resolveRecallLimit(params.config, params.maxResults);
  const startedAt = Date.now();
  const cancellation = params.cancellation ?? {};
  try {
    const { results, fetched } = await recallHindsightMemories(params);
    return { results, fetched, ms: Date.now() - startedAt };
  } catch (error) {
    const ms = Date.now() - startedAt;
    if (cancellation.callerSignal?.aborted) {
      throw error;
    }
    if (cancellation.abandonSignal?.aborted) {
      return { results: [], fetched: 0, ms, abandoned: true };
    }
    if (error instanceof HindsightError) {
      warnHindsightFailureThrottled({ operation: "recall", config: params.config, error });
      return { results: [], fetched: 0, ms, error: error.message, code: error.code };
    }
    const message = `Hindsight recall crashed: ${describeError(error)}`;
    log.error(message);
    return { results: [], fetched: 0, ms, error: message, code: "internal" };
  }
}

function readUntrimmedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export async function readHindsightMemory(params: {
  config: HindsightConfig;
  id: string;
  callerSignal?: AbortSignal;
}): Promise<HindsightMemoryReadResult> {
  const body = asRecord(
    await requestHindsightJson({
      config: params.config,
      operation: "get",
      url: buildMemoriesUrl(params.config, `/${encodeURIComponent(params.id)}`),
      init: { method: "GET" },
      cancellation: { callerSignal: params.callerSignal },
    }),
  );
  const text = readUntrimmedText(body?.text);
  if (!body || !text) {
    throw new HindsightError("parse_error", `Hindsight memory ${params.id} returned no text`);
  }
  const returnedId = normalizeTrimmedString(body.id);
  if (!returnedId) {
    throw new HindsightError("parse_error", `Hindsight memory ${params.id} returned no id`);
  }
  if (returnedId !== params.id) {
    throw new HindsightError(
      "id_mismatch",
      `Hindsight returned memory ${returnedId} for requested id ${params.id}`,
    );
  }
  const kind = normalizeTrimmedString(body.type);
  const date = resolveHindsightDate(body);
  return {
    path: buildHindsightPath(returnedId),
    id: returnedId,
    source: HINDSIGHT_SOURCE,
    text,
    ...(kind ? { kind } : {}),
    ...(date ? { date } : {}),
  };
}

type Scored = { score: number };

function insertAfterNthMarkdownHit<T>(
  ranked: readonly T[],
  inserted: readonly T[],
  markdownCount: number,
): T[] {
  let seenMarkdown = 0;
  let insertAt = ranked.length;
  for (const [index, result] of ranked.entries()) {
    if (!isHindsightSearchResult(result)) {
      seenMarkdown += 1;
    }
    if (seenMarkdown === markdownCount) {
      insertAt = index + 1;
      break;
    }
  }
  return [...ranked.slice(0, insertAt), ...inserted, ...ranked.slice(insertAt)];
}

function byScoreDescending(left: Scored, right: Scored): number {
  return right.score - left.score;
}

/**
 * Rank markdown and Hindsight hits together. Positive-scored Hindsight hits
 * interleave with markdown by score. Unscored hits (score exactly 0, which
 * is what the API reports today) slot in right after the first three
 * markdown hits. Negative scores are valid but sort strictly last.
 */
function rankHindsightWithMarkdown<T extends Scored>(
  markdownResults: readonly T[],
  hindsightResults: readonly HindsightSearchResult[],
): Array<T | HindsightSearchResult> {
  const positive = hindsightResults
    .filter((result) => result.score > 0)
    .toSorted(byScoreDescending);
  const unscored = hindsightResults.filter((result) => result.score === 0);
  const negative = hindsightResults
    .filter((result) => result.score < 0)
    .toSorted(byScoreDescending);
  const ranked = mergeRankedStreamsByScore<T | HindsightSearchResult>(markdownResults, positive);
  return [
    ...insertAfterNthMarkdownHit(ranked, unscored, MARKDOWN_HITS_BEFORE_UNSCORED_HINDSIGHT),
    ...negative,
  ];
}

function isReservableHindsightHit(result: unknown): boolean {
  // A negative score sorts strictly last and never earns a reserved slot.
  return isHindsightSearchResult(result) && result.score >= 0;
}

/**
 * Cap a ranked mixed list to `maxResults`, keeping at least the first
 * `markdownReserve` markdown hits and `hindsightReserve` non-negative
 * Hindsight hits.
 */
function capWithReserves<T>(
  ranked: readonly T[],
  maxResults: number,
  reserves: { markdown: number; hindsight: number },
): T[] {
  const keep = new Set<number>();
  let markdownKept = 0;
  let hindsightKept = 0;
  for (const [index, result] of ranked.entries()) {
    const hindsight = isHindsightSearchResult(result);
    if (hindsight && hindsightKept < reserves.hindsight && isReservableHindsightHit(result)) {
      keep.add(index);
      hindsightKept += 1;
    } else if (!hindsight && markdownKept < reserves.markdown) {
      keep.add(index);
      markdownKept += 1;
    }
  }
  for (const index of ranked.keys()) {
    if (keep.size >= maxResults) {
      break;
    }
    keep.add(index);
  }
  return ranked.filter((_result, index) => keep.has(index));
}

function assertFiniteScores(results: readonly Scored[], label: string): void {
  for (const result of results) {
    if (!Number.isFinite(result.score)) {
      throw new RangeError(`${label} scores must be finite, got ${String(result.score)}`);
    }
  }
}

/**
 * Final merge under the caller's cap. Markdown is reserved first (up to
 * three hits); Hindsight keeps one slot only when the cap leaves room.
 */
export function mergeHindsightSearchResults<T extends Scored>(params: {
  markdownResults: readonly T[];
  hindsightResults: readonly HindsightSearchResult[];
  maxResults: number;
}): Array<T | HindsightSearchResult> {
  const { markdownResults, hindsightResults, maxResults } = params;
  assertPositiveInteger(maxResults, "maxResults");
  assertFiniteScores(markdownResults, "markdown");
  assertFiniteScores(hindsightResults, "hindsight");
  if (hindsightResults.length === 0) {
    return markdownResults.slice(0, maxResults);
  }
  if (markdownResults.length === 0) {
    return hindsightResults.slice(0, maxResults);
  }
  const markdownReserve = Math.min(
    MARKDOWN_HITS_RESERVED_UNDER_CAP,
    markdownResults.length,
    maxResults,
  );
  const hindsightReserve = Math.min(
    HINDSIGHT_HITS_RESERVED_UNDER_CAP,
    Math.max(0, maxResults - markdownReserve),
  );
  return capWithReserves(rankHindsightWithMarkdown(markdownResults, hindsightResults), maxResults, {
    markdown: markdownReserve,
    hindsight: hindsightReserve,
  });
}
