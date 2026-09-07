import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue/types.js";

const STRANDED_REPLY_RETRY_MARKER = "stranded-reply-retry";
const STRANDED_REPLY_DELIVERY_FAILURE_TEXT =
  "I generated a reply but could not deliver it to this chat. Please try again.";

export function buildStrandedReplyDeliveryFailurePayload(): ReplyPayload {
  return markReplyPayloadForSourceSuppressionDelivery({
    text: STRANDED_REPLY_DELIVERY_FAILURE_TEXT,
    isError: true,
    isStatusNotice: true,
  });
}

/**
 * Auto-delivery of a stranded private final is on unless it is explicitly
 * disabled, so a missed `message(action=send)` still reaches the source channel
 * without spending a recovery turn on a re-prompt that can strand again.
 */
export function resolveAutoDeliverPrivateFinal(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.messages?.autoDeliverPrivateFinal !== false;
}

/**
 * Decides whether the stranded final is delivered directly instead of re-prompted.
 *
 * `isStrandedReply` already carries the message_tool_only, send-policy,
 * already-delivered and substantive-text guards. Heartbeat and room_event turns
 * are restated here because both own a separate fallback delivery path and must
 * never gain a second one.
 */
export function shouldAutoDeliverStrandedPrivateFinal(params: {
  cfg: OpenClawConfig | undefined;
  isStrandedReply: boolean;
  isStrandedReplyRetryRun: boolean;
  isHeartbeat: boolean;
  isRoomEvent: boolean;
}): boolean {
  if (!params.isStrandedReply || params.isStrandedReplyRetryRun) {
    return false;
  }
  if (params.isHeartbeat || params.isRoomEvent) {
    return false;
  }
  return resolveAutoDeliverPrivateFinal(params.cfg);
}

/** The assistant's own final text, delivered as the reply the model failed to send. */
export function buildAutoDeliveredPrivateFinalPayload(finalText: string): ReplyPayload {
  return markReplyPayloadForSourceSuppressionDelivery({ text: finalText });
}

function buildStrandedReplyRetryPrompt(finalText: string): string {
  return (
    `[System] Your previous reply was not delivered to the conversation because ` +
    `you did not call message(action=send). Your reply text was:\n\n` +
    `"${finalText}"\n\n` +
    `Please deliver this reply now by calling message(action=send). ` +
    `Do not add any extra commentary; just deliver the original reply.`
  );
}

/** Build the one-shot recovery followup that re-prompts message(action=send). */
export function buildStrandedReplyRetryFollowupRun(
  base: FollowupRun,
  params: {
    finalText: string;
    sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  },
): FollowupRun {
  return {
    ...base,
    prompt: buildStrandedReplyRetryPrompt(params.finalText),
    summaryLine: STRANDED_REPLY_RETRY_MARKER,
    strandedReplyRetry: true,
    disableCollectBatching: true,
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    currentInboundContext: undefined,
    // Internally generated system turn: the client turn's lifecycle (gateway cancel
    // identity) completes with the parent run. queuedLifecycle is one-shot WeakSet-tracked,
    // so a shared object would be double-owned and free cancel while the retry still runs.
    queuedLifecycle: undefined,
    run: {
      ...base.run,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      suppressNextUserMessagePersistence: true,
    },
  };
}
