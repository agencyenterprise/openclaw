/** Host-private cleanup evidence; never inferred from public result metadata. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { log } from "./logger.js";

type Attempt = { closed: boolean; verified: boolean };
type Context = { identity: string; closed: boolean; invalid: boolean; attempts: Set<Attempt> };
const contexts = new AsyncLocalStorage<Context>();
const activeIdentities = new Set<string>();
const completedErrors = new WeakMap<object, { identity: string; receipt: string }>();
const completedResults = new WeakMap<object, { identity: string; receipt: string }>();

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
    if (
      !context.invalid &&
      context.attempts.size > 0 &&
      [...context.attempts].every((a) => a.closed && a.verified)
    ) {
      completedResults.set(result, {
        identity,
        receipt: createHash("sha256")
          .update(
            JSON.stringify({
              kind: "native_cleanup_settled",
              identity,
              attempts: context.attempts.size,
            }),
          )
          .digest("hex"),
      });
    }
    return result;
  } catch (error) {
    context.closed = true;
    if (error instanceof Error) {
      completedErrors.delete(error);
      completedResults.delete(error);
    }
    if (
      error instanceof Error &&
      !context.invalid &&
      context.attempts.size > 0 &&
      [...context.attempts].every((a) => a.closed && a.verified)
    ) {
      completedErrors.set(error, {
        identity,
        receipt: createHash("sha256")
          .update(
            JSON.stringify({
              kind: "native_failed_cleanup_settled",
              identity,
              attempts: context.attempts.size,
            }),
          )
          .digest("hex"),
      });
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

export function readNativeFailedCleanupReceipt(
  result: object,
  identity: string,
): string | undefined {
  const proof = completedResults.get(result);
  const meta = (
    result as {
      meta?: {
        aborted?: boolean;
        yielded?: boolean;
        pendingToolCalls?: unknown[];
        stopReason?: string;
        error?: unknown;
      };
    }
  ).meta;
  if (
    !proof ||
    proof.identity !== identity ||
    !meta ||
    meta.yielded ||
    meta.pendingToolCalls?.length
  )
    return undefined;
  if (
    !meta.aborted &&
    !meta.error &&
    !["aborted", "timeout", "error", "restart", "rpc"].includes(meta.stopReason ?? "")
  )
    return undefined;
  return proof.receipt;
}

export function readNativeThrownCleanupReceipt(
  error: unknown,
  identity: string,
): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const proof = completedErrors.get(error);
  return proof?.identity === identity ? proof.receipt : undefined;
}
