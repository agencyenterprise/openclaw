/**
 * Slack-side emission of the internal `message:deleted` hook.
 *
 * Mirrors `message-sent-hook.ts`. Consumers (the ask ledger among them) use it to
 * tombstone an obligation whose source message is gone, so the bot never answers
 * a message the user already deleted.
 */
import {
  createInternalHookEvent,
  fireAndForgetHook,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";

type EmitSlackMessageDeletedHookParams = {
  /** Canonical session key the deleted message belonged to. */
  sessionKey: string;
  /** Slack channel the message was deleted from. */
  channelId: string;
  accountId?: string;
  /** Slack `ts` of the deleted message (`deleted_ts`). */
  messageId: string;
  /** Author of the deleted message, when Slack reports it. */
  from?: string;
  /** Thread the deleted message belonged to, when Slack reports it. */
  threadId?: string;
};

/** Fire the internal `message:deleted` hook for one Slack `message_deleted` event. */
export function emitSlackMessageDeletedHook(params: EmitSlackMessageDeletedHookParams): void {
  const metadata = {
    ...(params.from ? { senderId: params.from } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
  };
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent("message", "deleted", params.sessionKey, {
        channelId: "slack",
        ...(params.accountId ? { accountId: params.accountId } : {}),
        conversationId: params.channelId,
        messageId: params.messageId,
        ...(params.from ? { from: params.from } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      }),
    ),
    "slack: message:deleted internal hook failed",
  );
}
