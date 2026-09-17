/** Host-private cleanup evidence; never inferred from public result metadata. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

type Attempt = { closed: boolean; verified: boolean };
type Context = { identity: string; closed: boolean; invalid: boolean; attempts: Set<Attempt> };
const contexts = new AsyncLocalStorage<Context>();
const activeIdentities = new Set<string>();
const completedErrors = new WeakMap<object, { identity: string; receipt: string }>();
const completedResults = new WeakMap<object, { identity: string; receipt: string }>();

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
  if (context.closed) throw new Error("NATIVE_CLEANUP_OWNER_CLOSED");
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

export function beginNativeCleanupAttempt(): (verified: boolean) => void {
  const context = contexts.getStore();
  if (!context) return () => {};
  if (context.closed) throw new Error("NATIVE_CLEANUP_OWNER_CLOSED");
  const attempt: Attempt = { closed: false, verified: false };
  context.attempts.add(attempt);
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
