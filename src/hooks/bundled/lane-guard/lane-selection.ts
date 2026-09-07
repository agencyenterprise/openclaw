// Which of the lanes covering a thread authorizes this work. Several active
// lanes can cover one thread — a parent lane and the run it spawned — and
// `lane.py list` sorts by lane id, so "the first lane covering the thread" is an
// alphabetical accident, not an authorization. The lane charged is the first
// candidate whose `allowed_actions` and ceiling answer for every class the
// command charges. Both the guard and the turn-gate ask this question, and they
// must never answer it differently.
//
// Being passed over is not the same as refusing. `action_not_allowed` says only
// that this lane is not scoped to the action, which is no answer about the
// thread's budget, so the next candidate is asked. EVERY other refusal — a
// ceiling, an expiry, a lane that is not active, a corrupt record, an answer
// with no code this build knows — is the thread's answer and stops the search.
// Falling through would pool the lanes' ceilings: a $10 lane and a $75 lane
// covering one thread would let it spend $85, and a narrow lane could never
// tighten a permissive one.
import type { LaneActionClass, LaneEstimateTable } from "./classify.js";
import { checkLane, LANE_ACTION_NOT_ALLOWED, type LaneCliRunner } from "./lane-cli.js";

export type LaneSelection = {
  /** The lane the verdict is about: the one that allowed every class, else the first that refused. */
  laneId: string;
  allowed: boolean;
  reason: string;
  /** Classes `lane.py` answered for with an explicit allow, which is what alwaysCancel needs. */
  allowedClasses: LaneActionClass[];
};

export type LaneSelectionParams = {
  /** Candidates in the order they were resolved; the first that allows everything wins. */
  laneIds: string[];
  actionClasses: LaneActionClass[];
  estimates: LaneEstimateTable;
  run: LaneCliRunner;
};

/**
 * What one lane answered for the whole command. `out_of_scope` is the only kind
 * that lets the search go on; `refused` and `unanswered` both stop it, for
 * different reasons — one is the thread's answer, the other is no answer at all.
 */
type LaneVerdictKind = "allowed" | "out_of_scope" | "refused" | "unanswered";

type LaneVerdict = {
  kind: LaneVerdictKind;
  reason: string;
  allowedClasses: LaneActionClass[];
};

/**
 * Ask lane.py about every class the command charges. A refusal decides this lane
 * but every class is still asked, because `alwaysCancel` turns on whether the
 * lane explicitly allowed it and a class the guard skipped has no answer to go
 * on. A check that could not run ends this lane's questioning at once — there is
 * nothing to learn from asking the rest of a CLI that just failed.
 */
async function checkEveryClass(params: LaneSelectionParams, laneId: string): Promise<LaneVerdict> {
  const reasons: string[] = [];
  const allowedClasses: LaneActionClass[] = [];
  let firstRefusal: string | undefined;
  let blocking: string | undefined;
  for (const actionClass of params.actionClasses) {
    const check = await checkLane(params.run, {
      laneId,
      action: actionClass,
      amountUsd: params.estimates[actionClass],
    });
    if (check.verdict === "unanswered") {
      return { kind: "unanswered", reason: check.reason, allowedClasses };
    }
    if (check.verdict === "allowed") {
      allowedClasses.push(actionClass);
      reasons.push(check.reason);
      continue;
    }
    firstRefusal ??= check.reason;
    if (check.code !== LANE_ACTION_NOT_ALLOWED) {
      blocking ??= check.reason;
    }
  }
  if (blocking) {
    return { kind: "refused", reason: blocking, allowedClasses };
  }
  if (firstRefusal) {
    return { kind: "out_of_scope", reason: firstRefusal, allowedClasses };
  }
  return { kind: "allowed", reason: reasons.join("; "), allowedClasses };
}

function selectionOf(laneId: string, verdict: LaneVerdict, reason = verdict.reason): LaneSelection {
  return {
    laneId,
    allowed: verdict.kind === "allowed",
    reason,
    allowedClasses: verdict.allowedClasses,
  };
}

function describePassedOver(reason: string, passedOver: string[]): string {
  return passedOver.length === 0
    ? reason
    : `${reason}; lanes passed over first, because they do not cover this action: ${passedOver.join(", ")}`;
}

/**
 * The lane to charge this work to, or undefined when no lane covers the thread
 * at all — the caller words that refusal, because this knows nothing about
 * threads. A refusal reports one lane's own reason and names the lanes passed
 * over, so it stays an actionable answer instead of a tally.
 */
export async function selectAuthorizingLane(
  params: LaneSelectionParams,
): Promise<LaneSelection | undefined> {
  const passedOver: string[] = [];
  let firstOutOfScope: LaneSelection | undefined;
  for (const laneId of params.laneIds) {
    const verdict = await checkEveryClass(params, laneId);
    if (verdict.kind === "allowed") {
      return selectionOf(laneId, verdict);
    }
    if (verdict.kind === "unanswered") {
      return selectionOf(
        laneId,
        verdict,
        `${verdict.reason}; the check on lane ${laneId} could not be run, so no other lane was tried`,
      );
    }
    if (verdict.kind === "refused") {
      return selectionOf(laneId, verdict, describePassedOver(verdict.reason, passedOver));
    }
    passedOver.push(laneId);
    firstOutOfScope ??= selectionOf(laneId, verdict);
  }
  if (!firstOutOfScope || passedOver.length === 1) {
    return firstOutOfScope;
  }
  return {
    ...firstOutOfScope,
    reason: `${firstOutOfScope.reason} (no other lane covering this thread allows it either; tried ${passedOver.join(", ")})`,
  };
}
