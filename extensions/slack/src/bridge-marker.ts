// The hcom bridge proves that a woken turn really posted to Slack by looking
// for that turn's delivery marker in the thread. The marker is harness
// vocabulary, and Constitution Article 8 keeps harness vocabulary out of
// human-facing messages: on 2026-09-07 a research post in #fractal-ai-gateway
// ended with the literal text `[hcom-bridge-marker:0652b747...]`.
//
// So the marker never travels as visible text. Anything a Slack send carries
// that looks like bridge bookkeeping — a marker token, or the machine receipt
// line the woken turn is supposed to keep in its own output — is stripped from
// the text, and the marker is re-attached as Slack message metadata, which
// humans never see and `conversations.replies` returns for the publishing app
// with `include_all_metadata=true` (read by `_metadata_marker` in
// `scripts/hcom_fai_bridge.py`).
import type { MessageMetadata } from "@slack/types";

/** Event type used when a send has no metadata of its own to merge into. */
export const HCOM_BRIDGE_MARKER_EVENT_TYPE = "hcom_bridge_marker";

/**
 * Namespaced `event_payload` key holding the marker. The bridge matches on this
 * key alone, so the marker survives being merged into another feature's
 * metadata object (assistant-thread context, durable-delivery markers), which
 * keeps its own `event_type`.
 */
export const HCOM_BRIDGE_MARKER_PAYLOAD_KEY = "hcom_bridge_marker";

const MARKER_TOKEN_PREFIX = "[hcom-bridge-marker:";
const RECEIPT_PREFIX = "HCOM_BRIDGE_RECEIPT:";

const MARKER_TOKEN = /\[hcom-bridge-marker:[^\]\s]{0,256}\]/g;
// Removal eats the space in front of the token too, so a marker taken out of
// the middle of a sentence leaves no double space behind.
const MARKER_TOKEN_WITH_PAD = /[ \t]*\[hcom-bridge-marker:[^\]\s]{0,256}\]/g;
// Only a line that *starts* with the receipt prefix is the machine receipt.
// Prose that merely names the receipt stays intact, so the bot can still
// explain itself to a human.
const RECEIPT_LINE = /^[ \t>*\-`]*HCOM_BRIDGE_RECEIPT:.*$/gm;
const TRAILING_SPACES = /[ \t]+$/gm;
const BLANK_RUN = /\n{3,}/g;

function carriesHarnessText(text: string): boolean {
  return text.includes(MARKER_TOKEN_PREFIX) || text.includes(RECEIPT_PREFIX);
}

/**
 * Removes bridge marker tokens and machine receipt lines from Slack text.
 * Returns the input unchanged (same reference) when it carries neither.
 */
export function stripHcomBridgeHarnessText(text: string): string {
  if (!text || !carriesHarnessText(text)) {
    return text;
  }
  return text
    .replace(MARKER_TOKEN_WITH_PAD, "")
    .replace(RECEIPT_LINE, "")
    .replace(TRAILING_SPACES, "")
    .replace(BLANK_RUN, "\n\n")
    .trim();
}

/** Slack text with the harness bookkeeping removed, plus the marker it carried. */
export function extractHcomBridgeMarker(text: string): { text: string; marker?: string } {
  if (!text || !carriesHarnessText(text)) {
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

/** Attaches the marker to a send's metadata, keeping any metadata already declared. */
export function withHcomBridgeMarkerMetadata(
  metadata: MessageMetadata | undefined,
  marker: string,
): MessageMetadata {
  if (!metadata) {
    return {
      event_type: HCOM_BRIDGE_MARKER_EVENT_TYPE,
      event_payload: { [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: marker },
    };
  }
  return {
    ...metadata,
    event_payload: {
      ...metadata.event_payload,
      [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: marker,
    },
  };
}
