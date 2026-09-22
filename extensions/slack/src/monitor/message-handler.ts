// Slack plugin module implements message handler behavior.
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { ResolvedSlackAccount } from "../accounts.js";
import { postSlackMessageBestEffort } from "../client-delivery.js";
import type { SlackSendIdentity } from "../send.js";
import type { SlackMessageEvent } from "../types.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import {
  attachSlackPreparedIngress,
  canReleaseSlackIngressSeen,
  hasSlackIngressParticipant,
  isSlackIngressAdopted,
  observeSlackIngressFailure,
  registerSlackControlUnseen,
  slackIngressHeldError,
  transferSlackIngressParticipant,
} from "./durable-adoption.js";
import type { SlackEventScope } from "./event-scope.js";
import {
  hasSlackInboundMessageDelivery,
  recordSlackInboundMessageDeliveries,
} from "./inbound-delivery-state.js";
import {
  buildSlackDebounceKey,
  buildTopLevelSlackConversationKey,
} from "./message-handler/debounce-key.js";
import { isThreadDispatchRefusal } from "./message-handler/thread-dispatch-refusal.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

const loadSlackMessagePipeline = createLazyRuntimeModule(
  () => import("./message-handler/pipeline.runtime.js"),
);

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
    relayIdentity?: SlackSendIdentity;
    /** Non-serializable listener scope for a validated enterprise event. */
    eventScope?: SlackEventScope;
    /** Wait until any inbound debounce flush and dispatch has completed. */
    awaitDispatch?: boolean;
    /** Trusted in-process reviewer continuation; bypasses only Slack ingress replay/debounce. */
    reviewerSynthetic?: boolean;
  },
) => Promise<void>;

type SlackDispatchCompletion = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type IngressSlackMessageOptions = Parameters<SlackMessageHandler>[1] & {
  retryAttempt?: number;
};

type QueuedSlackMessageOptions = IngressSlackMessageOptions & {
  dispatchCompletion?: Omit<SlackDispatchCompletion, "promise">;
};

function createSlackDispatchCompletion(): SlackDispatchCompletion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const APP_MENTION_RETRY_TTL_MS = 60_000;
const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;
const RESTART_RECOVERY_CLAIM_BUSY_MESSAGE_RE = /restart recovery claim busy for \S+/u;
// The thread-dispatch fence refuses a post while another turn owns the same thread. That turn
// ends within a normal agent turn, so the post waits on the claim-busy budget instead of dying.
const THREAD_DISPATCH_NATIVE_BUSY_MESSAGE_RE = /\bNATIVE_BUSY\b/u;
// A lost session-init compare-and-swap settles in milliseconds, so its budget stays short.
const SESSION_INIT_CONFLICT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
// A busy restart-recovery claim is held for as long as the turn that owns it runs, so this
// budget has to outlast a real agent turn (~21 minutes). Giving up while the turn is still
// running loses an inbound human message for good.
const CLAIM_BUSY_RETRY_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000,
  60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
] as const;
const UNPROCESSED_INBOUND_NOTICE_TEXT =
  "I could not process this message after repeated retries. Please resend it.";

type QueuedSlackInboundEntry = {
  message: SlackMessageEvent;
  opts: QueuedSlackMessageOptions;
};

type SlackInboundRetryCause = "claim-busy" | "session-init-conflict";

type SlackInboundRetryResult = {
  /** Entries whose retry budget is spent; each one still owes its sender an answer. */
  exhausted: readonly QueuedSlackInboundEntry[];
  retryBudget: number;
  scheduled: boolean;
};

const NO_SLACK_INBOUND_RETRY: SlackInboundRetryResult = {
  exhausted: [],
  retryBudget: 0,
  scheduled: false,
};

/**
 * Contention causes differ by how long they last, so they cannot share one retry budget.
 * Both messages are load-bearing: they are the contract this classification reads.
 */
function classifySlackInboundRetryCause(error: unknown): SlackInboundRetryCause | undefined {
  for (const candidate of collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.error,
  ])) {
    const message = formatErrorMessage(candidate);
    if (
      RESTART_RECOVERY_CLAIM_BUSY_MESSAGE_RE.test(message) ||
      THREAD_DISPATCH_NATIVE_BUSY_MESSAGE_RE.test(message)
    ) {
      return "claim-busy";
    }
    if (REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(message)) {
      return "session-init-conflict";
    }
  }
  return undefined;
}

function isRetryableSlackInboundError(error: unknown): boolean {
  return classifySlackInboundRetryCause(error) !== undefined;
}

function resolveSlackInboundRetryDelays(cause: SlackInboundRetryCause): readonly number[] {
  return cause === "claim-busy"
    ? CLAIM_BUSY_RETRY_DELAYS_MS
    : SESSION_INIT_CONFLICT_RETRY_DELAYS_MS;
}

/**
 * Last-resort signal for an inbound message that never reached a turn. An ack reaction
 * alone reads as acknowledgement, so the thread has to say it out loud.
 */
async function postUnprocessedSlackInboundNotice(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  attempts: number;
  error: unknown;
}): Promise<void> {
  const { ctx, message } = params;
  const channelId = message.channel;
  const messageTs = message.ts;
  // Log before posting so the failure is on record even if Slack rejects the notice.
  ctx.runtime.error?.(
    `slack inbound message ${channelId ?? "unknown"}/${messageTs ?? "unknown"} was not processed after ${params.attempts} retries: ${formatErrorMessage(params.error)}`,
  );
  if (!channelId || !messageTs) {
    return;
  }
  // A replay or another gateway may have run this message while the last attempt was
  // unwinding. Never claim failure for a message that something did process.
  if (
    await hasSlackInboundMessageDelivery({
      accountId: ctx.accountId,
      channelId,
      ts: messageTs,
    })
  ) {
    return;
  }
  try {
    await postSlackMessageBestEffort({
      client: ctx.app.client,
      channelId,
      text: UNPROCESSED_INBOUND_NOTICE_TEXT,
      threadTs: message.thread_ts ?? messageTs,
    });
  } catch (err) {
    ctx.runtime.error?.(
      `slack inbound unprocessed-message notice failed for ${channelId}/${messageTs}: ${formatErrorMessage(err)}`,
    );
  }
}

async function notifyUnprocessedSlackInboundEntries(params: {
  ctx: SlackMonitorContext;
  entries: readonly QueuedSlackInboundEntry[];
  attempts: number;
  error: unknown;
}): Promise<void> {
  // One notice per thread: a debounced batch is several messages in one conversation.
  const noticedThreads = new Set<string>();
  for (const entry of params.entries) {
    const { message } = entry;
    const threadKey = `${message.channel ?? ""}:${message.thread_ts ?? message.ts ?? ""}`;
    if (noticedThreads.has(threadKey)) {
      continue;
    }
    noticedThreads.add(threadKey);
    await postUnprocessedSlackInboundNotice({
      ctx: params.ctx,
      message,
      attempts: params.attempts,
      error: params.error,
    });
  }
}

function shouldDebounceSlackMessage(message: SlackMessageEvent, cfg: SlackMonitorContext["cfg"]) {
  const text = message.text ?? "";
  const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
  return shouldDebounceTextInbound({
    text: textForCommandDetection,
    cfg,
    hasMedia: Boolean(message.files && message.files.length > 0),
  });
}

function buildSeenMessageKey(
  channelId: string | undefined,
  ts: string | undefined,
  teamId?: string,
): string | null {
  if (!channelId || !ts) {
    return null;
  }
  return `${teamId ? `${teamId}:` : ""}${channelId}:${ts}`;
}

/**
 * Slack sends a `message` copy and an `app_mention` copy of one mentioned post. When both wait
 * in the same debounce window they flush together and would be read as two posts. Keep one per
 * post: the `message` copy, which carries files and subtype, with the mention flag from either.
 */
function collapseDuplicateSlackPosts(entries: QueuedSlackInboundEntry[]): QueuedSlackInboundEntry[] {
  const keptByPost = new Map<string, number>();
  const collapsed: QueuedSlackInboundEntry[] = [];
  for (const entry of entries) {
    const postKey = buildSeenMessageKey(
      entry.message.channel,
      entry.message.ts,
      entry.opts.eventScope?.teamId,
    );
    const keptIndex = postKey ? keptByPost.get(postKey) : undefined;
    if (keptIndex === undefined) {
      if (postKey) {
        keptByPost.set(postKey, collapsed.length);
      }
      collapsed.push(entry);
      continue;
    }
    const kept = collapsed[keptIndex];
    const richer = kept.opts.source === "message" ? kept : entry;
    collapsed[keptIndex] = {
      ...richer,
      opts: {
        ...richer.opts,
        wasMentioned: Boolean(kept.opts.wasMentioned || entry.opts.wasMentioned),
      },
    };
  }
  return collapsed;
}

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
  /** Called after access/routing preparation accepts a human message. */
  onPrepared?: (prepared: PreparedSlackMessage) => void;
}): SlackMessageHandler {
  const { ctx, account, trackEvent, onPrepared } = params;
  const { debounceMs, debouncer } = createChannelInboundDebouncer<QueuedSlackInboundEntry>({
    cfg: ctx.cfg,
    channel: "slack",
    buildKey: (entry) =>
      buildSlackDebounceKey(entry.message, ctx.accountId, entry.opts.eventScope?.teamId),
    shouldDebounce: (entry) =>
      !hasSlackIngressParticipant(entry.opts) &&
      !entry.opts.eventScope &&
      shouldDebounceSlackMessage(entry.message, ctx.cfg),
    onFlush: async (flushedEntries) => {
      const entries = collapseDuplicateSlackPosts(flushedEntries);
      const retryEntries = (sourceError: unknown): SlackInboundRetryResult => {
        const cause = classifySlackInboundRetryCause(sourceError);
        if (!cause || entries.some((entry) => entry.opts.eventScope)) {
          return NO_SLACK_INBOUND_RETRY;
        }
        const retryDelays = resolveSlackInboundRetryDelays(cause);
        // An entry can be out of budget while another in the same batch still has some,
        // so exhaustion is tracked per entry: a dropped one still owes its sender a reply.
        const exhausted: QueuedSlackInboundEntry[] = [];
        let priorAttempt = 0;
        const nextEntries = entries
          .map((entry) => {
            // Relay delivery owns retry until its dispatch completion is acknowledged.
            // Scheduling here as well can race the router redelivery and duplicate a reply.
            if (entry.opts.dispatchCompletion) {
              return null;
            }
            const retryAttempt = entry.opts.retryAttempt ?? 0;
            if (retryAttempt >= retryDelays.length) {
              exhausted.push(entry);
              return null;
            }
            priorAttempt = Math.max(priorAttempt, retryAttempt);
            const { dispatchCompletion: _dispatchCompletion, ...retryOpts } = entry.opts;
            return {
              ...entry,
              opts: {
                ...retryOpts,
                retryAttempt: retryAttempt + 1,
              },
            };
          })
          .filter((entry) => entry !== null);
        const result = { exhausted, retryBudget: retryDelays.length };
        if (nextEntries.length === 0) {
          return { ...result, scheduled: false };
        }
        const retryTimer = setTimeout(
          () => {
            for (const entry of nextEntries) {
              // Re-enter ingress so a relay replay or another successful attempt wins
              // through the normal delivery and seen-message gates before dispatch.
              void enqueueSlackMessage(entry.message, entry.opts).catch((err: unknown) => {
                ctx.runtime.error?.(
                  `slack inbound retry enqueue failed: ${formatErrorMessage(err)}`,
                );
              });
            }
          },
          // Escalate the wait so a long-running turn gets time to release its session claim.
          retryDelays[priorAttempt] ?? retryDelays[0],
        );
        retryTimer.unref?.();
        return { ...result, scheduled: true };
      };
      const completions = flushedEntries
        .map((entry) => entry.opts.dispatchCompletion)
        .filter((completion) => completion !== undefined);
      try {
        await (async () => {
          const last = entries.at(-1);
          if (!last) {
            return;
          }
          const teamId = last.opts.eventScope?.teamId;
          const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId, teamId);
          const topLevelConversationKey = buildTopLevelSlackConversationKey(
            last.message,
            ctx.accountId,
            teamId,
          );
          if (flushedKey && topLevelConversationKey) {
            const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
            if (pendingKeys) {
              pendingKeys.delete(flushedKey);
              if (pendingKeys.size === 0) {
                pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
              }
            }
          }
          const combinedText =
            entries.length === 1
              ? (last.message.text ?? "")
              : entries
                  .map((entry) => entry.message.text ?? "")
                  .filter(Boolean)
                  .join("\n");
          const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
          const syntheticMessage: SlackMessageEvent = {
            ...last.message,
            text: combinedText,
          };
          const seenMessageKey = buildSeenMessageKey(
            last.message.channel,
            last.message.ts,
            last.opts.eventScope?.teamId,
          );
          try {
            const { prepareSlackMessage, dispatchPreparedSlackMessage } =
              await loadSlackMessagePipeline();
            const {
              dispatchCompletion: _completion,
              awaitDispatch: _awaitDispatch,
              ...lastOpts
            } = last.opts;
            transferSlackIngressParticipant(last.opts, lastOpts);
            const appMentionRetryKey =
              seenMessageKey && lastOpts.source === "app_mention" && !ctx.botUserId
                ? seenMessageKey
                : undefined;
            if (appMentionRetryKey) {
              // Keep a concurrent message copy from recording this timestamp while the trusted
              // app_mention prepares and removes any already-recorded copy from its routed history.
              appMentionPreparingKeys.add(appMentionRetryKey);
            }
            const prepared = await (async () => {
              try {
                const result = await prepareSlackMessage({
                  ctx,
                  account,
                  message: syntheticMessage,
                  opts: {
                    ...lastOpts,
                    wasMentioned: combinedMentioned || last.opts.wasMentioned,
                    ...(seenMessageKey && lastOpts.source === "message"
                      ? {
                          shouldRecordDroppedHistory: () =>
                            !appMentionPreparingKeys.has(seenMessageKey) &&
                            !appMentionDispatchedKeys.has(seenMessageKey),
                        }
                      : {}),
                  },
                });
                if (result && seenMessageKey) {
                  pruneAppMentionRetryKeys(Date.now());
                  if (last.opts.source === "app_mention") {
                    if (messageDispatchedKeys.has(seenMessageKey)) {
                      // The message copy reached dispatch while this app_mention sat in the
                      // debouncer. Its retry allowance was consumed at the seen gate before the
                      // message copy finished preparing, so drop it here or the post runs twice.
                      messageDispatchedKeys.delete(seenMessageKey);
                      appMentionRetryKeys.delete(seenMessageKey);
                      return null;
                    }
                    // If app_mention wins the race and dispatches first, drop the later message.
                    rememberExpiringAppMentionKey(appMentionDispatchedKeys, seenMessageKey);
                  } else if (appMentionDispatchedKeys.has(seenMessageKey)) {
                    appMentionDispatchedKeys.delete(seenMessageKey);
                    appMentionRetryKeys.delete(seenMessageKey);
                    return null;
                  } else {
                    // The message copy dispatches first; a fallback app_mention that already
                    // passed the seen gate must not dispatch the same post again.
                    rememberExpiringAppMentionKey(messageDispatchedKeys, seenMessageKey);
                  }
                  appMentionRetryKeys.delete(seenMessageKey);
                }
                return result;
              } finally {
                if (appMentionRetryKey) {
                  appMentionPreparingKeys.delete(appMentionRetryKey);
                }
              }
            })();
            if (!prepared) {
              return;
            }
            if (hasSlackIngressParticipant(last.opts)) attachSlackPreparedIngress(last.opts, prepared.ctxPayload, {
              storePath: prepared.turn.storePath,
              sessionKey: prepared.route.sessionKey,
            });
            registerSlackControlUnseen(last.opts, () => {
              for (const entry of entries) {
                const key = buildSeenMessageKey(entry.message.channel, entry.message.ts, entry.opts.eventScope?.teamId);
                if (key) {
                  forgetInboundCopyArbitration(key);
                }
                ctx.releaseSeenMessage(entry.message.channel, entry.message.ts, entry.opts.eventScope);
              }
            });
            onPrepared?.(prepared);
            if (entries.length > 1) {
              const ids = entries.map((entry) => entry.message.ts).filter(Boolean) as string[];
              if (ids.length > 0) {
                prepared.ctxPayload.MessageSids = ids;
                prepared.ctxPayload.MessageSidFirst = ids[0];
                prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
              }
            }
            try {
              await dispatchPreparedSlackMessage(prepared);
              if (!hasSlackIngressParticipant(last.opts) || isSlackIngressAdopted(last.opts)) await recordSlackInboundMessageDeliveries({
                accountId: ctx.accountId,
                ...(last.opts.eventScope ? { teamId: last.opts.eventScope.teamId } : {}),
                messages: entries.map((entry) => entry.message),
              });
            } catch (error) {
              // A refused copy never ran the turn; only the copy that owns the turn may certify
              // this post as delivered, or its own retry would be discarded as a duplicate.
              if (
                !hasSlackIngressParticipant(last.opts) &&
                !isRetryableSlackInboundError(error) &&
                !isThreadDispatchRefusal(error)
              ) {
                await recordSlackInboundMessageDeliveries({
                  accountId: ctx.accountId,
                  ...(last.opts.eventScope ? { teamId: last.opts.eventScope.teamId } : {}),
                  messages: entries.map((entry) => entry.message),
                });
              }
              throw error;
            }
          } catch (error) {
            if (hasSlackIngressParticipant(last.opts)) observeSlackIngressFailure(last.opts, error);
            if ((!hasSlackIngressParticipant(last.opts) && isRetryableSlackInboundError(error)) || canReleaseSlackIngressSeen(last.opts, error)) {
              // Every buffered event passed the seen gate before this combined dispatch.
              // Release all of them so the retry can rebuild the same batch.
              for (const entry of entries) {
                const entrySeenKey = buildSeenMessageKey(
                  entry.message.channel,
                  entry.message.ts,
                  entry.opts.eventScope?.teamId,
                );
                if (entrySeenKey) {
                  forgetInboundCopyArbitration(entrySeenKey);
                }
                ctx.releaseSeenMessage(
                  entry.message.channel,
                  entry.message.ts,
                  entry.opts.eventScope,
                );
              }
            }
            throw error;
          }
        })();
        for (const completion of completions) {
          completion.resolve();
        }
      } catch (error) {
        const owned = entries.some((entry) => observeSlackIngressFailure(entry.opts, error));
        const dispatchError = owned ? slackIngressHeldError() : error;
        const retry = retryEntries(error);
        for (const completion of completions) {
          completion.reject(dispatchError);
        }
        if (retry.exhausted.length > 0) {
          // Retries are spent and no turn ever ran these messages. Say so in the thread; a
          // swapped ack reaction alone is silence that looks like acknowledgement. Relay
          // completions are already released, so a stalled notice cannot hold them.
          await notifyUnprocessedSlackInboundEntries({
            ctx,
            entries: retry.exhausted,
            attempts: retry.retryBudget,
            error,
          });
        }
        throw dispatchError;
      }
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${formatErrorMessage(err)}`);
    },
  });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
  const pendingTopLevelDebounceKeys = new Map<string, Set<string>>();
  const appMentionRetryKeys = new Map<string, number>();
  const appMentionPreparingKeys = new Set<string>();
  const appMentionDispatchedKeys = new Map<string, number>();
  const messageDispatchedKeys = new Map<string, number>();

  const pruneAppMentionRetryKeys = (rawNow: number): boolean => {
    const now = asDateTimestampMs(rawNow);
    if (now === undefined) {
      appMentionRetryKeys.clear();
      appMentionDispatchedKeys.clear();
      messageDispatchedKeys.clear();
      return false;
    }
    for (const expiringKeys of [
      appMentionRetryKeys,
      appMentionDispatchedKeys,
      messageDispatchedKeys,
    ]) {
      for (const [key, expiresAt] of expiringKeys) {
        if (asDateTimestampMs(expiresAt) === undefined || expiresAt <= now) {
          expiringKeys.delete(key);
        }
      }
    }
    return true;
  };

  const rememberExpiringAppMentionKey = (map: Map<string, number>, key: string): void => {
    const now = Date.now();
    if (!pruneAppMentionRetryKeys(now)) {
      return;
    }
    const expiresAt = resolveExpiresAtMsFromDurationMs(APP_MENTION_RETRY_TTL_MS, { nowMs: now });
    if (expiresAt !== undefined) {
      map.set(key, expiresAt);
    }
  };

  const rememberAppMentionRetryKey = (key: string) => {
    rememberExpiringAppMentionKey(appMentionRetryKeys, key);
  };

  /**
   * Forget every arbitration mark for one Slack post. Slack delivers a `message` copy and an
   * `app_mention` copy of the same post; the marks decide which copy dispatches. Once the seen
   * gate is released so a retry can rebuild the post, stale marks would drop that retry.
   */
  const forgetInboundCopyArbitration = (key: string) => {
    appMentionRetryKeys.delete(key);
    appMentionPreparingKeys.delete(key);
    appMentionDispatchedKeys.delete(key);
    messageDispatchedKeys.delete(key);
  };

  const consumeAppMentionRetryKey = (key: string) => {
    const now = Date.now();
    if (!pruneAppMentionRetryKeys(now)) {
      return false;
    }
    if (!appMentionRetryKeys.has(key)) {
      return false;
    }
    appMentionRetryKeys.delete(key);
    return true;
  };

  async function enqueueSlackMessage(
    message: SlackMessageEvent,
    opts: IngressSlackMessageOptions,
  ): Promise<SlackDispatchCompletion | undefined> {
    if (opts.source === "message" && message.type !== "message") {
      return undefined;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message" &&
      message.subtype !== "thread_broadcast"
    ) {
      return undefined;
    }
    // Record Slack's explicit type before delivery-state or thread-resolution awaits.
    // Relay and native events can overlap; a following typeless bot event must see it.
    ctx.rememberSlackChannelType(message.channel, message.channel_type, opts.eventScope);
    const seenMessageKey = buildSeenMessageKey(
      message.channel,
      message.ts,
      opts.eventScope?.teamId,
    );
    const reviewerSynthetic =
      opts.reviewerSynthetic === true && Boolean(message.openclaw_synthetic_message_id);
    if (
      !reviewerSynthetic &&
      seenMessageKey &&
      (await hasSlackInboundMessageDelivery({
        accountId: ctx.accountId,
        channelId: message.channel,
        ts: message.ts,
        ...(opts.eventScope ? { teamId: opts.eventScope.teamId } : {}),
      }))
    ) {
      return undefined;
    }
    const wasSeen =
      !reviewerSynthetic && seenMessageKey
        ? ctx.markMessageSeen(message.channel, message.ts, opts.eventScope)
        : false;
    if (!reviewerSynthetic && seenMessageKey && opts.source === "message" && !wasSeen) {
      // Prime exactly one fallback app_mention allowance immediately so a near-simultaneous
      // app_mention is not dropped while message handling is still in-flight.
      rememberAppMentionRetryKey(seenMessageKey);
    }
    if (!reviewerSynthetic && seenMessageKey && wasSeen) {
      // Allow exactly one app_mention retry if the same ts was previously dropped
      // from the message stream before it reached dispatch.
      if (opts.source !== "app_mention" || !consumeAppMentionRetryKey(seenMessageKey)) {
        return undefined;
      }
    }
    trackEvent?.();
    const resolvedMessage = await (
      opts.eventScope
        ? createSlackThreadTsResolver({ client: opts.eventScope.client })
        : threadTsResolver
    ).resolve({ message, source: opts.source });
    const teamId = opts.eventScope?.teamId;
    const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId, teamId);
    const conversationKey = buildTopLevelSlackConversationKey(
      resolvedMessage,
      ctx.accountId,
      teamId,
    );
    const canDebounce =
      !reviewerSynthetic &&
      !hasSlackIngressParticipant(opts) &&
      !opts.eventScope &&
      debounceMs > 0 &&
      shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
    if (!canDebounce && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pendingKeys && pendingKeys.size > 0) {
        const keysToFlush = Array.from(pendingKeys);
        for (const pendingKey of keysToFlush) {
          await debouncer.flushKey(pendingKey);
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? new Set<string>();
      pendingKeys.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
    }
    const dispatchCompletion = opts.awaitDispatch ? createSlackDispatchCompletion() : undefined;
    const queuedOptions: QueuedSlackMessageOptions = {
      ...opts,
      ...(dispatchCompletion
        ? {
            dispatchCompletion: {
              resolve: dispatchCompletion.resolve,
              reject: dispatchCompletion.reject,
            },
          }
        : {}),
    };
    transferSlackIngressParticipant(opts, queuedOptions);
    await debouncer.enqueue({ message: resolvedMessage, opts: queuedOptions });
    return dispatchCompletion;
  }

  return async (message, opts) => {
    const dispatchCompletion = await enqueueSlackMessage(message, opts);
    await dispatchCompletion?.promise;
  };
}
