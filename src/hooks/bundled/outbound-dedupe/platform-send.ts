/**
 * Did a `message:sent` report a message that actually landed in the channel?
 *
 * `success: true` alone does not mean it did. Several delivery paths report a
 * successful send that no reader can see, or that carries no identity at all:
 * an ephemeral slash reply answered through `response_url`, the `"suppressed"`
 * short-circuit for a silent-reply token, the `"unknown"` placeholder when the
 * provider returned no ts, the `"parent_deleted"` sentinel for a threaded answer
 * whose thread parent was gone, and the streaming acknowledgements that cover
 * several Slack chunks and therefore name no single message.
 *
 * A reservation may only be held for the full dedupe window by a send that is
 * confirmed in this sense. Anything weaker stays pending and expires, so the
 * same text sent again later is not blocked for a day by a send that never
 * reached the channel.
 */
import { isSlackTs } from "../../slack-thread.js";

const SLACK_CHANNEL_ID = "slack";

/** Provider ids that mean "no message landed", not "here is the message". */
const NON_DELIVERY_MESSAGE_IDS = new Set(["unknown", "suppressed", "parent_deleted"]);

export type PlatformSendOutcome = {
  channelId: string;
  success: boolean;
  messageId?: string;
};

export function isConfirmedPlatformSend(outcome: PlatformSendOutcome): boolean {
  if (!outcome.success) {
    return false;
  }
  const messageId = outcome.messageId?.trim();
  if (!messageId || NON_DELIVERY_MESSAGE_IDS.has(messageId)) {
    return false;
  }
  // On Slack the provider message id is the ts, so anything else is a sentinel
  // this list has not learned about yet. Other channels use opaque ids.
  return outcome.channelId === SLACK_CHANNEL_ID ? isSlackTs(messageId) : true;
}
