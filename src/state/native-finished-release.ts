/**
 * Reopens a thread whose native claim this live process settled UNKNOWN after the
 * claim's run had ended. Without it the claim blocks every later turn in the
 * thread until the owner process dies and recoverDeadNativeOwner runs.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { inspectNativeOwner } from "./native-owner-recovery.js";

type Claim = {
  claimId: string;
  scopeKey: string;
  epoch: number;
  fingerprint: string;
  kind: string;
};
type FinishedUnknownClaim = { claim: Claim; settledAtMs: number; workInFlight?: () => boolean };

const releaseLog = createSubsystemLogger("state/thread-dispatch");
/**
 * How long a finished turn's UNKNOWN claim keeps its thread closed. The run has
 * returned or thrown and its sends had their own settle window; what this waits
 * out is a straggling late effect.
 */
export const FINISHED_UNKNOWN_RELEASE_QUIET_MS = 10 * 60_000;
const FINISHED_UNKNOWN_CLAIMS_MAX = 1024;
const finishedUnknownClaims = resolveGlobalSingleton(
  Symbol.for("openclaw.threadDispatch.finishedUnknownClaims"),
  () => new Map<string, FinishedUnknownClaim>(),
);

/** A remembered claim is bound to the fence database whose claim it is. */
function finishedClaimKey(databasePath: string, claimId: string): string {
  return JSON.stringify([realpathSync(databasePath), claimId]);
}

/** Child process claims of `claim` whose process has not ended yet. */
export function countLiveChildClaims(db: DatabaseSync, claim: Claim): number {
  const prefix = `${claim.claimId}:child:`;
  const row = db
    .prepare(
      "SELECT count(*) AS live FROM thread_dispatch_claims WHERE scope_key=? AND epoch=? AND kind='process_child' AND substr(claim_id,1,?)=? AND state IN ('STARTING','RUNNING')",
    )
    .get(claim.scopeKey, claim.epoch, prefix.length, prefix);
  return Number(row?.live);
}

/**
 * Records that this process settled `claim` UNKNOWN after its run ended.
 * `workInFlight` reports work the run started that may still be running.
 */
export function rememberFinishedUnknownClaim(
  databasePath: string,
  claim: Claim,
  workInFlight?: () => boolean,
): void {
  const key = finishedClaimKey(databasePath, claim.claimId);
  finishedUnknownClaims.delete(key);
  finishedUnknownClaims.set(key, { claim, settledAtMs: Date.now(), workInFlight });
  for (const oldest of finishedUnknownClaims.keys()) {
    if (finishedUnknownClaims.size <= FINISHED_UNKNOWN_CLAIMS_MAX) {
      break;
    }
    finishedUnknownClaims.delete(oldest);
  }
}

/**
 * Settles `row` TERMINAL when it is an UNKNOWN native claim this live process
 * settled after its run ended, it has been quiet for
 * FINISHED_UNKNOWN_RELEASE_QUIET_MS, no work it started is still in flight, and
 * none of its child processes is still running. Runs inside the caller's admission transaction.
 */
export function releaseFinishedUnknownClaim(
  db: DatabaseSync,
  databasePath: string,
  row: Record<string, unknown>,
): boolean {
  const key = finishedClaimKey(databasePath, String(row.claim_id));
  const finished = finishedUnknownClaims.get(key);
  if (
    !finished ||
    row.kind !== "native" ||
    row.state !== "UNKNOWN" ||
    row.scope_key !== finished.claim.scopeKey ||
    row.epoch !== finished.claim.epoch ||
    row.fingerprint !== finished.claim.fingerprint
  ) {
    return false;
  }
  const now = Date.now();
  if (now - finished.settledAtMs < FINISHED_UNKNOWN_RELEASE_QUIET_MS) {
    return false;
  }
  const observed = inspectNativeOwner(databasePath, finished.claim);
  if (observed.liveness !== "LIVE" || observed.owner?.pid !== process.pid) {
    return false;
  }
  if (finished.workInFlight?.() || countLiveChildClaims(db, finished.claim)) {
    return false;
  }
  const { claim, settledAtMs } = finished;
  const receipt = createHash("sha256")
    .update(
      JSON.stringify({
        schema: "fractal-native-finished-unknown-release-v1",
        claim,
        settledAtMs,
        releasedAtMs: now,
        ownerPid: process.pid,
        quietMs: FINISHED_UNKNOWN_RELEASE_QUIET_MS,
      }),
    )
    .digest("hex");
  const released = db
    .prepare(
      "UPDATE thread_dispatch_claims SET state='TERMINAL',terminal_receipt=?,updated_at_ms=? WHERE claim_id=? AND scope_key=? AND epoch=? AND fingerprint=? AND kind='native' AND state='UNKNOWN'",
    )
    .run(receipt, now, claim.claimId, claim.scopeKey, claim.epoch, claim.fingerprint);
  if (Number(released.changes) !== 1) {
    return false;
  }
  finishedUnknownClaims.delete(key);
  releaseLog.warn(
    `released UNKNOWN claim of a finished turn: claim=${claim.claimId} scope=${claim.scopeKey} quietMs=${now - settledAtMs}`,
  );
  return true;
}
