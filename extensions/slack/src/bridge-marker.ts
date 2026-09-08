// The hcom bridge proves that a woken turn really posted to Slack by looking
// for that turn's delivery marker in the thread; a job run claims its terminal
// post the same way, with a `job:<id>:<run tag>:terminal` token minted by
// `scripts/register_job.py`. Both are harness vocabulary, and Constitution
// Article 8 keeps harness vocabulary out of human-facing messages: on
// 2026-09-07 a research post in #fractal-ai-gateway ended with the literal
// text `[hcom-bridge-marker:0652b747...]`, and on 2026-09-08 a result post
// ended with 48 lines of `job:...:terminal`.
//
// So neither token travels as visible text. Anything a Slack send carries that
// looks like harness bookkeeping is stripped from the text, and the tokens are
// re-attached as Slack message metadata, which humans never see and
// `conversations.replies` returns for the publishing app with
// `include_all_metadata=true` (read by `_metadata_marker` in
// `scripts/hcom_fai_bridge.py`).
import type { MessageMetadata } from "@slack/types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

/** Event type used when a send carrying the marker has no metadata of its own. */
export const HCOM_BRIDGE_MARKER_EVENT_TYPE = "hcom_bridge_marker";

/** Event type used when a send carries job receipts but no marker and no metadata. */
export const HARNESS_RECEIPT_EVENT_TYPE = "harness_receipt";

/**
 * Namespaced `event_payload` key holding the marker. The bridge matches on this
 * key alone, so the marker survives being merged into another feature's
 * metadata object (assistant-thread context, durable-delivery markers), which
 * keeps its own `event_type`.
 */
export const HCOM_BRIDGE_MARKER_PAYLOAD_KEY = "hcom_bridge_marker";

/** Namespaced `event_payload` key holding the job terminal receipt tokens. */
export const HARNESS_RECEIPT_PAYLOAD_KEY = "harness_receipts";

/**
 * How many receipts the metadata carries. Slack rejects a whole
 * chat.postMessage once `event_payload` tops 8KB, which would lose the
 * human-facing post itself — worse than the leak this module fixes. A token
 * is ~55 bytes, so 64 of them (~3.5KB) stays clear of the limit. Stripping
 * the tokens out of the text is unconditional; only the proof is capped.
 */
export const HARNESS_RECEIPT_METADATA_LIMIT = 64;

const MARKER_TOKEN_PREFIX = "[hcom-bridge-marker:";
const RECEIPT_PREFIX = "HCOM_BRIDGE_RECEIPT:";
const JOB_RECEIPT_PREFIX = "job:";

const MARKER_TOKEN = /\[hcom-bridge-marker:[^\]\s]{0,256}\]/g;
// Removal eats the space in front of the token too, so a marker taken out of
// the middle of a sentence leaves no double space behind.
const MARKER_TOKEN_WITH_PAD = /[ \t]*\[hcom-bridge-marker:[^\]\s]{0,256}\]/g;
// Only a line that *starts* with the receipt prefix is the machine receipt.
// Prose that merely names the receipt stays intact, so the bot can still
// explain itself to a human.
const RECEIPT_LINE = /^[ \t>*\-`]*HCOM_BRIDGE_RECEIPT:.*$/gm;
// `job:<id>:<8 hex run tag>:terminal`. The run tag and the `terminal` claim are
// what tell a receipt apart from prose that happens to say "job:".
const JOB_RECEIPT_SOURCE = "(?<![A-Za-z0-9])job:[A-Za-z0-9._-]{1,128}:[0-9a-f]{8}:terminal";
const JOB_RECEIPT_TOKEN = new RegExp(JOB_RECEIPT_SOURCE, "g");
const JOB_RECEIPT_TOKEN_WITH_PAD = new RegExp(`[ \\t]*${JOB_RECEIPT_SOURCE}`, "g");
// A line holding nothing but receipts — plain, bulleted, quoted, or wrapped in
// backticks — goes whole, so no empty bullet or orphan backtick is left behind.
const JOB_RECEIPT_LINE = new RegExp(
  `^[ \\t>*\\-\`]*${JOB_RECEIPT_SOURCE}(?:[ \\t,;\`]*${JOB_RECEIPT_SOURCE})*[ \\t.,;\`]*$`,
  "gm",
);
const TRAILING_SPACES = /[ \t]+$/gm;
const BLANK_RUN = /\n{3,}/g;
// Whole-line removals run before the inline ones, so a receipt-only line takes
// its decoration with it instead of being hollowed out.
const HARNESS_REMOVALS = [
  JOB_RECEIPT_LINE,
  RECEIPT_LINE,
  MARKER_TOKEN_WITH_PAD,
  JOB_RECEIPT_TOKEN_WITH_PAD,
] as const;

/** Cheap gate: text without one of these prefixes cannot carry a token. */
function mayCarryHarnessText(text: string): boolean {
  return (
    text.includes(MARKER_TOKEN_PREFIX) ||
    text.includes(RECEIPT_PREFIX) ||
    text.includes(JOB_RECEIPT_PREFIX)
  );
}

/** Text with every harness token removed, or undefined when none matched. */
function removeHarnessTokens(text: string): string | undefined {
  let stripped = text;
  for (const removal of HARNESS_REMOVALS) {
    stripped = stripped.replace(removal, "");
  }
  return stripped === text ? undefined : stripped;
}

/**
 * Removes bridge marker tokens, machine receipt lines and job terminal
 * receipts from Slack text. Returns the input unchanged (same reference) when
 * no removal matched, so prose that merely says "job:" or names the receipt
 * keeps its exact bytes — reflowing it would be a silent edit of a human's
 * message.
 */
export function stripHcomBridgeHarnessText(text: string): string {
  if (!text || !mayCarryHarnessText(text)) {
    return text;
  }
  const stripped = removeHarnessTokens(text);
  if (stripped === undefined) {
    return text;
  }
  return stripped.replace(TRAILING_SPACES, "").replace(BLANK_RUN, "\n\n").trim();
}

/** Slack text with the harness bookkeeping removed, plus the marker it carried. */
export function extractHcomBridgeMarker(text: string): { text: string; marker?: string } {
  if (!text || !mayCarryHarnessText(text)) {
    return { text };
  }
  const marker = text.match(MARKER_TOKEN)?.[0];
  const stripped = stripHcomBridgeHarnessText(text);
  return marker ? { text: stripped, marker } : { text: stripped };
}

/**
 * First marker token in any string of a Block Kit payload, or undefined.
 * A reply rendered into blocks carries the marker there, not in the text.
 */
export function findHcomBridgeMarkerDeep(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.includes(MARKER_TOKEN_PREFIX)
      ? (value.match(MARKER_TOKEN)?.[0] ?? undefined)
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findHcomBridgeMarkerDeep(entry);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findHcomBridgeMarkerDeep(entry);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Every job terminal receipt in any string of a value — a plain message or a
 * Block Kit payload — in the order it appears. Repeats are kept here;
 * `withHarnessReceiptMetadata` is the one place that de-duplicates.
 */
export function findJobReceiptsDeep(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes(JOB_RECEIPT_PREFIX) ? (value.match(JOB_RECEIPT_TOKEN) ?? []) : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => findJobReceiptsDeep(entry));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value as Record<string, unknown>).flatMap((entry) =>
    findJobReceiptsDeep(entry),
  );
}

/**
 * Recursively strips harness text from every string in a Block Kit payload.
 * Returns the same reference when nothing matched, so the common send path
 * allocates nothing.
 */
export function stripHcomBridgeHarnessTextDeep<T>(value: T): T {
  if (typeof value === "string") {
    return stripHcomBridgeHarnessText(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const mapped = stripHcomBridgeHarnessTextDeep(entry);
      changed = changed || mapped !== entry;
      return mapped;
    });
    return (changed ? next : value) as unknown as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const mapped = stripHcomBridgeHarnessTextDeep(entry);
    changed = changed || mapped !== entry;
    next[key] = mapped;
  }
  return (changed ? next : value) as unknown as T;
}

/** De-duplicated receipts, in order, trimmed to what the metadata can carry. */
function capJobReceipts(jobReceipts: readonly string[] | undefined): string[] | undefined {
  if (!jobReceipts?.length) {
    return undefined;
  }
  const unique = [...new Set(jobReceipts)];
  if (unique.length <= HARNESS_RECEIPT_METADATA_LIMIT) {
    return unique;
  }
  logVerbose(
    `slack send: dropped ${unique.length - HARNESS_RECEIPT_METADATA_LIMIT} job receipt(s) over the ${HARNESS_RECEIPT_METADATA_LIMIT}-token metadata cap; the visible text is stripped either way`,
  );
  return unique.slice(0, HARNESS_RECEIPT_METADATA_LIMIT);
}

/** Harness tokens a Slack send carried, on their way into message metadata. */
export type HarnessReceipts = {
  marker?: string;
  jobReceipts?: readonly string[];
};

type MetadataPayloadValue = MessageMetadata["event_payload"][string];

/**
 * Attaches the harness tokens a send carried to its metadata, keeping whatever
 * metadata the send already declared — including that metadata's `event_type`,
 * which is how the marker rides along with another feature's payload. Job
 * receipts are de-duplicated and capped at HARNESS_RECEIPT_METADATA_LIMIT.
 * Returns the metadata it was given when there is nothing to attach.
 */
export function withHarnessReceiptMetadata(
  metadata: MessageMetadata | undefined,
  receipts: HarnessReceipts,
): MessageMetadata | undefined {
  const marker = receipts.marker;
  const jobReceipts = capJobReceipts(receipts.jobReceipts);
  if (!marker && !jobReceipts) {
    return metadata;
  }
  return {
    ...metadata,
    event_type:
      metadata?.event_type ?? (marker ? HCOM_BRIDGE_MARKER_EVENT_TYPE : HARNESS_RECEIPT_EVENT_TYPE),
    event_payload: {
      ...metadata?.event_payload,
      ...(marker ? { [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: marker } : {}),
      // Slack takes a JSON array of strings here; @slack/types only models
      // arrays of objects, so the value shape has to be asserted.
      ...(jobReceipts
        ? { [HARNESS_RECEIPT_PAYLOAD_KEY]: jobReceipts as unknown as MetadataPayloadValue }
        : {}),
    },
  };
}
