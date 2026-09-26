/**
 * Evidence a logical thread-dispatch turn collects about its own effects: the
 * native attempts it ran and the channel sends it started. A turn settles
 * TERMINAL only on this evidence; anything missing or unknown leaves UNKNOWN.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const ledgerLog = createSubsystemLogger("state/thread-dispatch");

/** How a native attempt ended. */
export type LogicalAttemptOutcome = "returned" | "threw";
/**
 * A native run admitted inside a logical owner. `outcome`: set once it returned
 * or threw. `endedReceipt`: its ended-run cleanup proof, when it carried one.
 */
type LogicalAttempt = { outcome?: LogicalAttemptOutcome; endedReceipt?: string };
const RECEIPT_PATTERN = /^[a-f0-9]{64}$/;
/**
 * A channel send started inside a logical owner. `completed`: the platform answered.
 * `not_sent`: the send never reached the platform. `unknown`: the request may have
 * reached the platform but its answer was lost.
 */
export type LogicalEffectOutcome = "completed" | "not_sent" | "unknown";
/**
 * What a send reports when it settles: an outcome, or `failed` for a send that
 * failed after it started. A failed send counts as not sent when the transport
 * requests it made were all accounted as sends of their own (at least one), and
 * as unknown otherwise.
 */
export type LogicalEffectReport = LogicalEffectOutcome | "failed";
const LOGICAL_EFFECT_REPORTS: ReadonlySet<string> = new Set<LogicalEffectReport>([
  "completed",
  "not_sent",
  "unknown",
  "failed",
]);
type LogicalEffect = {
  outcome?: LogicalEffectOutcome;
  settled: Promise<void>;
  /** Sends started while this send ran (its transport requests). */
  children: LogicalEffect[];
};
/** One registered send: record how it settled, and run the work it performs. */
export type LogicalEffectHandle = {
  settle: (report: LogicalEffectReport) => void;
  /** Runs `work` so that sends it starts are accounted as this send's requests. */
  run: <T>(work: () => T) => T;
};

export type LogicalTurnLedger = {
  /** Claim id, for log lines. */
  claimId: string;
  scopeKey: string;
  attempts: LogicalAttempt[];
  effects: LogicalEffect[];
  /** Cleared when settlement starts: no attempt is admitted after that, though sends still drain. */
  acceptingAttempts: boolean;
  /** Set once the settlement is decided; later operations run untracked. */
  sealed: boolean;
};

// The send whose work is running, so the sends it starts become its children.
const runningEffect = resolveGlobalSingleton(
  Symbol.for("openclaw.threadDispatch.runningEffect"),
  () => new AsyncLocalStorage<LogicalEffect>(),
);

// Why a channel cannot account for its sends in this process (for example the
// Slack transport could not be wrapped). Process-wide, so every loaded copy of
// this module sees it; while set, every turn settles UNKNOWN.
const accountingUnavailable = resolveGlobalSingleton(
  Symbol.for("openclaw.threadDispatch.accountingUnavailable"),
  () => ({ reasons: new Set<string>() }),
);

/** Fixed tag of the one startup error line, so health checks can grep for it. */
export const LOGICAL_ACCOUNTING_UNAVAILABLE_TAG = "LOGICAL_ACCOUNTING_UNAVAILABLE";

/**
 * Marks send accounting unavailable for the whole process until it restarts.
 * The first reason logs one error line carrying the fixed tag; a further new
 * reason is logged as a warning, and a repeated one is not logged again.
 */
export function markLogicalDispatchAccountingUnavailable(reason: string): void {
  const { reasons } = accountingUnavailable;
  if (reasons.has(reason)) {
    return;
  }
  const first = reasons.size === 0;
  reasons.add(reason);
  const line = `${LOGICAL_ACCOUNTING_UNAVAILABLE_TAG} send accounting unavailable process-wide; every logical turn in this process settles UNKNOWN until restart: reason=${reason}`;
  if (first) {
    ledgerLog.error(line);
  } else {
    ledgerLog.warn(line);
  }
}

export function createLogicalTurnLedger(claimId: string, scopeKey: string): LogicalTurnLedger {
  return { claimId, scopeKey, attempts: [], effects: [], acceptingAttempts: true, sealed: false };
}

/** Whether a native attempt or a send of the turn has not reported how it ended. */
export function ledgerHasWorkInFlight(ledger: LogicalTurnLedger): boolean {
  return (
    ledger.attempts.some((attempt) => !attempt.outcome) ||
    ledger.effects.some((effect) => !effect.outcome)
  );
}

/** Whether a new native or dispatch attempt may still join the turn. */
export function ledgerAcceptsAttempts(ledger: LogicalTurnLedger): boolean {
  return ledger.acceptingAttempts && !ledger.sealed;
}

/** What the caller does with an operation that arrives too late for the turn's settlement. */
export type LateOperationHandling = "running untracked" | "refused" | "ignored";

/**
 * Logs an operation that arrives too late: an attempt after settlement started,
 * or anything after the settlement was decided.
 */
export function warnLateOperation(
  ledger: LogicalTurnLedger,
  operation: string,
  handling: LateOperationHandling,
): void {
  ledgerLog.warn(
    `late operation for settling logical turn; ${handling}: claim=${ledger.claimId} scope=${ledger.scopeKey} operation=${operation}`,
  );
}

/** Seals the ledger: the turn's settlement is decided, whatever it is. */
export function sealLogicalTurnLedger(ledger: LogicalTurnLedger): void {
  ledger.sealed = true;
}

/** Registers one native attempt; the returned callback records how it ended, exactly once. */
export function beginLedgerAttempt(
  ledger: LogicalTurnLedger,
): (outcome: LogicalAttemptOutcome, endedReceipt: unknown) => void {
  const attempt: LogicalAttempt = {};
  ledger.attempts.push(attempt);
  return (outcome, endedReceipt) => {
    if (attempt.outcome) {
      ledgerLog.error(`native attempt ended twice: claim=${ledger.claimId}`);
      return;
    }
    attempt.outcome = outcome;
    if (endedReceipt === undefined) {
      return;
    }
    if (typeof endedReceipt !== "string" || !RECEIPT_PATTERN.test(endedReceipt)) {
      ledgerLog.error(
        `native attempt ended with a malformed cleanup receipt: claim=${ledger.claimId}`,
      );
      return;
    }
    attempt.endedReceipt = endedReceipt;
  };
}

function resolveReport(effect: LogicalEffect, report: LogicalEffectReport): LogicalEffectOutcome {
  if (report !== "failed") {
    return report;
  }
  return effect.children.length ? "not_sent" : "unknown";
}

/**
 * Registers one send; its handle records how it settled, exactly once. After the
 * seal it returns undefined: the send runs untracked.
 */
export function beginLedgerEffect(
  ledger: LogicalTurnLedger,
  operation: string,
): LogicalEffectHandle | undefined {
  if (ledger.sealed) {
    warnLateOperation(ledger, operation, "running untracked");
    return undefined;
  }
  let markSettled!: () => void;
  const effect: LogicalEffect = {
    settled: new Promise<void>((resolve) => {
      markSettled = resolve;
    }),
    children: [],
  };
  ledger.effects.push(effect);
  const parent = runningEffect.getStore();
  if (parent && ledger.effects.includes(parent)) {
    parent.children.push(effect);
  }
  // Settling never throws into the transport: bad evidence is logged and counts as unknown.
  const settle = (report: LogicalEffectReport) => {
    if (effect.outcome) {
      ledgerLog.error(
        `send settled twice: claim=${ledger.claimId} operation=${operation} report=${JSON.stringify(report)}`,
      );
      effect.outcome = "unknown";
      return;
    }
    if (!LOGICAL_EFFECT_REPORTS.has(report)) {
      const error = new Error("THREAD_DISPATCH_EFFECT_OUTCOME_INVALID");
      ledgerLog.error(
        `send settled with invalid outcome ${JSON.stringify(report)}: claim=${ledger.claimId} operation=${operation} stack=${error.stack ?? "unavailable"}`,
      );
      effect.outcome = "unknown";
    } else {
      effect.outcome = resolveReport(effect, report);
    }
    markSettled();
  };
  return { settle, run: (work) => runningEffect.run(effect, work) };
}

// How long an ended turn waits, in total, for its own in-flight sends. The clock
// starts after the host hook drain, which has no bound of its own (pre-existing).
export const LOGICAL_EFFECT_SETTLE_TIMEOUT_MS = 60_000;

/** Resolves true when every promise settled, false on timeout; rejects on abort. */
function waitSettledWithin(
  promises: Promise<unknown>[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new Error("THREAD_DISPATCH_ABORTED")));
    const timer = setTimeout(() => finish(() => resolve(false)), timeoutMs);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      settle();
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    void Promise.all(promises).then(() => finish(() => resolve(true)));
  });
}

/**
 * Waits, within one total deadline (set after the hook drain), until no send of
 * the turn is in flight; returns how many still are.
 */
async function drainLedgerEffects(
  ledger: LogicalTurnLedger,
  deadline: number,
  signal?: AbortSignal,
): Promise<number> {
  const inFlight = () => ledger.effects.filter((effect) => !effect.outcome);
  // Sends can start more sends (a delivery flushing the next one): drain until quiet.
  for (let pending = inFlight(); pending.length; pending = inFlight()) {
    const remainingMs = deadline - Date.now();
    const settled =
      remainingMs > 0 &&
      (await waitSettledWithin(
        pending.map((effect) => effect.settled),
        remainingMs,
        signal,
      ));
    if (!settled) {
      return inFlight().length;
    }
  }
  return 0;
}

/** What a TERMINAL receipt of a turn settled on its ledger commits to. */
export type LedgerSettlement = {
  attempts: string[];
  sendsCompleted: number;
  sendsNotSent: number;
};

/**
 * How the turn itself ended. `returned`: its run returned; `observedCompletion`
 * tells whether the reply path observed it complete. `threw`: its run threw.
 */
export type LogicalTurnEnd = { kind: "returned"; observedCompletion: boolean } | { kind: "threw" };

/**
 * The turn's attempt evidence, read synchronously: the ended-run receipts when
 * every attempt ended with one, or why not. A returned turn also needs its last
 * attempt to have returned (an attempt that threw counts only when a later one
 * returned, a model fallback), and, with no attempt at all, its observed
 * completion. A turn that threw needs neither: whatever it ran has ended.
 */
function readAttemptEvidence(
  ledger: LogicalTurnLedger,
  end: LogicalTurnEnd,
): { receipts: string[] } | { unknownReason: string } {
  const attempts = ledger.attempts.length;
  const running = ledger.attempts.filter((attempt) => !attempt.outcome).length;
  if (running) {
    return { unknownReason: `native-attempt-running running=${running}` };
  }
  const receipts = ledger.attempts.flatMap((attempt) =>
    attempt.endedReceipt ? [attempt.endedReceipt] : [],
  );
  if (receipts.length !== attempts) {
    return {
      unknownReason: `attempt-without-ended-run-proof attempts=${attempts} proven=${receipts.length}`,
    };
  }
  if (end.kind === "threw") {
    return { receipts };
  }
  if (ledger.attempts.at(-1)?.outcome === "threw") {
    return { unknownReason: `last-attempt-threw attempts=${attempts}` };
  }
  if (!end.observedCompletion && !attempts) {
    return { unknownReason: "no-attempt-and-no-observed-completion" };
  }
  return { receipts };
}

/**
 * Decides whether a turn may settle TERMINAL on its ledger. Every native attempt
 * must have ended and carry an ended-run cleanup proof (see readAttemptEvidence
 * for what `end` adds), every send must have a known outcome, and every channel
 * must be able to account for its sends. Attempt admission closes when
 * settlement starts, and the attempt evidence is read again after the last
 * await, right before the seal. The ledger is sealed at the decision, whatever it is.
 */
/** Seals the ledger and logs why its turn stays UNKNOWN. */
export function leaveLogicalTurnUnknown(ledger: LogicalTurnLedger, reason: string): undefined {
  ledger.sealed = true;
  ledgerLog.warn(`logical turn left UNKNOWN: claim=${ledger.claimId} reason=${reason}`);
  return undefined;
}

export async function settleLogicalTurnLedger(
  ledger: LogicalTurnLedger,
  end: LogicalTurnEnd,
  signal?: AbortSignal,
): Promise<LedgerSettlement | undefined> {
  // From here on no attempt joins the turn; its sends still drain below.
  ledger.acceptingAttempts = false;
  const leaveUnknown = (reason: string) => leaveLogicalTurnUnknown(ledger, reason);
  if (accountingUnavailable.reasons.size) {
    return leaveUnknown(
      `accounting-unavailable reasons=${[...accountingUnavailable.reasons].join(",")}`,
    );
  }
  const early = readAttemptEvidence(ledger, end);
  if ("unknownReason" in early) {
    return leaveUnknown(early.unknownReason);
  }
  const deadline = Date.now() + LOGICAL_EFFECT_SETTLE_TIMEOUT_MS;
  // Awaiting the drain yields, so a send can start after it saw quiet: drain
  // again until quiet still holds when the decision runs.
  do {
    const pending = await drainLedgerEffects(ledger, deadline, signal);
    if (pending) {
      return leaveUnknown(
        `sends-unsettled pending=${pending} waitedMs=${LOGICAL_EFFECT_SETTLE_TIMEOUT_MS}`,
      );
    }
  } while (ledger.effects.some((effect) => !effect.outcome));
  // No await from here to the seal: nothing can start between check and decision.
  // Attempts are read again: evidence must hold at the decision, not only before the drain.
  const evidence = readAttemptEvidence(ledger, end);
  if ("unknownReason" in evidence) {
    return leaveUnknown(evidence.unknownReason);
  }
  const outcomes = ledger.effects.map((effect) => effect.outcome);
  const count = (outcome: LogicalEffectOutcome) => outcomes.filter((o) => o === outcome).length;
  if (count("unknown")) {
    return leaveUnknown(
      `send-outcome-unknown unknown=${count("unknown")} sends=${outcomes.length}`,
    );
  }
  ledger.sealed = true;
  const basis =
    end.kind === "threw"
      ? "failed-turn-evidence"
      : end.observedCompletion
        ? "observed-completion"
        : "ended-run-proof";
  ledgerLog.info(
    `logical turn settled on ${basis}: claim=${ledger.claimId} attempts=${evidence.receipts.length} sendsCompleted=${count("completed")} sendsNotSent=${count("not_sent")}`,
  );
  return {
    attempts: evidence.receipts,
    sendsCompleted: count("completed"),
    sendsNotSent: count("not_sent"),
  };
}
