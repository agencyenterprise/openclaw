/** Builds plugin hook agent context snapshots from active session and model state. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseRawSessionConversationRef } from "../sessions/session-key-utils.js";
import type { PluginHookChannelContext } from "./hook-channel-context.types.js";
import type { PluginHookAgentContext, PluginHookInboundMessageContext } from "./hook-types.js";

const TARGET_PREFIXES = new Set(["channel", "chat", "direct", "dm", "group", "thread", "user"]);

function normalizeKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function stripConversationPrefix(
  value: string | undefined,
  ...providers: Array<string | undefined>
): string | undefined {
  const text = normalizeOptionalString(value);
  if (!text) {
    return undefined;
  }

  const separatorIndex = text.indexOf(":");
  if (separatorIndex === -1) {
    return text;
  }

  const prefix = normalizeKey(text.slice(0, separatorIndex));
  const suffix = normalizeOptionalString(text.slice(separatorIndex + 1));
  if (!suffix) {
    return text;
  }
  if (
    TARGET_PREFIXES.has(prefix) ||
    providers.some((provider) => prefix === normalizeKey(provider))
  ) {
    return suffix;
  }
  return text;
}

function resolveAgentHookChannel(params: {
  messageChannel?: string | null;
  messageProvider?: string | null;
}): string | undefined {
  const messageChannel = normalizeOptionalString(params.messageChannel);
  const provider = normalizeOptionalString(params.messageProvider);
  if (!messageChannel) {
    return provider;
  }

  const separatorIndex = messageChannel.indexOf(":");
  if (separatorIndex === -1) {
    return messageChannel;
  }

  const prefix = normalizeOptionalString(messageChannel.slice(0, separatorIndex));
  if (!prefix) {
    return provider;
  }
  if (
    TARGET_PREFIXES.has(normalizeKey(prefix)) ||
    normalizeKey(prefix) === normalizeKey(provider)
  ) {
    return provider;
  }
  return prefix;
}

/** Resolves the channel id exposed to plugin agent hooks. */
function resolveAgentHookChannelId(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): string | undefined {
  const provider = normalizeOptionalString(params.messageProvider);
  const messageChannel = normalizeOptionalString(params.messageChannel);
  const parsed = parseRawSessionConversationRef(params.sessionKey);
  if (parsed?.rawId) {
    return parsed.rawId;
  }

  const metadataChannel =
    stripConversationPrefix(params.currentChannelId ?? undefined, provider, messageChannel) ??
    stripConversationPrefix(params.messageTo ?? undefined, provider, messageChannel);
  if (metadataChannel && normalizeKey(metadataChannel) !== normalizeKey(provider)) {
    return metadataChannel;
  }

  const strippedMessageChannel = stripConversationPrefix(
    params.messageChannel ?? undefined,
    provider,
    messageChannel,
  );
  if (strippedMessageChannel && normalizeKey(strippedMessageChannel) !== normalizeKey(provider)) {
    return strippedMessageChannel;
  }
  return messageChannel ?? provider;
}

/** Inbound message facts the reply pipeline attaches to a channel-originated run. */
export type AgentHookInboundMessageFields = {
  currentMessageId?: string | number | null;
  currentThreadTs?: string | null;
  messageThreadId?: string | number | null;
  senderIsBot?: boolean | null;
  inboundBody?: string | null;
};

function normalizeOptionalId(value: string | number | null | undefined): string | undefined {
  return typeof value === "number" ? String(value) : normalizeOptionalString(value);
}

/** Typed inbound-message context, or undefined when the run has no inbound message. */
export function buildAgentHookInboundMessage(
  params: AgentHookInboundMessageFields & { channelId?: string },
): PluginHookInboundMessageContext | undefined {
  const messageId = normalizeOptionalId(params.currentMessageId);
  const threadTs =
    normalizeOptionalString(params.currentThreadTs) ?? normalizeOptionalId(params.messageThreadId);
  const text = normalizeOptionalString(params.inboundBody);
  const senderIsBot = typeof params.senderIsBot === "boolean" ? params.senderIsBot : undefined;
  if (!messageId && !threadTs && !text && senderIsBot === undefined) {
    return undefined;
  }
  return {
    ...(messageId ? { messageId } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(params.channelId ? { channel: params.channelId } : {}),
    ...(senderIsBot !== undefined ? { senderIsBot } : {}),
    ...(text ? { text } : {}),
  };
}

/** Builds channel/provider fields for plugin agent hook context. */
export function buildAgentHookContextChannelFields(
  params: {
    sessionKey?: string | null;
    messageChannel?: string | null;
    messageProvider?: string | null;
    currentChannelId?: string | null;
    messageTo?: string | null;
    senderId?: string | null;
  } & AgentHookInboundMessageFields,
): Pick<
  PluginHookAgentContext,
  "channel" | "channelId" | "chatId" | "messageProvider" | "senderId" | "inboundMessage"
> {
  const channel = resolveAgentHookChannel(params);
  const channelId = resolveAgentHookChannelId(params);
  const inboundMessage = buildAgentHookInboundMessage({ ...params, channelId });
  return {
    channel,
    messageProvider: normalizeOptionalString(params.messageProvider),
    channelId,
    chatId: channelId,
    senderId: normalizeOptionalString(params.senderId),
    ...(inboundMessage ? { inboundMessage } : {}),
  };
}

export function buildAgentHookContextIdentityFields(params: {
  trigger?: string | null;
  senderId?: string | null;
  chatId?: string | null;
  channelContext?: PluginHookChannelContext;
}): Pick<PluginHookAgentContext, "senderId" | "chatId" | "channelContext"> {
  const trigger = normalizeOptionalString(params.trigger);
  if (trigger && trigger !== "user") {
    return {};
  }

  const senderId = normalizeOptionalString(params.senderId);
  const chatId = normalizeOptionalString(params.chatId);
  const sender = senderId
    ? { ...params.channelContext?.sender, id: senderId }
    : params.channelContext?.sender;
  const chat = chatId
    ? { ...params.channelContext?.chat, id: chatId }
    : params.channelContext?.chat;
  const channelContext =
    sender || chat || params.channelContext
      ? {
          ...params.channelContext,
          ...(sender ? { sender } : {}),
          ...(chat ? { chat } : {}),
        }
      : undefined;

  return {
    ...(senderId ? { senderId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(channelContext ? { channelContext } : {}),
  };
}
