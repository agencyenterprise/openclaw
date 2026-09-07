// Per-thread ring of recent outbound fingerprints stored as JSON under
// <workspace>/state. An entry starts as a pending reservation at
// `message_sending` and becomes confirmed at a successful `message:sent`;
// unconfirmed reservations expire after PENDING_TTL_MS so a retry after a
// failed send is never suppressed.
import { updateJsonFile } from "../../workspace-state.js";

export type OutboundHashEntry = {
  hash: string;
  reservedAt: string;
  confirmedAt?: string;
  /** The one physical send this reservation was taken for, when the caller named it. */
  sendNonce?: string;
};

export type OutboundHashStore = Record<string, OutboundHashEntry[]>;

export const OUTBOUND_HASHES_FILE = "outbound_hashes.json";
export const PENDING_TTL_MS = 2 * 60 * 1000;

type LiveWindow = { now: Date; windowMs: number };

function isLive(entry: OutboundHashEntry, window: LiveWindow): boolean {
  const nowMs = window.now.getTime();
  if (entry.confirmedAt) {
    return Date.parse(entry.confirmedAt) >= nowMs - window.windowMs;
  }
  return Date.parse(entry.reservedAt) >= nowMs - PENDING_TTL_MS;
}

/** Entries that still count: confirmed sends inside the window plus unexpired reservations. */
export function liveEntries(
  entries: OutboundHashEntry[] | undefined,
  window: LiveWindow,
): OutboundHashEntry[] {
  return (entries ?? []).filter((entry) => isLive(entry, window));
}

export function appendEntry(
  entries: OutboundHashEntry[],
  entry: OutboundHashEntry,
  maxPerThread: number,
): OutboundHashEntry[] {
  return [...entries, entry].slice(-maxPerThread);
}

/** Thread keys of the same channel target (`<channelId>:<target>:`), excluding `threadKey` itself. */
function otherThreadKeysForChannel(store: OutboundHashStore, threadKey: string): string[] {
  const channelPrefix = threadKey.slice(0, threadKey.lastIndexOf(":") + 1);
  return Object.keys(store).filter((key) => key !== threadKey && key.startsWith(channelPrefix));
}

function isPending(entry: OutboundHashEntry): boolean {
  return entry.confirmedAt === undefined;
}

function oldestFirst(entries: OutboundHashEntry[]): OutboundHashEntry[] {
  return entries.toSorted((left, right) => left.reservedAt.localeCompare(right.reservedAt));
}

/**
 * Locate the reservation a `message:sent` event belongs to:
 * 1. same thread key, same hash;
 * 2. same thread key, oldest pending (the channel rendered the text after the
 *    pre-send hook, so the hash no longer matches; sends in one thread are ordered);
 * 3. another thread of the same channel target, same hash (an announce reserved
 *    with an explicit `threadId` reports `message:sent` under a session key that
 *    may not carry the thread).
 */
function findPendingEntry(
  store: OutboundHashStore,
  params: { threadKey: string; hash: string },
): OutboundHashEntry | undefined {
  const pendingInThread = (store[params.threadKey] ?? []).filter(isPending);
  const sameHashInThread = pendingInThread.find((entry) => entry.hash === params.hash);
  if (sameHashInThread) {
    return sameHashInThread;
  }
  const oldestInThread = oldestFirst(pendingInThread)[0];
  if (oldestInThread) {
    return oldestInThread;
  }
  const sameHashElsewhere = otherThreadKeysForChannel(store, params.threadKey).flatMap((key) =>
    (store[key] ?? []).filter((entry) => isPending(entry) && entry.hash === params.hash),
  );
  return oldestFirst(sameHashElsewhere)[0];
}

function removeEntry(store: OutboundHashStore, entry: OutboundHashEntry): void {
  for (const entries of Object.values(store)) {
    const index = entries.indexOf(entry);
    if (index >= 0) {
      entries.splice(index, 1);
      return;
    }
  }
}

export type ReservationOutcome = "duplicate" | "reserved" | "same-send";

/**
 * The reservation this very send already holds, if any.
 *
 * One physical send reaches the guard more than once: the inbound dispatcher
 * runs `message_sending` before it hands the payload to delivery, and core
 * outbound delivery runs it again for the same payload. Both fires carry the
 * same `sendNonce`, so the later one has to recognise the earlier one's
 * reservation instead of reading it as a repeat of the text. The whole store is
 * searched, not just this thread key, because the fires do not see the same
 * routing fields — only delivery knows the thread id — so one send can produce
 * two different thread keys.
 *
 * Pending only. A confirmed entry means that send already reached the channel,
 * so a later fire quoting its nonce is a replay of a delivered message and has
 * to be read as the duplicate it is.
 */
function findPendingEntryForSend(
  store: OutboundHashStore,
  sendNonce: string | undefined,
): OutboundHashEntry | undefined {
  if (!sendNonce) {
    return undefined;
  }
  for (const entries of Object.values(store)) {
    const reserved = (entries ?? []).find(
      (entry) => isPending(entry) && entry.sendNonce === sendNonce,
    );
    if (reserved) {
      return reserved;
    }
  }
  return undefined;
}

/** As above, but ignoring a reservation whose pending TTL has already run out. */
function findLiveReservationForSend(
  store: OutboundHashStore,
  params: { sendNonce?: string; now: Date; windowMs: number },
): OutboundHashEntry | undefined {
  const reserved = findPendingEntryForSend(store, params.sendNonce);
  return reserved && isLive(reserved, params) ? reserved : undefined;
}

export function reserveHash(
  filePath: string,
  params: {
    threadKey: string;
    hash: string;
    /** Identifies one physical send across every hook fire that precedes it. */
    sendNonce?: string;
    now: Date;
    windowMs: number;
    maxPerThread: number;
  },
): Promise<ReservationOutcome> {
  return updateJsonFile<OutboundHashStore, ReservationOutcome>(filePath, {}, (store) => {
    const heldForThisSend = findLiveReservationForSend(store, params);
    if (heldForThisSend) {
      // Re-point the reservation at what is about to go out. Each fire sees the
      // payload one step further along — the channel renders the text after the
      // dispatcher fire — and the fingerprint that has to survive the duplicate
      // window is the one the channel actually sends.
      const rewritten = heldForThisSend.hash !== params.hash;
      heldForThisSend.hash = params.hash;
      return { next: rewritten ? store : undefined, result: "same-send" };
    }
    const entries = liveEntries(store[params.threadKey], params);
    if (entries.some((entry) => entry.hash === params.hash)) {
      return { next: undefined, result: "duplicate" };
    }
    store[params.threadKey] = appendEntry(
      entries,
      {
        hash: params.hash,
        reservedAt: params.now.toISOString(),
        ...(params.sendNonce ? { sendNonce: params.sendNonce } : {}),
      },
      params.maxPerThread,
    );
    return { next: store, result: "reserved" };
  });
}

/** Confirm the reservation a successful send belongs to (see findPendingEntry). */
export function confirmHash(
  filePath: string,
  params: { threadKey: string; hash: string; now: Date },
): Promise<boolean> {
  return updateJsonFile<OutboundHashStore, boolean>(filePath, {}, (store) => {
    const pending = findPendingEntry(store, params);
    if (!pending) {
      return { next: undefined, result: false };
    }
    pending.confirmedAt = params.now.toISOString();
    return { next: store, result: true };
  });
}

/** Drop the reservation a failed send belongs to (see findPendingEntry). */
export function releaseHash(
  filePath: string,
  params: { threadKey: string; hash: string; sendNonce?: string },
): Promise<boolean> {
  return updateJsonFile<OutboundHashStore, boolean>(filePath, {}, (store) => {
    // Send identity beats the content match: a later fire of one send has to
    // cancel the reservation an earlier fire of that same send took, wherever it
    // landed and whichever of the two texts it recorded.
    const pending =
      findPendingEntryForSend(store, params.sendNonce) ?? findPendingEntry(store, params);
    if (!pending) {
      return { next: undefined, result: false };
    }
    removeEntry(store, pending);
    return { next: store, result: true };
  });
}
