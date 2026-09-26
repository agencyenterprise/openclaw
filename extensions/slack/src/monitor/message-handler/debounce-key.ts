// Slack plugin module implements debounce key behavior.
import type { SlackMessageEvent } from "../../types.js";

function resolveSlackSenderId(message: SlackMessageEvent): string | null {
  return message.user ?? message.bot_id ?? null;
}

function isSlackDirectMessageChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

function isTopLevelSlackMessage(message: SlackMessageEvent): boolean {
  return !message.thread_ts && !message.parent_user_id;
}

export function buildTopLevelSlackConversationKey(
  message: SlackMessageEvent,
  accountId: string,
  teamId?: string,
): string | null {
  if (!isTopLevelSlackMessage(message)) {
    return null;
  }
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  return `slack:${accountId}:${teamId ? `${teamId}:` : ""}${message.channel}:${senderId}`;
}

function resolveSlackThreadScope(message: SlackMessageEvent): string {
  const messageTs = message.ts ?? message.event_ts;
  return message.thread_ts
    ? `${message.channel}:${message.thread_ts}`
    : message.parent_user_id && messageTs
      ? `${message.channel}:maybe-thread:${messageTs}`
      : messageTs && !isSlackDirectMessageChannel(message.channel)
        ? `${message.channel}:${messageTs}`
        : message.channel;
}

/** One key per conversation thread, shared by every sender posting in it. */
export function buildSlackThreadKey(
  message: SlackMessageEvent,
  accountId: string,
  teamId?: string,
): string | null {
  if (!message.channel) {
    return null;
  }
  return `slack:${accountId}:${teamId ? `${teamId}:` : ""}${resolveSlackThreadScope(message)}`;
}

export function buildSlackDebounceKey(
  message: SlackMessageEvent,
  accountId: string,
  teamId?: string,
): string | null {
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  return `slack:${accountId}:${teamId ? `${teamId}:` : ""}${resolveSlackThreadScope(message)}:${senderId}`;
}
