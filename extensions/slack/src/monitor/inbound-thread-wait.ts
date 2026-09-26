// Slack plugin module holds inbound posts whose thread is busy until the thread frees.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getOptionalSlackRuntime } from "../runtime.js";
import type { SlackMessageEvent } from "../types.js";

export type SlackInboundRetryCause = "claim-busy" | "session-init-conflict";

export type SlackInboundRetryState = {
  firstFailureAtMs: number;
  attempts: number;
  sessionInitConflicts: number;
};

type SlackPostCopyOptions = {
  source: "message" | "app_mention";
  wasMentioned?: boolean;
};

export type SlackHeldInboundPost = {
  message: SlackMessageEvent;
  opts: { source: SlackPostCopyOptions["source"]; wasMentioned: boolean };
  retry: SlackInboundRetryState;
  cause?: SlackInboundRetryCause;
  lastError?: string;
};

export type SlackFailedInboundPost = {
  message: SlackMessageEvent;
  opts: SlackPostCopyOptions;
  retry?: SlackInboundRetryState;
};

export type SlackHeldInboundRecord = { version: 1; post: SlackHeldInboundPost };

export type SlackHeldInboundStore = {
  register(key: string, value: SlackHeldInboundRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<ReadonlyArray<{ key: string; value: unknown }>>;
};

type SlackHeldPostRedelivery = { promise: Promise<void> } | undefined;

type ThreadWait = {
  /** Held posts in Slack timestamp order; the head is always redelivered first. */
  posts: SlackHeldInboundPost[];
  timer?: ReturnType<typeof setTimeout>;
  draining: boolean;
  /** Counts failed redeliveries so a drain stops as soon as the thread proves busy again. */
  failures: number;
};

// A busy thread is held by a turn that can run for hours, so the wait is bounded by wall
// clock rather than by an attempt count. The backoff escalates to a steady one-minute poll.
const CLAIM_BUSY_RETRY_DELAYS_MS: readonly [number, ...number[]] = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 60_000,
];
export const CLAIM_BUSY_WAIT_BUDGET_MS = 6 * 60 * 60 * 1000;
// A lost session-init compare-and-swap settles in milliseconds, so its budget stays short.
const SESSION_INIT_CONFLICT_RETRY_DELAYS_MS: readonly [number, ...number[]] = [1_000, 2_000, 4_000];
export const SLACK_HELD_INBOUND_NAMESPACE = "slack.inbound-held-posts";
const HELD_INBOUND_MAX_ENTRIES = 1_000;
const HELD_INBOUND_TTL_MS = 24 * 60 * 60 * 1000;
const ALERT_EXCERPT_MAX_CHARS = 160;

/**
 * Slack sends a `message` copy and an `app_mention` copy of one mentioned post. Keep the
 * `message` copy, which carries files and subtype, with the mention flag from either.
 */
export function mergeSlackPostCopies<T extends { opts: SlackPostCopyOptions }>(
  kept: T,
  incoming: T,
): T {
  const richer = kept.opts.source === "message" ? kept : incoming;
  return {
    ...richer,
    opts: {
      ...richer.opts,
      wasMentioned: Boolean(kept.opts.wasMentioned || incoming.opts.wasMentioned),
    },
  };
}

function compareDigits(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Slack timestamps overflow double precision, so compare their digit strings instead. */
function compareSlackTs(left = "", right = ""): number {
  const [leftSeconds = "", leftMicros = ""] = left.split(".");
  const [rightSeconds = "", rightMicros = ""] = right.split(".");
  return (
    compareDigits(leftSeconds, rightSeconds) ||
    compareDigits(leftMicros.padEnd(6, "0"), rightMicros.padEnd(6, "0"))
  );
}

function resolveSender(post: SlackHeldInboundPost): string | undefined {
  return post.message.user ?? post.message.bot_id;
}

function buildPostKey(message: SlackMessageEvent): string {
  return `${message.channel ?? ""}:${message.ts ?? ""}`;
}

function pickDelayMs(delays: readonly [number, ...number[]], failures: number): number {
  return delays[Math.min(Math.max(failures - 1, 0), delays.length - 1)] ?? delays[0];
}

function retryDelayMs(post: SlackHeldInboundPost): number {
  return post.cause === "session-init-conflict"
    ? pickDelayMs(SESSION_INIT_CONFLICT_RETRY_DELAYS_MS, post.retry.sessionInitConflicts)
    : pickDelayMs(CLAIM_BUSY_RETRY_DELAYS_MS, post.retry.attempts);
}

function isRetryBudgetSpent(post: SlackHeldInboundPost, nowMs: number): boolean {
  if (post.cause === "session-init-conflict") {
    return post.retry.sessionInitConflicts > SESSION_INIT_CONFLICT_RETRY_DELAYS_MS.length;
  }
  return nowMs - post.retry.firstFailureAtMs >= CLAIM_BUSY_WAIT_BUDGET_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseHeldInboundRecord(value: unknown): SlackHeldInboundPost | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.post)) {
    return undefined;
  }
  const { message, opts, retry, cause, lastError } = value.post;
  if (
    !isRecord(message) ||
    typeof message.channel !== "string" ||
    typeof message.ts !== "string" ||
    !isRecord(opts) ||
    (opts.source !== "message" && opts.source !== "app_mention") ||
    !isRecord(retry) ||
    ![retry.firstFailureAtMs, retry.attempts, retry.sessionInitConflicts].every(
      (field) => Number.isSafeInteger(field) && (field as number) >= 0,
    ) ||
    (cause !== undefined && cause !== "claim-busy" && cause !== "session-init-conflict") ||
    (lastError !== undefined && typeof lastError !== "string")
  ) {
    return undefined;
  }
  return {
    message: message as SlackMessageEvent,
    opts: { source: opts.source, wasMentioned: opts.wasMentioned === true },
    retry: {
      firstFailureAtMs: retry.firstFailureAtMs as number,
      attempts: retry.attempts as number,
      sessionInitConflicts: retry.sessionInitConflicts as number,
    },
    ...(cause ? { cause } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(Math.floor(ms / 60_000), 0);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/** Slack renders `<@U…>` as a live mention; escape it so an alert never pings the author. */
function escapeSlackText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function buildTextExcerpt(text: string | undefined): string {
  const flattened = (text ?? "").replace(/\s+/gu, " ").trim();
  const excerpt =
    flattened.length > ALERT_EXCERPT_MAX_CHARS
      ? `${flattened.slice(0, ALERT_EXCERPT_MAX_CHARS)}…`
      : flattened;
  return escapeSlackText(excerpt);
}

export function formatSlackInboundUndeliverableAlert(
  post: SlackHeldInboundPost,
  nowMs: number,
): string {
  const { message } = post;
  const elapsed = formatElapsed(nowMs - post.retry.firstFailureAtMs);
  return [
    `Slack inbound message undeliverable after ${elapsed}; no turn ran it and nothing was posted to its thread.`,
    `channel: ${message.channel ?? "unknown"} | ts: ${message.ts ?? "unknown"} | thread: ${message.thread_ts ?? message.ts ?? "unknown"} | user: ${message.user ?? message.bot_id ?? "unknown"}`,
    `attempts: ${post.retry.attempts} | elapsed: ${elapsed} | cause: ${post.cause ?? "held behind earlier post"} | last error: ${escapeSlackText(post.lastError ?? "none")}`,
    `text: "${buildTextExcerpt(message.text)}"`,
  ].join("\n");
}

export function openSlackHeldInboundStore(
  logError: (line: string) => void,
): SlackHeldInboundStore | undefined {
  const state = getOptionalSlackRuntime()?.state;
  if (typeof state?.openKeyedStore !== "function") {
    return undefined;
  }
  try {
    return state.openKeyedStore<SlackHeldInboundRecord>({
      namespace: SLACK_HELD_INBOUND_NAMESPACE,
      maxEntries: HELD_INBOUND_MAX_ENTRIES,
      // A full store must fail the write loudly, never evict another post's durable copy.
      overflowPolicy: "reject-new",
      defaultTtlMs: HELD_INBOUND_TTL_MS,
    });
  } catch (err) {
    logError(
      `slack held inbound store unavailable; busy-thread waits will not survive a restart: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

export type SlackInboundThreadWaitHandler = {
  buildThreadKey: (message: SlackMessageEvent) => string | null;
  /** Re-enter ingress with a held post; resolves once ingress queued or dropped it. */
  redeliver: (post: SlackHeldInboundPost) => Promise<SlackHeldPostRedelivery>;
  /** Report a post whose wait budget is spent; it is no longer held anywhere. */
  alert: (post: SlackHeldInboundPost) => Promise<void>;
  log: (line: string) => void;
  logError: (line: string) => void;
};

export type SlackInboundThreadWaits = ReturnType<typeof createSlackInboundThreadWaits>;

const SLACK_INBOUND_THREAD_WAITS_KEY = Symbol.for("openclaw.slackInboundThreadWaits");
const RESTORE_RETRY_DELAY_MS = 60_000;

function resolveThreadWaitsRegistry(): Map<string, SlackInboundThreadWaits> {
  const scope = globalThis as {
    [SLACK_INBOUND_THREAD_WAITS_KEY]?: Map<string, SlackInboundThreadWaits>;
  };
  scope[SLACK_INBOUND_THREAD_WAITS_KEY] ??= new Map();
  return scope[SLACK_INBOUND_THREAD_WAITS_KEY];
}

/**
 * One wait per account per process. A monitor restarted in-process binds its handler to the
 * existing wait instead of restoring the store a second time, so no post has two owners.
 */
export function resolveSlackInboundThreadWaits(params: {
  accountId: string;
  openStore: () => SlackHeldInboundStore | undefined;
  handler: SlackInboundThreadWaitHandler;
}): SlackInboundThreadWaits {
  const registry = resolveThreadWaitsRegistry();
  const existing = registry.get(params.accountId);
  if (existing) {
    existing.bind(params.handler);
    return existing;
  }
  const created = createSlackInboundThreadWaits({
    accountId: params.accountId,
    store: params.openStore(),
    handler: params.handler,
  });
  registry.set(params.accountId, created);
  created.restore();
  return created;
}

export function resetSlackInboundThreadWaitsForTest(): void {
  const registry = resolveThreadWaitsRegistry();
  for (const waits of registry.values()) {
    waits.dispose();
  }
  registry.clear();
}

/**
 * Holds inbound posts per thread while the thread-dispatch fence reports the thread busy.
 * Held posts redeliver in Slack timestamp order through the bound handler, which re-enters
 * ingress, and later posts for a held thread wait behind them. Held posts persist to `store`
 * so a gateway restart re-enqueues them; Slack never redelivers an event it saw acknowledged.
 */
function createSlackInboundThreadWaits(params: {
  accountId: string;
  store: SlackHeldInboundStore | undefined;
  handler: SlackInboundThreadWaitHandler;
}) {
  const { accountId, store } = params;
  let handler = params.handler;
  const waits = new Map<string, ThreadWait>();
  let storeWrites: Promise<unknown> = Promise.resolve();
  let restoring: Promise<void> | undefined;
  let restoreRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const logError = (line: string) => handler.logError(line);
  const buildStoreKey = (message: SlackMessageEvent) => `${accountId}:${buildPostKey(message)}`;

  const writeStore = (
    describe: string,
    write: (target: SlackHeldInboundStore) => Promise<unknown>,
  ): Promise<unknown> => {
    if (!store) {
      return storeWrites;
    }
    // Serialize writes so a delete can never land before the register it supersedes.
    storeWrites = storeWrites.then(() =>
      write(store).catch((err: unknown) => {
        logError(`slack held inbound store ${describe} failed: ${formatErrorMessage(err)}`);
      }),
    );
    return storeWrites;
  };

  const persist = (post: SlackHeldInboundPost) =>
    writeStore(`write for ${buildPostKey(post.message)}`, (target) =>
      target.register(buildStoreKey(post.message), { version: 1, post }),
    );

  const forget = (message: SlackMessageEvent) =>
    writeStore(`delete for ${buildPostKey(message)}`, (target) =>
      target.delete(buildStoreKey(message)),
    );

  const ensureWait = (threadKey: string): ThreadWait => {
    const existing = waits.get(threadKey);
    if (existing) {
      return existing;
    }
    const created: ThreadWait = { posts: [], draining: false, failures: 0 };
    waits.set(threadKey, created);
    return created;
  };

  const insertPost = (wait: ThreadWait, post: SlackHeldInboundPost): SlackHeldInboundPost => {
    const postKey = buildPostKey(post.message);
    const index = wait.posts.findIndex((held) => buildPostKey(held.message) === postKey);
    const held = wait.posts[index];
    if (!held) {
      wait.posts.push(post);
      wait.posts.sort((left, right) => compareSlackTs(left.message.ts, right.message.ts));
      return post;
    }
    const merged: SlackHeldInboundPost = {
      ...mergeSlackPostCopies(held, post),
      retry: {
        firstFailureAtMs: Math.min(held.retry.firstFailureAtMs, post.retry.firstFailureAtMs),
        attempts: Math.max(held.retry.attempts, post.retry.attempts),
        sessionInitConflicts: Math.max(
          held.retry.sessionInitConflicts,
          post.retry.sessionInitConflicts,
        ),
      },
      cause: post.cause ?? held.cause,
      lastError: post.lastError ?? held.lastError,
    };
    wait.posts[index] = merged;
    return merged;
  };

  const isHeld = (wait: ThreadWait, message: SlackMessageEvent) => {
    const postKey = buildPostKey(message);
    return wait.posts.some((held) => buildPostKey(held.message) === postKey);
  };

  const schedule = (threadKey: string, wait: ThreadWait) => {
    const head = wait.posts[0];
    // An armed timer is never pushed back: posts arriving behind the head must not starve it.
    if (!head || wait.draining || wait.timer || disposed) {
      return;
    }
    wait.timer = setTimeout(() => {
      wait.timer = undefined;
      void drain(threadKey, wait);
    }, retryDelayMs(head));
    wait.timer.unref?.();
  };

  /**
   * Record one failed dispatch of `post`. Returns the durable write, or the alert when the
   * post's budget is spent; either way the failure count stops any drain in progress.
   */
  const recordFailure = (
    threadKey: string,
    post: SlackHeldInboundPost,
    nowMs: number,
  ): Promise<unknown> => {
    const wait = ensureWait(threadKey);
    wait.failures += 1;
    if (!isRetryBudgetSpent(post, nowMs)) {
      const persisted = persist(insertPost(wait, post));
      schedule(threadKey, wait);
      return persisted;
    }
    if (wait.posts.length === 0 && !wait.draining) {
      waits.delete(threadKey);
    }
    // Keep the durable copy until the alert went out: a crash in between must not lose both.
    return handler
      .alert(post)
      .catch((err: unknown) => {
        logError(
          `slack inbound alert failed for ${buildPostKey(post.message)}: ${formatErrorMessage(err)}`,
        );
      })
      .then(() => forget(post.message));
  };

  const redeliverPost = async (
    threadKey: string,
    post: SlackHeldInboundPost,
  ): Promise<SlackHeldPostRedelivery> => {
    try {
      return await handler.redeliver(post);
    } catch (err) {
      const lastError = formatErrorMessage(err);
      logError(
        `slack held inbound redelivery failed for ${buildPostKey(post.message)}: ${lastError}`,
      );
      void recordFailure(
        threadKey,
        { ...post, retry: { ...post.retry, attempts: post.retry.attempts + 1 }, lastError },
        Date.now(),
      );
      return undefined;
    }
  };

  const settlePost = async (
    wait: ThreadWait,
    post: SlackHeldInboundPost,
    redelivery: SlackHeldPostRedelivery,
  ) => {
    // A failed flush reports itself through the debouncer and re-holds the post when the
    // thread is still busy; this only decides whether the persisted copy is still owed.
    await redelivery?.promise.catch(() => undefined);
    if (!isHeld(wait, post.message)) {
      await forget(post.message);
    }
  };

  /**
   * Redeliver held posts head first. Consecutive posts from one sender redeliver together so
   * the debouncer can combine them as it would have on first arrival; the drain stops as soon
   * as any redelivery finds the thread busy again, so no later post overtakes an earlier one.
   */
  async function drain(threadKey: string, wait: ThreadWait): Promise<void> {
    if (wait.draining || disposed) {
      return;
    }
    wait.draining = true;
    try {
      while (wait.posts.length > 0) {
        const failuresBefore = wait.failures;
        const head = wait.posts[0];
        const sender = head ? resolveSender(head) : undefined;
        const settlements: Promise<void>[] = [];
        while (wait.failures === failuresBefore) {
          const post = wait.posts[0];
          if (!post || resolveSender(post) !== sender) {
            break;
          }
          wait.posts.shift();
          const redelivery = await redeliverPost(threadKey, post);
          settlements.push(settlePost(wait, post, redelivery));
        }
        await Promise.all(settlements);
        if (wait.failures !== failuresBefore) {
          break;
        }
      }
    } finally {
      wait.draining = false;
      if (wait.posts.length > 0) {
        schedule(threadKey, wait);
      } else if (waits.get(threadKey) === wait) {
        waits.delete(threadKey);
      }
    }
  }

  const restoreRows = (rows: ReadonlyArray<{ key: string; value: unknown }>): number => {
    let restored = 0;
    for (const row of rows) {
      if (!row.key.startsWith(`${accountId}:`)) {
        continue;
      }
      const post = parseHeldInboundRecord(row.value);
      const threadKey = post ? buildPostThreadKey(post) : null;
      if (!post || !threadKey) {
        // Left in place for an operator to inspect; the store TTL retires it.
        logError(`slack held inbound record ${row.key} is unreadable; it was not restored`);
        continue;
      }
      insertPost(ensureWait(threadKey), post);
      restored += 1;
    }
    for (const [threadKey, wait] of waits) {
      schedule(threadKey, wait);
    }
    return restored;
  };

  const buildPostThreadKey = (post: SlackHeldInboundPost) => handler.buildThreadKey(post.message);

  const readStoredPosts = async (target: SlackHeldInboundStore): Promise<void> => {
    try {
      const restored = restoreRows(await target.entries());
      if (restored > 0) {
        handler.log(`slack inbound restored ${restored} post(s) held behind busy threads`);
      }
    } catch (err) {
      // The rows stay stored, so a later read still recovers them; new ingress keeps flowing.
      logError(
        `slack held inbound store read failed; retrying in ${RESTORE_RETRY_DELAY_MS / 1000}s: ${formatErrorMessage(err)}`,
      );
      restoreRetryTimer = setTimeout(() => {
        restoreRetryTimer = undefined;
        if (!disposed) {
          void readStoredPosts(target);
        }
      }, RESTORE_RETRY_DELAY_MS);
      restoreRetryTimer.unref?.();
    }
  };

  return {
    /** Route redelivery, alerts and logs through the most recently started monitor. */
    bind(next: SlackInboundThreadWaitHandler): void {
      handler = next;
    },

    /** Re-hold posts persisted by a previous gateway process, preserving thread order. */
    restore(): void {
      if (!store) {
        return;
      }
      restoring = readStoredPosts(store).finally(() => {
        restoring = undefined;
      });
    },

    /** Pending while posts from a previous process are being restored ahead of new ingress. */
    get restoring(): Promise<void> | undefined {
      return restoring;
    },

    /** True while an earlier post in this message's thread waits or is being redelivered. */
    isHolding(message: SlackMessageEvent): boolean {
      const threadKey = handler.buildThreadKey(message);
      return threadKey !== null && waits.has(threadKey);
    },

    /** Queue a post that arrived while its thread already holds earlier posts. */
    async holdBehind(message: SlackMessageEvent, opts: SlackPostCopyOptions): Promise<void> {
      const threadKey = handler.buildThreadKey(message);
      if (!threadKey) {
        return;
      }
      const wait = ensureWait(threadKey);
      // A post held behind another starts its wall-clock budget when it starts waiting.
      const held = insertPost(wait, {
        message,
        opts: { source: opts.source, wasMentioned: Boolean(opts.wasMentioned) },
        retry: { firstFailureAtMs: Date.now(), attempts: 0, sessionInitConflicts: 0 },
      });
      schedule(threadKey, wait);
      await persist(held);
    },

    /**
     * Hold posts whose dispatch found the thread busy. Holding happens synchronously so a drain
     * sees the failure at once; the returned promise settles after persistence and any alert
     * for a post whose budget is spent.
     */
    async holdFailed(
      failed: readonly SlackFailedInboundPost[],
      cause: SlackInboundRetryCause,
      error: unknown,
    ): Promise<void> {
      const nowMs = Date.now();
      const lastError = formatErrorMessage(error);
      const pending: Promise<unknown>[] = [];
      for (const entry of failed) {
        const prior = entry.retry ?? {
          firstFailureAtMs: nowMs,
          attempts: 0,
          sessionInitConflicts: 0,
        };
        const post: SlackHeldInboundPost = {
          message: entry.message,
          opts: { source: entry.opts.source, wasMentioned: Boolean(entry.opts.wasMentioned) },
          retry: {
            firstFailureAtMs: prior.firstFailureAtMs,
            attempts: prior.attempts + 1,
            sessionInitConflicts:
              prior.sessionInitConflicts + (cause === "session-init-conflict" ? 1 : 0),
          },
          cause,
          lastError,
        };
        const threadKey = handler.buildThreadKey(entry.message);
        pending.push(threadKey ? recordFailure(threadKey, post, nowMs) : handler.alert(post));
      }
      await Promise.all(pending);
    },

    /** Stop every timer; used when a test discards the process-level wait. */
    dispose(): void {
      disposed = true;
      clearTimeout(restoreRetryTimer);
      for (const wait of waits.values()) {
        clearTimeout(wait.timer);
        wait.posts.length = 0;
      }
      waits.clear();
    },
  };
}
