import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount, resolveSlackReplyToMode } from "./accounts.js";
import { normalizeSlackThreadTsCandidate } from "./thread-ts.js";

export function buildSlackThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const configuredReplyToMode = resolveSlackReplyToMode(account, params.context.ChatType);
  const hasExplicitThreadTarget = params.context.MessageThreadId != null;
  const effectiveReplyToMode = hasExplicitThreadTarget ? "all" : configuredReplyToMode;
  const messageThreadId = normalizeSlackThreadTsCandidate(params.context.MessageThreadId);
  const replyToId = normalizeSlackThreadTsCandidate(params.context.ReplyToId);
  const threadId =
    messageThreadId && replyToId && messageThreadId !== replyToId
      ? replyToId
      : (messageThreadId ?? replyToId);
  // For channel messages, To is "channel:C…" — extract the bare ID.
  // For DMs, To is "user:U…" which can't be used for reactions; fall back
  // to NativeChannelId (the raw Slack channel id, e.g. "D…").
  const currentChannelId = params.context.To?.startsWith("channel:")
    ? params.context.To.slice("channel:".length)
    : normalizeOptionalString(params.context.NativeChannelId);
  return {
    currentChannelId,
    currentThreadTs: threadId,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
  };
}
