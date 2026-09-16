// Slack plugin module implements messages behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  shouldLogVerbose,
} from "openclaw/plugin-sdk/runtime-env";
import {
  asOptionalRecord as asRecord,
  normalizeOptionalString as asString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { emitSlackMessageDeletedHook } from "../../message-deleted-hook.js";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import type { SlackMonitorContext } from "../context.js";
import {
  observeSlackIngressFailure,
  slackIngressHeldError,
  withSlackIngressOptions,
} from "../durable-adoption.js";
import { resolveSlackEventScope, type SlackEventScope } from "../event-scope.js";
import { appendSlackInboundRecoveryLog } from "../inbound-recovery-log.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type { SlackMessageChangedEvent, SlackMessageDeletedEvent } from "../types.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

// Mirrors the Telegram `[telegram]` inbound logger so cross-channel journal-grep
// workflows are uniform; the `gateway/channels/slack` subsystem renders as `[slack]`.
const slackInboundLog = createSubsystemLogger("gateway/channels/slack").child("inbound");

function formatSlackInboundLogLine(params: {
  workspaceId: string;
  channelId: string;
  channelType: string;
  userId: string;
  botUserId: string;
  bodyChars: number;
}): string {
  const from = `slack:${params.workspaceId}:channel:${params.channelId}:user:${params.userId}`;
  return `Inbound app_mention ${from} -> bot:${params.botUserId} (${params.channelType}, ${params.bodyChars} chars)`;
}

/**
 * Report a Slack deletion to the internal `message:deleted` hook so ledger-style
 * consumers can tombstone the obligation the deleted message created.
 */
function emitSlackMessageDeletedForEvent(params: {
  ctx: SlackMonitorContext;
  event: SlackMessageDeletedEvent;
  channelId?: string;
  sessionKey: string;
}): void {
  const messageId = asString(params.event.deleted_ts);
  if (!params.channelId || !messageId) {
    return;
  }
  const previousMessage = params.event.previous_message;
  emitSlackMessageDeletedHook({
    sessionKey: params.sessionKey,
    channelId: params.channelId,
    accountId: params.ctx.accountId,
    messageId,
    from: asString(previousMessage?.user),
    threadId: asString(previousMessage?.thread_ts),
  });
}

type SlackAssistantMessageRecord = {
  bot_id?: unknown;
  user?: unknown;
  text?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  files?: unknown;
  attachments?: unknown;
  assistant_thread?: unknown;
  metadata?: unknown;
  blocks?: unknown;
};

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(value);
}

function isBotAuthoredEnterpriseEvent(event: { bot_id?: unknown; subtype?: unknown }): boolean {
  return Boolean(asString(event.bot_id)) || event.subtype === "bot_message";
}

function addUserCandidate(candidates: Set<string>, value: unknown, botUserId: string): void {
  const id = asString(value);
  if (!id || id === botUserId || !isSlackUserId(id)) {
    return;
  }
  candidates.add(id);
}

function collectMetadataUserCandidates(
  candidates: Set<string>,
  value: unknown,
  botUserId: string,
): void {
  const metadata = asRecord(value);
  const payload = asRecord(metadata?.event_payload);
  if (!payload) {
    return;
  }
  for (const key of ["user", "user_id", "actor_user_id", "author_user_id", "slack_user_id"]) {
    addUserCandidate(candidates, payload[key], botUserId);
  }
}

function resolveAssistantMessageChangedSender(params: {
  message?: SlackAssistantMessageRecord;
  botUserId: string;
}): string | undefined {
  const candidates = new Set<string>();
  collectMetadataUserCandidates(candidates, params.message?.metadata, params.botUserId);
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function isSelfAttributedMessageChange(params: {
  event: SlackMessageChangedEvent;
  message?: SlackAssistantMessageRecord;
  ctx: SlackMonitorContext;
}): boolean {
  const topUser = asString((params.event as SlackMessageChangedEvent & { user?: unknown }).user);
  const messageUser = asString(params.message?.user);
  const messageBotId = asString(params.message?.bot_id);
  return (
    (Boolean(params.ctx.botUserId) &&
      (topUser === params.ctx.botUserId || messageUser === params.ctx.botUserId)) ||
    (Boolean(params.ctx.botId) && messageBotId === params.ctx.botId)
  );
}

/**
 * Slack redelivers an event it never got an ack for — a reconnect after an outage,
 * or an ack timeout — with the same `ts` and `retry_attempt` >= 1. Such a delivery
 * is not its own source, so name the original message it replays.
 */
function withSlackRedeliverySource(
  message: SlackMessageEvent,
  context: AllMiddlewareArgs["context"] | undefined,
): SlackMessageEvent {
  const retryNum = context?.retryNum ?? 0;
  const sourceTs = asString(message.ts);
  if (retryNum < 1 || !sourceTs || message.openclaw_source_ts) {
    return message;
  }
  return { ...message, openclaw_source_ts: sourceTs };
}

function resolveAssistantMessageChangedInbound(params: {
  event: SlackMessageEvent;
  ctx: SlackMonitorContext;
}): SlackMessageEvent | undefined {
  if (params.event.subtype !== "message_changed") {
    return undefined;
  }
  const changed = params.event as SlackMessageChangedEvent;
  const message = asRecord(changed.message) as SlackAssistantMessageRecord | undefined;
  if (!message || !isSelfAttributedMessageChange({ event: changed, message, ctx: params.ctx })) {
    return undefined;
  }
  const channelType = normalizeSlackChannelType(
    asString((changed as SlackMessageChangedEvent & { channel_type?: unknown }).channel_type),
    changed.channel,
  );
  if (channelType !== "im") {
    return undefined;
  }
  const senderId = resolveAssistantMessageChangedSender({
    message,
    botUserId: params.ctx.botUserId,
  });
  if (!senderId) {
    if (shouldLogVerbose()) {
      logVerbose(
        `slack: assistant_app_thread message_changed in DM channel=${changed.channel} dropped: no sender resolved from metadata`,
      );
    }
    return undefined;
  }
  // An edit re-enters the pipeline under the edited message's ts; the ask it
  // answers belongs to the message that was edited.
  const inboundTs = asString(message.ts) ?? asString(changed.event_ts);
  const originalTs = asString(changed.previous_message?.ts);
  return {
    type: "message",
    channel: changed.channel ?? params.event.channel,
    channel_type: "im",
    user: senderId,
    text: asString(message.text),
    ts: inboundTs,
    ...(originalTs && originalTs !== inboundTs ? { openclaw_source_ts: originalTs } : {}),
    thread_ts: asString(message.thread_ts),
    event_ts: changed.event_ts,
    assistant_thread:
      asRecord(message.assistant_thread) ??
      asRecord(
        (changed as SlackMessageChangedEvent & { assistant_thread?: unknown }).assistant_thread,
      ),
    files: Array.isArray(message.files) ? (message.files as SlackMessageEvent["files"]) : undefined,
    attachments: Array.isArray(message.attachments)
      ? (message.attachments as SlackMessageEvent["attachments"])
      : undefined,
    blocks: Array.isArray(message.blocks)
      ? (message.blocks as SlackMessageEvent["blocks"])
      : undefined,
  };
}

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const resolveEventScope = (args: {
    body: unknown;
    context: AllMiddlewareArgs["context"];
    client: AllMiddlewareArgs["client"];
  }): SlackEventScope | null | undefined => {
    const resolved = resolveSlackEventScope({
      identity: ctx.installationIdentity,
      body: args.body,
      context: args.context,
      client: args.client,
      clientOptions: ctx.app.webClientOptions,
    });
    if (!resolved.ok) {
      logVerbose(`slack: drop event (${resolved.reason})`);
      return null;
    }
    return resolved.scope;
  };

  const handleIncomingMessageEvent = async ({
    event,
    body,
    context,
    client,
  }: {
    event: unknown;
    body: unknown;
    context: AllMiddlewareArgs["context"];
    client: AllMiddlewareArgs["client"];
  }) => {
    try {
      const eventScope = resolveEventScope({ body, context, client });
      if (eventScope === null) {
        return;
      }
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = withSlackRedeliverySource(event as SlackMessageEvent, context);
      // Subtype handlers do not enter the regular message pipeline. Observe any explicit
      // type here so edits and deletes share the same authoritative conversation cache.
      ctx.rememberSlackChannelType(message.channel, message.channel_type, eventScope);
      if (eventScope && isBotAuthoredEnterpriseEvent(message)) {
        logVerbose("slack: drop enterprise bot-authored message");
        return;
      }
      if (eventScope && message.subtype && message.subtype !== "file_share") {
        logVerbose(`slack: drop enterprise message subtype=${message.subtype}`);
        return;
      }
      const assistantChangedInbound = resolveAssistantMessageChangedInbound({
        event: message,
        ctx,
      });
      if (assistantChangedInbound) {
        await handleSlackMessage(withSlackRedeliverySource(assistantChangedInbound, context), {
          source: "message",
          ...(eventScope ? { eventScope, awaitDispatch: true } : {}),
        });
        return;
      }

      if (
        message.subtype === "message_changed" &&
        isSelfAttributedMessageChange({
          event: message as SlackMessageChangedEvent,
          message: asRecord((message as SlackMessageChangedEvent).message) as
            | SlackAssistantMessageRecord
            | undefined,
          ctx,
        })
      ) {
        return;
      }

      const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
      if (subtypeHandler) {
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
        if (subtypeHandler.subtype === "message_deleted") {
          emitSlackMessageDeletedForEvent({
            ctx,
            event: message as SlackMessageDeletedEvent,
            channelId,
            sessionKey: ingressContext.sessionKey,
          });
        }
        return;
      }

      await handleSlackMessage(
        message,
        withSlackIngressOptions(typeof event === "object" && event !== null ? event : {}, {
          source: "message" as const,
          ...(eventScope ? { eventScope, awaitDispatch: true } : {}),
        }),
      );
    } catch (err) {
      if (typeof event === "object" && event !== null && observeSlackIngressFailure(event, err)) throw slackIngressHeldError();
      ctx.runtime.error?.(danger(`slack handler failed: ${formatErrorMessage(err)}`));
    }
  };

  // NOTE: Slack Event Subscriptions use names like "message.channels" and
  // "message.groups" to control *which* message events are delivered, but the
  // actual event payload always arrives with `type: "message"`.  The
  // `channel_type` field ("channel" | "group" | "im" | "mpim") distinguishes
  // the source.  Bolt rejects `app.event("message.channels")` since v4.6
  // because it is a subscription label, not a valid event type.
  ctx.app.event(
    "message",
    async (args: SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs) => {
      await handleIncomingMessageEvent(args);
    },
  );

  ctx.app.event(
    "app_mention",
    async (args: SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      try {
        const eventScope = resolveEventScope({ body, context, client });
        if (eventScope === null) {
          return;
        }
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }

        const mention = event as SlackAppMentionEvent;
        if (eventScope && isBotAuthoredEnterpriseEvent(mention)) {
          logVerbose("slack: drop enterprise bot-authored app_mention");
          return;
        }

        // Skip app_mention for DMs - they're already handled by message.im event
        // This prevents duplicate processing when both message and app_mention fire for DMs
        const channelType = normalizeSlackChannelType(mention.channel_type, mention.channel);
        if (channelType === "im" || channelType === "mpim") {
          return;
        }

        const mentionTs = asString(mention.ts);
        if (
          mentionTs &&
          !appendSlackInboundRecoveryLog({
            channel: mention.channel,
            threadTs: asString(mention.thread_ts),
            messageTs: mentionTs,
            user: asString(mention.user),
            textLen: asString(mention.text)?.length ?? 0,
            source: "app_mention",
          })
        ) {
          slackInboundLog.warn("failed to append Slack inbound recovery record");
        }

        // Emit a per-inbound receipt before dispatch so a silently-dropped mention
        // (e.g. router consumes it without a tool call) still leaves journal evidence,
        // matching the Telegram inbound log. Runs after the DM drop above, so duplicate
        // DM app_mention events (already handled via message.im) produce no line.
        slackInboundLog.info(
          formatSlackInboundLogLine({
            workspaceId: eventScope?.teamId ?? ctx.teamId,
            channelId: mention.channel,
            channelType: channelType ?? "channel",
            userId: asString(mention.user) ?? "unknown",
            botUserId: ctx.botUserId,
            bodyChars: asString(mention.text)?.length ?? 0,
          }),
        );

        await handleSlackMessage(
          withSlackRedeliverySource(mention as unknown as SlackMessageEvent, context),
          withSlackIngressOptions(typeof event === "object" && event !== null ? event : {}, {
            source: "app_mention" as const,
            wasMentioned: true,
            ...(eventScope ? { eventScope, awaitDispatch: true } : {}),
          }),
        );
      } catch (err) {
        if (typeof event === "object" && event !== null && observeSlackIngressFailure(event, err)) throw slackIngressHeldError();
        ctx.runtime.error?.(danger(`slack mention handler failed: ${formatErrorMessage(err)}`));
      }
    },
  );
}
