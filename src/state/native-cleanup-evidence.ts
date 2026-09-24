/**
 * Verified native cleanup, keyed by the run result it belongs to. Recording takes
 * a capability that only the first claimant of this module gets: the native
 * cleanup tracker, which claims it when it loads. Thread dispatch reads the proof
 * straight from the result it got back, so no caller-supplied callback can vouch
 * for a run. The state is private to this module (one instance per module graph).
 */

type VerifiedCleanup = Readonly<{ identity: string; receipt: string }>;
type RunMeta = {
  aborted?: boolean;
  yielded?: boolean;
  pendingToolCalls?: unknown[];
  stopReason?: string;
  timeoutPhase?: unknown;
};
/** Records a result's verified cleanup, or clears it when `receipt` is undefined. */
export type NativeCleanupRecorder = (
  result: object,
  identity: string,
  receipt: string | undefined,
) => void;

const verifiedCleanups = new WeakMap<object, VerifiedCleanup>();
let recorderClaimed = false;

function recordNativeCleanup(result: object, identity: string, receipt: string | undefined) {
  if (receipt === undefined) {
    verifiedCleanups.delete(result);
  } else {
    verifiedCleanups.set(result, Object.freeze({ identity, receipt }));
  }
}

/**
 * The recorder, for the first claimant only (the native cleanup tracker at load).
 * Any later claim gets undefined.
 */
export function claimNativeCleanupRecorder(): NativeCleanupRecorder | undefined {
  if (recorderClaimed) {
    return undefined;
  }
  recorderClaimed = true;
  return recordNativeCleanup;
}

const INTERRUPTED_STOP_REASONS: ReadonlySet<string> = new Set([
  "aborted",
  "timeout",
  "restart",
  "rpc",
]);

/**
 * Proof that a run which threw had ended in this process: its cleanup tracker
 * verified every cleanup attempt it began and saw no abort or timeout.
 */
export function readThrownCleanupProof(error: unknown, identity: string): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const verified = verifiedCleanups.get(error);
  return verified?.identity === identity ? verified.receipt : undefined;
}

/**
 * Proof that a run ended on its own in this process: its cleanup tracker verified
 * every cleanup attempt for this identity, it did not hand off (yield or pending
 * tool calls), and nothing interrupted it mid-effect (abort, timeout, restart or
 * RPC stop). An error result such as an incomplete turn still qualifies.
 */
export function readEndedCleanupProof(result: unknown, identity: string): string | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const verified = verifiedCleanups.get(result);
  const meta = (result as { meta?: RunMeta }).meta;
  if (
    verified?.identity !== identity ||
    !meta ||
    meta.yielded ||
    meta.pendingToolCalls?.length ||
    meta.aborted ||
    meta.timeoutPhase ||
    INTERRUPTED_STOP_REASONS.has(meta.stopReason ?? "")
  ) {
    return undefined;
  }
  return verified.receipt;
}
