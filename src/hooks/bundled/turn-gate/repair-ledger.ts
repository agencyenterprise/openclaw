// The repair budget, under the shared advisory lock. Three lists answer four
// rules, and they are pruned differently on purpose: a deliverable repaired once
// and a thread that already tagged the owner are *permanent* facts, while the
// cooldown and the daily cap only ever look at the last two days.
import { createHash, randomUUID } from "node:crypto";
import { resolveWorkspaceStatePath, updateJsonFile } from "../../workspace-state.js";
import type { TurnGateRepairConfig } from "./repair.js";

export const TURN_GATE_REPAIRS_FILE = "turn_gate_repairs.json";

/** Permanent facts. Large enough that "once ever" is never quietly forgotten. */
const MAX_TOMBSTONES = 20_000;
/** Rate-limit history floor; a longer configured cooldown widens it. */
const MIN_RATE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** One claim's rate-limit footprint, tied to the claim by its nonce. */
type RateEntry = { at: string; session: string; nonce: string };

/** A repair that was queued and is waiting for the turn it started. */
type PendingRepair = {
  nonce: string;
  session: string;
  thread: string;
  messageId: string;
  at: string;
};

export type RepairLedger = {
  /** Deliverable keys already repaired, forever. */
  repaired: string[];
  /** Threads where the decision owner has already been tagged, forever. */
  taggedThreads: string[];
  recent: RateEntry[];
  pending: PendingRepair[];
};

export type RepairDenial = "already-repaired" | "cooldown" | "daily-cap";

export type RepairClaim =
  | { granted: true; nonce: string; tagDecisionOwner: boolean }
  | { granted: false; reason: RepairDenial };

function emptyLedger(): RepairLedger {
  return { repaired: [], taggedThreads: [], recent: [], pending: [] };
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The rate history has to outlive the longest limit that reads it, so a cooldown
 * configured beyond the floor widens the window instead of silently expiring.
 */
function rateCutoff(now: Date, cooldownMinutes: number): number {
  return now.getTime() - Math.max(MIN_RATE_WINDOW_MS, cooldownMinutes * 60_000 * 2);
}

function readRate(value: unknown, cutoff: number): RateEntry[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is RateEntry =>
          typeof (entry as RateEntry)?.at === "string" &&
          typeof (entry as RateEntry).session === "string" &&
          Date.parse((entry as RateEntry).at) >= cutoff,
      )
    : [];
}

function readPending(value: unknown, cutoff: number): PendingRepair[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is PendingRepair =>
          typeof (entry as PendingRepair)?.nonce === "string" &&
          typeof (entry as PendingRepair).session === "string" &&
          typeof (entry as PendingRepair).messageId === "string" &&
          Date.parse((entry as PendingRepair).at) >= cutoff,
      )
    : [];
}

function normalize(ledger: RepairLedger, now: Date, cooldownMinutes = 0): RepairLedger {
  const cutoff = rateCutoff(now, cooldownMinutes);
  return {
    repaired: readStrings(ledger?.repaired).slice(-MAX_TOMBSTONES),
    taggedThreads: readStrings(ledger?.taggedThreads).slice(-MAX_TOMBSTONES),
    recent: readRate(ledger?.recent, cutoff),
    pending: readPending(ledger?.pending, cutoff),
  };
}

/** The most recent claim this session made, by timestamp rather than by order. */
function lastClaimAt(recent: readonly RateEntry[], sessionKey: string): number {
  return recent
    .filter((entry) => entry.session === sessionKey)
    .reduce((latest, entry) => Math.max(latest, Date.parse(entry.at)), Number.NEGATIVE_INFINITY);
}

function ledgerPath(workspaceDir: string): string {
  return resolveWorkspaceStatePath(workspaceDir, TURN_GATE_REPAIRS_FILE);
}

/** Stable identity of one deliverable: which message asked, and what was promised. */
export function repairKey(
  inboundMessageId: string,
  commitmentSentences: readonly string[],
): string {
  const digest = createHash("sha256").update(commitmentSentences.join("\n")).digest("hex");
  return `${inboundMessageId}#${digest.slice(0, 12)}`;
}

/**
 * Claim the single repair allowed for this deliverable and mint the nonce that
 * identifies the turn it starts. Read, decision and write happen inside one lock
 * hold, so two turns ending together cannot both take the last slot of the day or
 * both tag the same thread.
 */
export function claimRepair(params: {
  workspaceDir: string;
  sessionKey: string;
  thread: string;
  key: string;
  messageId: string;
  config: TurnGateRepairConfig;
  now: Date;
}): Promise<RepairClaim> {
  const nowIso = params.now.toISOString();
  const today = nowIso.slice(0, 10);
  return updateJsonFile<RepairLedger, RepairClaim>(
    ledgerPath(params.workspaceDir),
    emptyLedger(),
    (current) => {
      const ledger = normalize(current, params.now, params.config.cooldownMinutes);
      if (ledger.repaired.includes(params.key)) {
        return { next: undefined, result: { granted: false, reason: "already-repaired" } };
      }
      const sentToday = ledger.recent.filter((entry) => entry.at.startsWith(today)).length;
      if (sentToday >= params.config.maxPerDay) {
        return { next: undefined, result: { granted: false, reason: "daily-cap" } };
      }
      const cooldownMs = params.config.cooldownMinutes * 60_000;
      const previousAt = lastClaimAt(ledger.recent, params.sessionKey);
      if (Number.isFinite(previousAt) && params.now.getTime() - previousAt < cooldownMs) {
        return { next: undefined, result: { granted: false, reason: "cooldown" } };
      }
      const tagDecisionOwner = !ledger.taggedThreads.includes(params.thread);
      const nonce = randomUUID().replace(/-/g, "").slice(0, 12);
      return {
        next: {
          repaired: [...ledger.repaired, params.key].slice(-MAX_TOMBSTONES),
          taggedThreads: tagDecisionOwner
            ? [...ledger.taggedThreads, params.thread].slice(-MAX_TOMBSTONES)
            : ledger.taggedThreads,
          recent: [...ledger.recent, { at: nowIso, session: params.sessionKey, nonce }],
          pending: [
            ...ledger.pending,
            {
              nonce,
              session: params.sessionKey,
              thread: params.thread,
              messageId: params.messageId,
              at: nowIso,
            },
          ],
        },
        result: { granted: true, nonce, tagDecisionOwner },
      };
    },
  );
}

/**
 * Give a whole claim back when the repair turn could not be queued: the
 * tombstone, the rate entry and the pending nonce all belong to it, so all three
 * go. The thread tag is only released when no other live claim still relies on
 * it, otherwise a concurrent repair that was told "you are the first" would
 * become the second one to tag the same thread.
 */
export function releaseRepair(params: {
  workspaceDir: string;
  thread: string;
  key: string;
  nonce: string;
  tagged: boolean;
  now: Date;
}): Promise<void> {
  return updateJsonFile<RepairLedger, void>(
    ledgerPath(params.workspaceDir),
    emptyLedger(),
    (current) => {
      const ledger = normalize(current, params.now);
      const pending = ledger.pending.filter((entry) => entry.nonce !== params.nonce);
      const threadStillClaimed = pending.some((entry) => entry.thread === params.thread);
      return {
        next: {
          repaired: ledger.repaired.filter((key) => key !== params.key),
          taggedThreads:
            params.tagged && !threadStillClaimed
              ? ledger.taggedThreads.filter((thread) => thread !== params.thread)
              : ledger.taggedThreads,
          recent: ledger.recent.filter((entry) => entry.nonce !== params.nonce),
          pending,
        },
        result: undefined,
      };
    },
  );
}

/**
 * Recognize the turn a repair started, exactly once. The nonce is minted here and
 * only ever written into that session's own prompt, so a message that merely
 * quotes the marker back matches nothing.
 */
export function consumeRepairNonce(params: {
  workspaceDir: string;
  sessionKey: string;
  nonce: string;
  now: Date;
}): Promise<string | undefined> {
  return updateJsonFile<RepairLedger, string | undefined>(
    ledgerPath(params.workspaceDir),
    emptyLedger(),
    (current) => {
      const ledger = normalize(current, params.now);
      const match = ledger.pending.find(
        (entry) => entry.nonce === params.nonce && entry.session === params.sessionKey,
      );
      if (!match) {
        return { next: undefined, result: undefined };
      }
      return {
        next: {
          ...ledger,
          pending: ledger.pending.filter((entry) => entry.nonce !== params.nonce),
        },
        result: match.messageId,
      };
    },
  );
}
