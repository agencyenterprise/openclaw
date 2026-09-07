// Slack plugin module builds shared chat.postMessage payloads.
import type { MessageMetadata } from "@slack/types";
import type { Block, ChatPostMessageArguments, KnownBlock } from "@slack/web-api";
import { stripHcomBridgeHarnessText, stripHcomBridgeHarnessTextDeep } from "./bridge-marker.js";

export type SlackUnfurlOptions = {
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
};

type SlackPostThreadPayload =
  | {
      thread_ts: string;
      reply_broadcast: true;
    }
  | {
      thread_ts: string;
      reply_broadcast?: never;
    }
  | {
      thread_ts?: never;
      reply_broadcast?: never;
    };

export type SlackBasePostMessagePayload = SlackPostThreadPayload & {
  channel: string;
  text: string;
  blocks?: (Block | KnownBlock)[];
  metadata?: MessageMetadata;
  mrkdwn?: boolean;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

// Every payload built here carries accessible text even though Slack's upstream
// argument type is a union where some members do not expose `text` or `blocks`.
export type SlackPostMessagePayload = ChatPostMessageArguments & SlackBasePostMessagePayload;

function buildSlackUnfurlPayload(options?: SlackUnfurlOptions) {
  return {
    // Default unfurl_links to false so bot messages don't expand inline
    // link previews (Slack message links, URLs, etc.) unless the operator
    // explicitly opts in via `channels.slack.unfurlLinks: true`.
    unfurl_links: options?.unfurlLinks ?? false,
    ...(typeof options?.unfurlMedia === "boolean" ? { unfurl_media: options.unfurlMedia } : {}),
  };
}

export function buildSlackPostMessagePayload(params: {
  channelId: string;
  text: string;
  threadTs?: string;
  replyBroadcast?: boolean;
  blocks?: (Block | KnownBlock)[];
  metadata?: MessageMetadata;
  mrkdwn?: boolean;
  unfurl?: SlackUnfurlOptions;
}): SlackBasePostMessagePayload {
  const threadPayload =
    params.replyBroadcast && params.threadTs
      ? { thread_ts: params.threadTs, reply_broadcast: true as const }
      : params.threadTs
        ? { thread_ts: params.threadTs }
        : {};
  const unfurlPayload = buildSlackUnfurlPayload(params.unfurl);
  // Belt and braces for Constitution Article 8: no bridge bookkeeping reaches a
  // human, whichever path built this payload. The marker itself travels as
  // message metadata instead (see bridge-marker.ts).
  const text = stripHcomBridgeHarnessText(params.text);
  const blocks = params.blocks ? stripHcomBridgeHarnessTextDeep(params.blocks) : params.blocks;
  if (blocks?.length) {
    return {
      channel: params.channelId,
      text,
      blocks,
      ...(params.metadata ? { metadata: params.metadata } : {}),
      ...(typeof params.mrkdwn === "boolean" ? { mrkdwn: params.mrkdwn } : {}),
      ...threadPayload,
      ...unfurlPayload,
    };
  }
  return {
    channel: params.channelId,
    text,
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(typeof params.mrkdwn === "boolean" ? { mrkdwn: params.mrkdwn } : {}),
    ...threadPayload,
    ...unfurlPayload,
  };
}
