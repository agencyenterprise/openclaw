/**
 * Names the ask an outbound reply answers, in the id format the ask ledger writes.
 *
 * `routeReply` and the inbound dispatcher are the last places that still know what
 * a reply is a response to: everything below them sees a payload and a target.
 * They declare that ask id on the payload as `hookMetadata.obligationId`, so the
 * `outbound-dedupe` `message_sending` guard can reserve one answer per obligation
 * (`src/hooks/bundled/outbound-dedupe/obligation-key.ts`).
 *
 * The id must name the ONE inbound message this reply answers. The session key's
 * thread is deliberately not a fallback: a long-lived thread carries many asks
 * under one root, so a root-derived id makes every answer in that thread look
 * like a re-answer of the first one and the guard cancels it for the whole
 * dedupe window. That is exactly the 2026-09-04 mute in #fractal-ai-gateway,
 * where three asks in thread 1788473062.847669 collapsed onto
 * `C0AHSKBNDB6:1788473062.847669` and the third answer was suppressed.
 *
 * Slack only: an ask id is `<channel>:<ts>` and the ask ledger records Slack asks.
 * A reply with no identifiable ask — a cron announce, a heartbeat, the 2nd..nth
 * payload of an answer whose reply target was consumed — declares nothing and is
 * left to the content hash alone. Declaring a stand-in (the session key or its
 * thread root) would cancel later sends that answer a different ask.
 */
import {
  buildAskId,
  extractSlackChannelFromSessionKey,
  isSlackTs,
  normalizeSlackTarget,
} from "../../hooks/slack-thread.js";

const SLACK_CHANNEL_ID = "slack";

/**
 * The ts of the ask this reply answers.
 *
 * `inboundMessageId` is the message that opened this turn, which is the ask
 * itself, so it is preferred: it is unambiguous and it survives a reply
 * transport that rewrites the reply target. `replyToId` is the fallback for
 * callers below the inbound context (`routeReply`), and it must be the target
 * BEFORE threading resolution — Slack's reply transport rewrites a threaded
 * reply's target to the thread root, which is not the ask.
 */
function resolveAskTs(params: {
  inboundMessageId?: string;
  replyToId?: string;
}): string | undefined {
  if (isSlackTs(params.inboundMessageId)) {
    return params.inboundMessageId;
  }
  return isSlackTs(params.replyToId) ? params.replyToId : undefined;
}

/** The ask-ledger id of the inbound message this reply answers, when it is knowable. */
export function resolveReplyObligationId(params: {
  channelId: string;
  to: string;
  sessionKey?: string;
  replyToId?: string;
  /** Ts of the inbound message that opened this turn, when the caller knows it. */
  inboundMessageId?: string;
}): string | undefined {
  if (params.channelId !== SLACK_CHANNEL_ID) {
    return undefined;
  }
  // Same order as the ask ledger uses on the inbound side: the delivery target
  // names the channel, and the session key is the fallback.
  const channel =
    normalizeSlackTarget(params.to) ?? extractSlackChannelFromSessionKey(params.sessionKey);
  const ts = resolveAskTs(params);
  return channel && ts ? buildAskId(channel, ts) : undefined;
}
