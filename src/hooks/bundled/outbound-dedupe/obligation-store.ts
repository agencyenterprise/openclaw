// One reservation per obligation key, stored as JSON under <workspace>/state and
// written through the same lock-and-atomic-rename helper as the hash store, so a
// send in another process cannot slip between the read and the write.
//
// A reservation is taken BEFORE the send. It starts pending, becomes confirmed on
// the successful `message:sent`, and is dropped on a failed one so a retry is
// never blocked. A pending reservation expires after PENDING_TTL_MS (the send
// never reported back), a confirmed one after the configured window.
import { updateJsonFile } from "../../workspace-state.js";
import { PENDING_TTL_MS } from "./hash-store.js";

export const OUTBOUND_OBLIGATIONS_FILE = "outbound_obligations.json";

export type ObligationReservation = {
  /** Session key of the run that took the reservation. */
  holder: string;
  /** Fingerprint of the reserved text, used to match `message:sent` back to this entry. */
  contentHash: string;
  reservedAt: string;
  confirmedAt?: string;
  /** The one physical send that took this reservation, when the caller named it. */
  sendNonce?: string;
};

export type ObligationReservationStore = Record<string, ObligationReservation>;

/**
 * - `reserved`    — this send owns the obligation and goes out.
 * - `same-answer` — the holder is still delivering the answer it reserved
 *   (`message_sending` fires once per payload chunk), so the send goes out
 *   without taking a second reservation.
 * - `duplicate`   — somebody already answered this obligation; cancel the send.
 */
export type ObligationOutcome = "reserved" | "same-answer" | "duplicate";

type LiveWindow = { now: Date; windowMs: number };

function isLive(reservation: ObligationReservation, window: LiveWindow): boolean {
  const nowMs = window.now.getTime();
  if (reservation.confirmedAt) {
    return Date.parse(reservation.confirmedAt) >= nowMs - window.windowMs;
  }
  return Date.parse(reservation.reservedAt) >= nowMs - PENDING_TTL_MS;
}

/** The reservations that still block a send; expired ones are dropped from the file. */
export function liveReservations(
  store: ObligationReservationStore,
  window: LiveWindow,
): ObligationReservationStore {
  return Object.fromEntries(
    Object.entries(store).filter(([, reservation]) => isLive(reservation, window)),
  );
}

/**
 * One physical send runs `message_sending` more than once — the inbound
 * dispatcher fires it, then core outbound delivery fires it again for the same
 * payload — and both fires quote one `sendNonce`. That is the same send, not a
 * second answer, however long delivery took to get there, so it is matched
 * before the holder burst and is not bounded by it. Pending only: once the
 * reservation is confirmed the send reached the channel, and a later fire
 * quoting its nonce is a replay.
 */
function isSameSend(held: ObligationReservation, sendNonce: string | undefined): boolean {
  return sendNonce !== undefined && held.confirmedAt === undefined && held.sendNonce === sendNonce;
}

/**
 * The run that took the reservation is still delivering the same answer. One
 * answer becomes several `message_sending` calls (one per payload), and they all
 * carry the same obligation, so the holder keeps sending for `burstMs`. Any other
 * run, and the holder itself once the burst is over, is a re-answer.
 */
function isSameAnswer(
  held: ObligationReservation,
  params: { holder: string; now: Date; burstMs: number },
): boolean {
  return (
    held.holder === params.holder &&
    params.now.getTime() - Date.parse(held.reservedAt) <= params.burstMs
  );
}

type HolderEntry = [string, ObligationReservation];

/**
 * Locate the reservation a `message:sent` belongs to. `message:sent` carries no
 * obligation, so the run that reported back is matched by its own text first;
 * when the channel rendered the text after the pre-send hook the fingerprint no
 * longer matches, and that run's oldest pending reservation is taken instead
 * (a run delivers its payloads in order).
 */
function pendingForHolder(
  store: ObligationReservationStore,
  params: { holder: string; contentHash: string },
): HolderEntry | undefined {
  const pending = Object.entries(store)
    .filter(
      ([, reservation]) =>
        reservation.confirmedAt === undefined && reservation.holder === params.holder,
    )
    .toSorted(([, left], [, right]) => left.reservedAt.localeCompare(right.reservedAt));
  return (
    pending.find(([, reservation]) => reservation.contentHash === params.contentHash) ??
    pending.at(0)
  );
}

/** Reserve the obligation key for this send. Runs under the cross-process file lock. */
export function reserveObligation(
  filePath: string,
  params: {
    key: string;
    holder: string;
    contentHash: string;
    /** Identifies one physical send across every hook fire that precedes it. */
    sendNonce?: string;
    now: Date;
    windowMs: number;
    burstMs: number;
  },
): Promise<ObligationOutcome> {
  return updateJsonFile<ObligationReservationStore, ObligationOutcome>(filePath, {}, (store) => {
    const live = liveReservations(store, params);
    const expiredWereDropped = Object.keys(live).length !== Object.keys(store).length;
    const held = live[params.key];
    if (held) {
      const sameSend = isSameSend(held, params.sendNonce);
      return {
        next: expiredWereDropped ? live : undefined,
        result: sameSend || isSameAnswer(held, params) ? "same-answer" : "duplicate",
      };
    }
    live[params.key] = {
      holder: params.holder,
      contentHash: params.contentHash,
      reservedAt: params.now.toISOString(),
      ...(params.sendNonce ? { sendNonce: params.sendNonce } : {}),
    };
    return { next: live, result: "reserved" };
  });
}

/** Confirm the reservation a successful send belongs to (see pendingForHolder). */
export function confirmObligation(
  filePath: string,
  params: { holder: string; contentHash: string; now: Date },
): Promise<boolean> {
  return updateJsonFile<ObligationReservationStore, boolean>(filePath, {}, (store) => {
    const pending = pendingForHolder(store, params);
    if (!pending) {
      return { next: undefined, result: false };
    }
    const [key, reservation] = pending;
    store[key] = { ...reservation, confirmedAt: params.now.toISOString() };
    return { next: store, result: true };
  });
}

/** Drop the reservation a failed send holds, so the retry of that answer passes. */
export function releaseObligation(
  filePath: string,
  params: { holder: string; contentHash: string },
): Promise<boolean> {
  return updateJsonFile<ObligationReservationStore, boolean>(filePath, {}, (store) => {
    const pending = pendingForHolder(store, params);
    if (!pending) {
      return { next: undefined, result: false };
    }
    delete store[pending[0]];
    return { next: store, result: true };
  });
}
