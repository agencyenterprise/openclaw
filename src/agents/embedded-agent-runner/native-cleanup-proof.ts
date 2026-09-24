/** Host-private cleanup evidence; never inferred from public result metadata. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isAbortError } from "../../infra/abort-signal.js";
import { claimNativeCleanupRecorder } from "../../state/native-cleanup-evidence.js";
import { isTimeoutError } from "../failover-error.js";
import { log } from "./logger.js";

type Attempt = { closed: boolean; verified: boolean };
type Context = { identity: string; closed: boolean; invalid: boolean; attempts: Set<Attempt> };
const contexts = new AsyncLocalStorage<Context>();
const activeIdentities = new Set<string>();
const completedErrors = new WeakMap<object, { identity: string; receipt: string }>();
const completedResults = new WeakMap<object, { identity: string; receipt: string }>();
// Held only here: the capability to vouch for a run's ended cleanup to thread dispatch.
const recordNativeCleanup = claimNativeCleanupRecorder();

/** Opaque short id for correlating one tracked run across log lines. */
export function nativeOwnerLogId(identity: string): string {
  return identity.slice(0, 12);
}

function ownerClosedError(context: Context, site: string): Error {
  const error = new Error("NATIVE_CLEANUP_OWNER_CLOSED");
  log.warn(
    `native owner closed at ${site}: owner=${nativeOwnerLogId(context.identity)} stack=${error.stack ?? "unavailable"}`,
  );
  return error;
}

export function hasNativeCleanupTracking(): boolean {
  return contexts.getStore() !== undefined;
}

export function invalidateNativeCleanupTracking(): void {
  const context = contexts.getStore();
  if (context) context.invalid = true;
}

/** Captures the final queued callback chain after subscription removal. */
export function trackNativeCleanupDependency(promise: Promise<unknown>): void {
  const context = contexts.getStore();
  if (!context) return;
  if (context.closed) throw ownerClosedError(context, "cleanup-dependency");
  const dependency: Attempt = { closed: false, verified: false };
  context.attempts.add(dependency);
  void promise.then(
    () => {
      dependency.closed = true;
      dependency.verified = true;
    },
    () => {
      dependency.closed = true;
      context.invalid = true;
    },
  );
}

/**
 * Gate before a tracked run's first possible effect (global-lane admission).
 * `expectedIdentity` is the run's own tracking identity, or undefined for an
 * untracked run; any mismatch with the current context refuses, and a closed
 * owner refuses.
 */
export function beginNativeEffectPhase(expectedIdentity: string | undefined): void {
  const context = contexts.getStore();
  if (context?.identity !== expectedIdentity) {
    const error = new Error("NATIVE_CLEANUP_OWNER_MISMATCH");
    log.warn(
      `native owner mismatch at effect phase: expected=${expectedIdentity ? nativeOwnerLogId(expectedIdentity) : "none"} current=${context ? nativeOwnerLogId(context.identity) : "none"} stack=${error.stack ?? "unavailable"}`,
    );
    throw error;
  }
  if (!context) {
    return;
  }
  if (context.closed) {
    throw ownerClosedError(context, "effect-phase");
  }
  log.debug(`native owner effect phase entered: owner=${nativeOwnerLogId(context.identity)}`);
}

export function beginNativeCleanupAttempt(): (verified: boolean) => void {
  const context = contexts.getStore();
  if (!context) return () => {};
  if (context.closed) throw ownerClosedError(context, "cleanup-attempt");
  const attempt: Attempt = { closed: false, verified: false };
  context.attempts.add(attempt);
  log.debug(
    `native cleanup attempt begin: owner=${nativeOwnerLogId(context.identity)} attempt=${context.attempts.size}`,
  );
  return (verified) => {
    if (attempt.closed || context.closed) throw new Error("NATIVE_CLEANUP_ATTEMPT_CLOSED");
    attempt.closed = true;
    attempt.verified = verified;
  };
}

function everyCleanupVerified(context: Context): boolean {
  return !context.invalid && [...context.attempts].every((a) => a.closed && a.verified);
}

function cleanupReceipt(kind: string, context: Context): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, identity: context.identity, attempts: context.attempts.size }))
    .digest("hex");
}

/** Vouches to thread dispatch that the run returning or throwing `outcome` has ended. */
function recordEndedRun(outcome: object, identity: string, receipt: string): void {
  if (recordNativeCleanup) {
    recordNativeCleanup(outcome, identity, receipt);
  } else {
    log.error(
      `native cleanup recorder was claimed elsewhere; run carries no ended-run proof: owner=${nativeOwnerLogId(identity)}`,
    );
  }
}

/**
 * A run that threw has ended when every cleanup attempt it began was verified,
 * including a run that threw before it began any (for example a failover error
 * from auth or model setup). An abort or timeout interrupted it, so it does not
 * count, and nor does a run whose tracking was invalidated (CLI-backend dispatch).
 */
function thrownRunEnded(error: Error, context: Context): boolean {
  return everyCleanupVerified(context) && !isAbortError(error) && !isTimeoutError(error);
}

export async function withNativeCleanupTracking<T extends object>(
  identity: string,
  run: () => Promise<T>,
): Promise<T> {
  if (activeIdentities.has(identity)) throw new Error("NATIVE_CLEANUP_IDENTITY_ACTIVE");
  activeIdentities.add(identity);
  const context: Context = { identity, closed: false, invalid: false, attempts: new Set() };
  try {
    const result = await contexts.run(context, run);
    context.closed = true;
    completedResults.delete(result);
    completedErrors.delete(result);
    recordNativeCleanup?.(result, identity, undefined);
    if (context.attempts.size > 0 && everyCleanupVerified(context)) {
      const receipt = cleanupReceipt("native_cleanup_settled", context);
      completedResults.set(result, { identity, receipt });
      recordEndedRun(result, identity, receipt);
    }
    return result;
  } catch (error) {
    context.closed = true;
    if (error instanceof Error) {
      completedErrors.delete(error);
      completedResults.delete(error);
      recordNativeCleanup?.(error, identity, undefined);
      if (context.attempts.size > 0 && everyCleanupVerified(context)) {
        completedErrors.set(error, {
          identity,
          receipt: cleanupReceipt("native_failed_cleanup_settled", context),
        });
      }
      if (thrownRunEnded(error, context)) {
        recordEndedRun(error, identity, cleanupReceipt("native_thrown_run_ended", context));
      }
    }
    throw error;
  } finally {
    context.closed = true;
    activeIdentities.delete(identity);
    log.info(
      `native owner closed: owner=${nativeOwnerLogId(identity)} attempts=${context.attempts.size} invalid=${context.invalid}`,
    );
  }
}

type RunMetaView = {
  aborted?: boolean;
  yielded?: boolean;
  pendingToolCalls?: unknown[];
  stopReason?: string;
  timeoutPhase?: unknown;
  error?: unknown;
};

/** The settled-cleanup proof of a returned, non-handoff run, with its public meta. */
function readSettledRunProof(
  result: object,
  identity: string,
): { receipt: string; meta: RunMetaView } | undefined {
  const proof = completedResults.get(result);
  const meta = (result as { meta?: RunMetaView }).meta;
  if (
    !proof ||
    proof.identity !== identity ||
    !meta ||
    meta.yielded ||
    meta.pendingToolCalls?.length
  ) {
    return undefined;
  }
  return { receipt: proof.receipt, meta };
}

export function readNativeFailedCleanupReceipt(
  result: object,
  identity: string,
): string | undefined {
  const settled = readSettledRunProof(result, identity);
  if (!settled) {
    return undefined;
  }
  const { meta } = settled;
  if (
    !meta.aborted &&
    !meta.error &&
    !["aborted", "timeout", "error", "restart", "rpc"].includes(meta.stopReason ?? "")
  ) {
    return undefined;
  }
  return settled.receipt;
}

export function readNativeThrownCleanupReceipt(
  error: unknown,
  identity: string,
): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const proof = completedErrors.get(error);
  return proof?.identity === identity ? proof.receipt : undefined;
}
