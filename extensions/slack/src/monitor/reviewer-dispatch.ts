/**
 * Reviewer dispatch — allows the reviewer hook to inject private feedback
 * directly into the Slack message handler pipeline, bypassing Slack's event
 * system (which does not fire events for a bot's own messages).
 *
 * The hook handler calls `dispatchReviewerFeedback()` after Fable-5 decides
 * "continue". This constructs a synthetic Slack message and runs it through
 * prepareSlackMessage → dispatchPreparedSlackMessage, so the agent picks it
 * up as a normal inbound message.
 */

import type { SlackMessageEvent } from "../types.js";
import type { SlackMessageHandler } from "./message-handler.js";

export type ReviewerDispatchFn = (params: {
  channelId: string;
  threadTs: string;
  text: string;
  syntheticMessageId?: string;
  replaceMessageTs?: string;
}) => Promise<boolean>;

const REVIEWER_DISPATCH_KEY = Symbol.for("openclaw.reviewerDispatch");

function createReviewerSyntheticMessageId(params: { channelId: string; threadTs: string }): string {
  const now = Date.now().toString(36);
  const entropy = Math.random().toString(36).slice(2, 10);
  return `reviewer:${params.channelId}:${params.threadTs}:${now}:${entropy}`;
}

/**
 * Build the synthetic Slack message used for reviewer/startup continuations.
 *
 * The synthetic event must use the real Slack thread timestamp as its message
 * timestamp. Reviewer continuations are not real Slack messages; if they use a
 * made-up message ts, downstream routing can accidentally treat that synthetic
 * ts as the session thread root and send the agent's correction top-level.
 *
 * Keep `parent_user_id` populated too. The Slack router intentionally treats
 * `thread_ts === ts` without `parent_user_id` as a top-level message, which
 * would put reviewer continuations into the channel-level session and let them
 * inherit unrelated thread state.
 *
 * The event also carries an OpenClaw-only synthetic message id. Slack routing
 * needs the real thread ts above, but inbound dedupe must see this as a fresh
 * reviewer turn rather than the original thread-root message.
 */
export function buildReviewerSyntheticMessage(
  params: {
    channelId: string;
    threadTs: string;
    text: string;
    syntheticMessageId?: string;
    replaceMessageTs?: string;
  },
  botUserId?: string,
): SlackMessageEvent {
  return {
    channel: params.channelId,
    ts: params.threadTs,
    event_ts: params.threadTs,
    thread_ts: params.threadTs,
    parent_user_id: botUserId ?? "REVIEWER",
    user: botUserId ?? "REVIEWER",
    text: params.text,
    type: "message",
    channel_type: "group",
    openclaw_synthetic_message_id:
      params.syntheticMessageId ?? createReviewerSyntheticMessageId(params),
    openclaw_replace_message_ts: params.replaceMessageTs,
  };
}

/**
 * Call from the reviewer hook handler to inject reviewer feedback into the
 * agent processing pipeline without going through Slack.
 *
 * Returns true if dispatch was successful, false otherwise.
 */
export function dispatchReviewerFeedback(params: {
  channelId: string;
  threadTs: string;
  text: string;
  syntheticMessageId?: string;
  replaceMessageTs?: string;
}): Promise<boolean> {
  const fn = (globalThis as Record<symbol, ReviewerDispatchFn | undefined>)[REVIEWER_DISPATCH_KEY];
  if (!fn) {
    console.error(
      "[reviewer-dispatch] no dispatch function registered — is the Slack provider running?",
    );
    return Promise.resolve(false);
  }
  return fn(params);
}

/**
 * Called from the Slack provider during startup to register the dispatch
 * function. The function captures the provider's ctx and account references
 * so synthetic messages go through the same pipeline as real Slack events.
 */
export function registerReviewerDispatch(fn: ReviewerDispatchFn): void {
  (globalThis as Record<symbol, ReviewerDispatchFn>)[REVIEWER_DISPATCH_KEY] = fn;
}

export function registerSlackReviewerMessageHandler(params: {
  handleSlackMessage: SlackMessageHandler;
  botUserId?: string;
  onError?: (error: unknown) => void;
}): void {
  const acceptedSyntheticIds = new Set<string>();
  registerReviewerDispatch(async (dispatchParams) => {
    const syntheticMessage = buildReviewerSyntheticMessage(dispatchParams, params.botUserId);
    const syntheticId = syntheticMessage.openclaw_synthetic_message_id;
    if (syntheticId && acceptedSyntheticIds.has(syntheticId)) {
      return true;
    }
    if (syntheticId) {
      if (acceptedSyntheticIds.size >= 512) {
        const oldest = acceptedSyntheticIds.values().next().value;
        if (oldest) {
          acceptedSyntheticIds.delete(oldest);
        }
      }
      acceptedSyntheticIds.add(syntheticId);
    }
    try {
      await params.handleSlackMessage(syntheticMessage, {
        source: "message",
        wasMentioned: true,
        reviewerSynthetic: true,
        awaitDispatch: true,
      });
      return true;
    } catch (error) {
      if (syntheticId) {
        acceptedSyntheticIds.delete(syntheticId);
      }
      params.onError?.(error);
      return false;
    }
  });
}
