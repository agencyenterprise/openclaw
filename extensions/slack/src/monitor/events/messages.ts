import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type { SlackMessageDeletedEvent } from "../types.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

const DELETED_TS_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DELETED_TS_PRUNE_INTERVAL = 60_000; // prune at most once per minute

/**
 * In-memory cache of deleted message timestamps.
 *
 * When a user deletes and reposts a Slack message, Slack may deliver a stale
 * event for the deleted message *after* the repost is already being processed.
 * Without this cache the gateway treats the stale event as new and replies in
 * the main channel instead of threading.  By recording deleted ts values here
 * we can silently drop any late-arriving event whose ts matches a recently
 * deleted message.
 */
const deletedMessageCache = new Map<string, number>();
let lastDeletedCachePrune = 0;

function pruneDeletedMessageCache(now: number): void {
  if (now - lastDeletedCachePrune < DELETED_TS_PRUNE_INTERVAL) {
    return;
  }
  lastDeletedCachePrune = now;
  for (const [key, expiresAt] of deletedMessageCache) {
    if (expiresAt <= now) {
      deletedMessageCache.delete(key);
    }
  }
}

function cacheDeletedTs(channelId: string | undefined, deletedTs: string | undefined): void {
  if (!channelId || !deletedTs) {
    return;
  }
  const now = Date.now();
  pruneDeletedMessageCache(now);
  const key = `${channelId}:${deletedTs}`;
  deletedMessageCache.set(key, now + DELETED_TS_TTL_MS);
  console.error(`[slack-trace] deleted-cache add key=${key} size=${deletedMessageCache.size}`);
}

function isDeletedTs(channelId: string | undefined, ts: string | undefined): boolean {
  if (!channelId || !ts) {
    return false;
  }
  const now = Date.now();
  pruneDeletedMessageCache(now);
  const key = `${channelId}:${ts}`;
  const expiresAt = deletedMessageCache.get(key);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= now) {
    deletedMessageCache.delete(key);
    return false;
  }
  return true;
}

/** Exposed for testing. */
export function _resetDeletedMessageCacheForTest(): void {
  deletedMessageCache.clear();
  lastDeletedCachePrune = 0;
}

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const handleIncomingMessageEvent = async ({ event, body }: { event: unknown; body: unknown }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = event as SlackMessageEvent;
      const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
      if (subtypeHandler) {
        console.error(
          `[slack-trace] ingress source=message subtype-handler eventKind=${subtypeHandler.eventKind} channel=${message.channel} ts=${message.ts ?? "-"}`,
        );

        // Cache deleted message ts so stale events arriving after a
        // delete-and-repost are silently dropped.
        if (subtypeHandler.eventKind === "message_deleted") {
          const deleted = message as unknown as SlackMessageDeletedEvent;
          const channelId = deleted.channel;
          // Slack provides both deleted_ts and previous_message.ts — cache both
          // to be safe since the stale re-delivery may carry either value.
          const ts1 = deleted.deleted_ts;
          const ts2 = deleted.previous_message?.ts;
          cacheDeletedTs(channelId, ts1);
          if (ts2 && ts2 !== ts1) {
            cacheDeletedTs(channelId, ts2);
          }
        }

        const channelId = subtypeHandler.resolveChannelId(message);
        const ingressContext = await authorizeAndResolveSlackSystemEventContext({
          ctx,
          senderId: subtypeHandler.resolveSenderId(message),
          channelId,
          channelType: subtypeHandler.resolveChannelType(message),
          eventKind: subtypeHandler.eventKind,
        });
        if (!ingressContext) {
          return;
        }
        enqueueSystemEvent(subtypeHandler.describe(ingressContext.channelLabel), {
          sessionKey: ingressContext.sessionKey,
          contextKey: subtypeHandler.contextKey(message),
        });
        return;
      }

      // Drop stale events for messages that were recently deleted.
      if (isDeletedTs(message.channel, message.ts)) {
        console.error(
          `[slack-trace] handler drop-deleted-message ts=${message.ts ?? "-"} channel=${message.channel}`,
        );
        return;
      }

      await handleSlackMessage(message, { source: "message" });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack handler failed: ${String(err)}`));
    }
  };

  // NOTE: Slack Event Subscriptions use names like "message.channels" and
  // "message.groups" to control *which* message events are delivered, but the
  // actual event payload always arrives with `type: "message"`.  The
  // `channel_type` field ("channel" | "group" | "im" | "mpim") distinguishes
  // the source.  Bolt rejects `app.event("message.channels")` since v4.6
  // because it is a subscription label, not a valid event type.
  ctx.app.event("message", async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
    await handleIncomingMessageEvent({ event, body });
  });

  ctx.app.event("app_mention", async ({ event, body }: SlackEventMiddlewareArgs<"app_mention">) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const mention = event as SlackAppMentionEvent;

      // Skip app_mention for DMs - they're already handled by message.im event
      // This prevents duplicate processing when both message and app_mention fire for DMs
      const channelType = normalizeSlackChannelType(mention.channel_type, mention.channel);
      if (channelType === "im" || channelType === "mpim") {
        return;
      }

      // Drop stale app_mention events for messages that were recently deleted.
      if (isDeletedTs(mention.channel, mention.ts)) {
        console.error(
          `[slack-trace] handler drop-deleted-message ts=${mention.ts ?? "-"} channel=${mention.channel} source=app_mention`,
        );
        return;
      }

      await handleSlackMessage(mention as unknown as SlackMessageEvent, {
        source: "app_mention",
        wasMentioned: true,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
    }
  });
}
