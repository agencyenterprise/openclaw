// The repair needs two facts that never arrive together. `agent_end` knows what
// the turn promised and what it armed, but runs before delivery, so its context
// carries inbound ids only (`PluginHookAgentEndEvent`). `message:sent` knows the
// Slack ts of the message that carried the promise, but not what was in it. This
// module holds the intent between the two.
//
// A turn can deliver several messages; each one resets a short settle timer, so
// the repair runs once, against the last message of the turn — the same shape the
// reviewer hook uses for the same reason.
import type { TurnGateRepairConfig } from "./repair.js";

export type RepairIntent = {
  sessionKey: string;
  /** `<channel>:<threadTs>` — the ledger's thread identity. */
  thread: string;
  /** The same thread as the lane records address it. */
  channel?: string;
  threadTs?: string;
  workspaceDir: string;
  inboundMessageId: string;
  inboundText?: string;
  sentences: string[];
  config: TurnGateRepairConfig;
};

/** Runs one repair and returns the note recorded against it. */
export type RepairRunner = (params: { intent: RepairIntent; messageId: string }) => Promise<string>;

type PendingEntry = {
  intent: RepairIntent;
  /** Absent until a message is delivered for this session. */
  timer?: ReturnType<typeof setTimeout>;
  /** Resolves when this entry's own window fires, or with undefined when superseded. */
  settle: (note: string | undefined) => void;
};

const pending = new Map<string, PendingEntry>();

/** Wait this long after the last delivered message before repairing. */
export const DEFAULT_SETTLE_MS = 10_000;

/**
 * A turn that never delivers anything (suppressed reply, failed send) would
 * otherwise leave its intent parked until the next turn of that session, where a
 * much later delivery could pick it up. It expires instead.
 */
export const INTENT_TTL_MS = 5 * 60 * 1000;

/** An `agent_end` that found an unbacked promise parks it here to await delivery. */
export function rememberRepairIntent(intent: RepairIntent, ttlMs = INTENT_TTL_MS): void {
  cancel(intent.sessionKey);
  const timer = setTimeout(() => cancel(intent.sessionKey), ttlMs);
  pending.set(intent.sessionKey, { intent, timer, settle: () => undefined });
}

function cancel(sessionKey: string): void {
  const entry = pending.get(sessionKey);
  if (!entry) {
    return;
  }
  clearTimeout(entry.timer);
  entry.settle(undefined);
  pending.delete(sessionKey);
}

export function forgetRepairIntent(sessionKey: string): void {
  cancel(sessionKey);
}

/**
 * A message was delivered for this session. Restart the settle window against it;
 * the promise resolves with the repair note when this call's window is the one
 * that fires, and with undefined when a later message supersedes it.
 */
export function noteDeliveredMessage(params: {
  sessionKey: string;
  messageId: string;
  run: RepairRunner;
  settleMs?: number;
}): Promise<string | undefined> {
  const entry = pending.get(params.sessionKey);
  if (!entry) {
    return Promise.resolve(undefined);
  }
  clearTimeout(entry.timer);
  entry.settle(undefined);
  const intent = entry.intent;
  return new Promise<string | undefined>((resolve) => {
    // The timer is deliberately referenced: a repair dropped because the process
    // was idle is a promise left unrepaired with nothing recording why.
    const timer = setTimeout(() => {
      pending.delete(params.sessionKey);
      void params.run({ intent, messageId: params.messageId }).then(resolve, () => {
        resolve(undefined);
      });
    }, params.settleMs ?? DEFAULT_SETTLE_MS);
    pending.set(params.sessionKey, { intent, timer, settle: resolve });
  });
}

export function resetPendingRepairsForTest(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.settle(undefined);
  }
  pending.clear();
}
