// Memory Core plugin module implements manager async state behavior.

/**
 * How long a search waits for a dirty index refresh before querying the index it
 * already has warm.
 *
 * The refresh always runs to completion — the manager tracks it as `syncing` and
 * `close()` drains it — so the only thing a caller gives up is the freshness of one
 * query. Waiting without a bound put a full re-hash of every memory file (570 files /
 * 35 MB in production) plus the re-embedding of the delta on the prompt path, which is
 * one of the ways the memory-recall hook's retrieval deadline expired on a search that
 * itself costs ~300 ms.
 */
export const SEARCH_SYNC_WAIT_MS = 500;

/** Settle when `task` settles or when `waitMs` elapses, whichever comes first. */
function waitAtMost(task: Promise<void>, waitMs: number): Promise<void> {
  if (waitMs <= 0) {
    return Promise.resolve();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
    timer.unref?.();
  });
  return Promise.race([task, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

export async function startAsyncSearchSync(params: {
  enabled: boolean;
  dirty: boolean;
  sessionsDirty: boolean;
  sync: (params: { reason: string }) => Promise<void>;
  onError: (err: unknown) => void;
  /** Bound on the wait only; the sync itself is never cancelled. */
  waitMs?: number;
}): Promise<void> {
  if (!params.enabled || (!params.dirty && !params.sessionsDirty)) {
    return;
  }
  // Attach the error handler up front: the sync outlives this await when it is slow,
  // and a failure then must still surface instead of becoming an unhandled rejection.
  const running = params.sync({ reason: "search" }).catch((err: unknown) => {
    params.onError(err);
  });
  await waitAtMost(running, params.waitMs ?? SEARCH_SYNC_WAIT_MS);
}

export async function awaitPendingManagerWork(params: {
  pendingSync?: Promise<void> | null;
  pendingProviderInit?: Promise<void> | null;
  onError?: (err: unknown) => void;
}): Promise<void> {
  if (params.pendingSync) {
    try {
      await params.pendingSync;
    } catch (err: unknown) {
      params.onError?.(err);
    }
  }
  if (params.pendingProviderInit) {
    try {
      await params.pendingProviderInit;
    } catch (err: unknown) {
      params.onError?.(err);
    }
  }
}
