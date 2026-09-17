const sealedSettlements = new WeakSet<Promise<void>>();
export const isSealedSessionSettlement = (value: Promise<unknown>): boolean =>
  sealedSettlements.has(value as Promise<void>);

/** Tracks native prompt and abort settlement through attempt cleanup. */
import type { AgentSession } from "../../sessions/index.js";

export function createEmbeddedAttemptSessionSettleTracker(
  activeSession: Pick<AgentSession, "abort">,
): {
  abortActiveSession: (reason?: unknown) => Promise<void>;
  buildAbortSettlePromise: () => Promise<void> | null;
  trackPromptSettlePromise: (promise: Promise<void> | (() => Promise<void>)) => Promise<void>;
  sealForCleanup: () => Promise<void>;
} {
  let closed = false;
  let sealed: Promise<void> | undefined;
  const inFlightPromptSettlePromises = new Set<Promise<void>>();
  const inFlightAbortSettlePromises = new Set<Promise<void>>();
  const trackSettlePromise = (
    promises: Set<Promise<void>>,
    promise: Promise<void>,
  ): Promise<void> => {
    promises.add(promise);
    void promise.then(
      () => {
        promises.delete(promise);
      },
      () => {
        promises.delete(promise);
      },
    );
    return promise;
  };

  const trackPromptSettlePromise = (
    promise: Promise<void> | (() => Promise<void>),
  ): Promise<void> => {
    if (closed) {
      if (typeof promise !== "function") void promise.catch(() => {});
      throw new Error("NATIVE_SESSION_SETTLEMENT_CLOSED");
    }
    return trackSettlePromise(
      inFlightPromptSettlePromises,
      typeof promise === "function" ? promise() : promise,
    );
  };
  const abortActiveSession = (reason?: unknown): Promise<void> => {
    if (closed) return sealed ?? Promise.resolve();
    return trackSettlePromise(
      inFlightAbortSettlePromises,
      Promise.resolve(activeSession.abort(reason)),
    );
  };
  const buildAbortSettlePromise = (): Promise<void> | null => {
    const promises = [...inFlightPromptSettlePromises, ...inFlightAbortSettlePromises];
    return promises.length === 0 ? null : Promise.allSettled(promises).then(() => undefined);
  };

  const sealForCleanup = (): Promise<void> => {
    if (sealed) return sealed;
    closed = true;
    sealed = Promise.allSettled([
      ...inFlightPromptSettlePromises,
      ...inFlightAbortSettlePromises,
    ]).then(() => undefined);
    sealedSettlements.add(sealed);
    return sealed;
  };
  return {
    sealForCleanup,
    abortActiveSession,
    buildAbortSettlePromise,
    trackPromptSettlePromise,
  };
}
