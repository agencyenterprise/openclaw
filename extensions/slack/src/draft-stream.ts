// Slack plugin module implements draft stream behavior.
import type { MessageMetadata } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import { createDraftStreamLoop } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { deleteSlackMessage, editSlackMessage } from "./actions.js";
import { collectHarnessReceipts, withHarnessReceiptMetadata } from "./bridge-marker.js";
import { formatSlackError } from "./errors.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import type { SlackEventScope } from "./monitor/event-scope.js";
import type { SlackSendIdentity } from "./send.js";
import { sendMessageSlack } from "./send.js";

const DEFAULT_THROTTLE_MS = 1000;

type SlackDraftStream = {
  update: (update: SlackDraftStreamUpdate) => void;
  flush: () => Promise<void>;
  clear: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => void;
  forceNewMessage: () => void;
  messageId: () => string | undefined;
  channelId: () => string | undefined;
};

type SlackDraftStreamUpdate =
  | string
  | {
      text: string;
      blocks?: (Block | KnownBlock)[];
    };

export function createSlackDraftStream(params: {
  target: string;
  cfg: OpenClawConfig;
  token: string;
  accountId?: string;
  eventScope?: SlackEventScope;
  identity?: SlackSendIdentity;
  maxChars?: number;
  throttleMs?: number;
  resolveThreadTs?: () => string | undefined;
  metadata?: MessageMetadata;
  onMessageSent?: () => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  send?: typeof sendMessageSlack;
  edit?: typeof editSlackMessage;
  remove?: typeof deleteSlackMessage;
}): SlackDraftStream {
  const maxChars = Math.min(params.maxChars ?? SLACK_TEXT_LIMIT, SLACK_TEXT_LIMIT);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const send = params.send ?? sendMessageSlack;
  const edit = params.edit ?? editSlackMessage;
  const remove = params.remove ?? deleteSlackMessage;

  let streamMessageId: string | undefined;
  let streamChannelId: string | undefined;
  let lastSentKey = "";
  let pendingUpdate: SlackDraftStreamUpdate | undefined;
  let stopped = false;
  // The metadata the preview message actually carries. chat.update replaces a
  // message's metadata instead of merging into it, so every edit has to
  // re-send everything this message is meant to keep — including the harness
  // tokens an earlier frame carried, which sendMessageSlack folded in at post
  // time (see bridge-marker.ts). A composed preview can drop a line it showed
  // before, so tokens go in as they appear and are never taken back out.
  // A new preview message starts over: it must not claim the old one's proof.
  let deliveredMetadata = params.metadata;

  const normalizeUpdate = (update: SlackDraftStreamUpdate) =>
    typeof update === "string" ? { text: update } : update;

  /** Folds this frame's harness tokens into what the message carries. */
  const recordDeliveredMetadata = (text: string, blocks?: (Block | KnownBlock)[]) => {
    deliveredMetadata = withHarnessReceiptMetadata(
      deliveredMetadata,
      collectHarnessReceipts(text, blocks),
    );
    return deliveredMetadata;
  };

  const sendOrEditStreamMessage = async (text: string) => {
    if (stopped) {
      return;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (trimmed.length > maxChars) {
      stopped = true;
      params.warn?.(`slack stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return;
    }
    const update = normalizeUpdate(pendingUpdate ?? text);
    const blocks = update.text === text ? update.blocks : undefined;
    const sentKey = `${trimmed}\n${blocks ? JSON.stringify(blocks) : ""}`;
    if (sentKey === lastSentKey) {
      return;
    }
    lastSentKey = sentKey;
    const metadata = recordDeliveredMetadata(trimmed, blocks);
    try {
      if (streamChannelId && streamMessageId) {
        await edit(streamChannelId, streamMessageId, trimmed, {
          cfg: params.cfg,
          token: params.token,
          accountId: params.accountId,
          ...(params.eventScope ? { client: params.eventScope.client } : {}),
          ...(blocks ? { blocks } : {}),
          ...(metadata ? { metadata } : {}),
        });
        return;
      }
      const sent = await send(params.target, trimmed, {
        cfg: params.cfg,
        token: params.token,
        accountId: params.accountId,
        threadTs: params.resolveThreadTs?.(),
        identity: params.identity,
        ...(params.eventScope
          ? { client: params.eventScope.client, enterpriseEventScope: params.eventScope }
          : {}),
        ...(metadata ? { metadata } : {}),
        ...(blocks ? { blocks } : {}),
      });
      streamChannelId = sent.channelId || streamChannelId;
      streamMessageId = sent.messageId || streamMessageId;
      if (!streamChannelId || !streamMessageId) {
        stopped = true;
        params.warn?.("slack stream preview stopped (missing identifiers from sendMessage)");
        return;
      }
      params.onMessageSent?.();
    } catch (err) {
      stopped = true;
      params.warn?.(`slack stream preview failed: ${formatSlackError(err)}`);
    }
  };
  const loop = createDraftStreamLoop({
    throttleMs,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  const stop = () => {
    stopped = true;
    loop.stop();
  };

  const discardPending = async () => {
    stop();
    await loop.waitForInFlight();
  };

  const clear = async () => {
    await discardPending();
    const channelId = streamChannelId;
    const messageId = streamMessageId;
    streamChannelId = undefined;
    streamMessageId = undefined;
    lastSentKey = "";
    pendingUpdate = undefined;
    deliveredMetadata = params.metadata;
    if (!channelId || !messageId) {
      return;
    }
    try {
      await remove(channelId, messageId, {
        token: params.token,
        accountId: params.accountId,
        ...(params.eventScope ? { client: params.eventScope.client } : {}),
      });
    } catch (err) {
      params.warn?.(`slack stream preview cleanup failed: ${formatSlackError(err)}`);
    }
  };

  const forceNewMessage = () => {
    streamMessageId = undefined;
    streamChannelId = undefined;
    lastSentKey = "";
    pendingUpdate = undefined;
    deliveredMetadata = params.metadata;
    loop.resetPending();
  };

  params.log?.(`slack stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update: (update: SlackDraftStreamUpdate) => {
      const normalized = normalizeUpdate(update);
      pendingUpdate = update;
      loop.update(normalized.text);
    },
    flush: loop.flush,
    clear,
    discardPending,
    seal: discardPending,
    stop,
    forceNewMessage,
    messageId: () => streamMessageId,
    channelId: () => streamChannelId,
  };
}
