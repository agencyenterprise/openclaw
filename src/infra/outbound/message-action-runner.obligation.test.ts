// Covers the ask a `message(action=send)` declares it answers: under
// `visibleReplies: "message_tool"` the tool send is the only answer that
// reaches Slack, so it is the send that must name the obligation the
// `outbound-dedupe` `message_sending` guard reserves.
//
// The 2026-09-04 mute in #fractal-ai-gateway: three asks arrived under one
// thread root, every answer derived its obligation from that root, and the
// third answer was cancelled as a duplicate for the whole dedupe window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { OutboundReplyPayload } from "./payload-hook-metadata.js";

const durableSendMocks = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async (..._args: unknown[]) => ({
    status: "sent" as const,
    results: [{ channel: "slack", messageId: "m1" }],
  })),
}));

vi.mock("../../channels/message/runtime.js", () => ({
  sendDurableMessageBatch: durableSendMocks.sendDurableMessageBatch,
  serializeDurableMessagePayloadOutcomes: () => undefined,
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

import { runMessageAction } from "./message-action-runner.js";

const SLACK_CHANNEL = "C0AHSKBNDB6";
const THREAD_ROOT = "1788473062.847669";
const FIRST_ASK_TS = "1788503054.588819";
const THIRD_ASK_TS = "1788503106.311259";
const SESSION_KEY = `agent:main:slack:channel:c0ahskbnbd6:thread:${THREAD_ROOT}`;

const cfg = {
  channels: {
    slack: {
      enabled: true,
    },
  },
} as OpenClawConfig;

/**
 * Mirrors the two Slack behaviours this fix depends on: `prepareSendPayload`
 * hands the payload straight to core delivery, and `resolveReplyTransport`
 * rewrites an implicit threaded reply onto the thread root.
 */
function registerSlackLikePlugin() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "slack",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn(async () => ({ channel: "slack", messageId: "m1" })),
              sendMedia: vi.fn(async () => ({ channel: "slack", messageId: "m1" })),
            },
          }),
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
          actions: {
            prepareSendPayload: ({
              ctx,
              payload,
            }: {
              ctx: { action: string };
              payload: ReplyPayload;
            }) => (ctx.action === "send" ? payload : null),
          },
          threading: {
            matchesToolContextTarget: ({
              target,
              toolContext,
            }: {
              target: string;
              toolContext?: { currentChannelId?: string; currentMessagingTarget?: string };
            }) => {
              const bare = (value?: string) =>
                value
                  ?.trim()
                  .replace(/^channel:/i, "")
                  .toUpperCase();
              const resolved = bare(target);
              return Boolean(
                resolved &&
                (resolved === bare(toolContext?.currentChannelId) ||
                  resolved === bare(toolContext?.currentMessagingTarget)),
              );
            },
            resolveReplyTransport: ({
              threadId,
              replyToId,
              replyToIsExplicit,
            }: {
              threadId?: string | number | null;
              replyToId?: string | null;
              replyToIsExplicit?: boolean;
            }) => ({
              replyToId:
                replyToIsExplicit === false
                  ? ((threadId as string | undefined) ?? replyToId ?? undefined)
                  : (replyToId ?? (threadId as string | undefined) ?? undefined),
              threadId: null,
            }),
          },
        },
      },
    ]),
  );
}

function sourceReplyToolContext(askTs: string) {
  return {
    currentChannelId: SLACK_CHANNEL,
    currentChannelProvider: "slack" as const,
    currentMessagingTarget: SLACK_CHANNEL,
    currentThreadTs: THREAD_ROOT,
    currentMessageId: askTs,
    replyToMode: "all" as const,
  };
}

function lastDurableSend(): {
  payloads: OutboundReplyPayload[];
  replyToId?: string | null;
  threadId?: string | number | null;
} {
  const call = durableSendMocks.sendDurableMessageBatch.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected a durable send");
  }
  return call[0] as never;
}

function answerAsk(params: {
  askTs?: string;
  target?: string;
  threadId?: string;
  message?: string;
}) {
  return runMessageAction({
    cfg,
    action: "send",
    sourceReplyDeliveryMode: "message_tool_only",
    sessionKey: SESSION_KEY,
    ...(params.askTs ? { toolContext: sourceReplyToolContext(params.askTs) } : {}),
    params: {
      channel: "slack",
      target: params.target ?? `channel:${SLACK_CHANNEL}`,
      message: params.message ?? "the capture is on the pod",
      ...(params.threadId ? { threadId: params.threadId } : {}),
    } as never,
  });
}

describe("message(action=send) obligation declaration", () => {
  beforeEach(() => {
    durableSendMocks.sendDurableMessageBatch.mockClear();
    registerSlackLikePlugin();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("declares the inbound ask, not the thread root, for a threaded source reply", async () => {
    await answerAsk({ askTs: THIRD_ASK_TS, threadId: THREAD_ROOT });

    const send = lastDurableSend();
    expect(send.payloads[0]?.hookMetadata?.obligationId).toBe(`${SLACK_CHANNEL}:${THIRD_ASK_TS}`);
    // The reply target the transport actually uses is still the thread root,
    // which is exactly why it cannot be what names the ask.
    expect(send.replyToId).toBe(THREAD_ROOT);
  });

  it("declares a distinct obligation for each ask under one thread root", async () => {
    await answerAsk({ askTs: FIRST_ASK_TS, threadId: THREAD_ROOT, message: "first answer" });
    const first = lastDurableSend().payloads[0]?.hookMetadata?.obligationId;
    await answerAsk({ askTs: THIRD_ASK_TS, threadId: THREAD_ROOT, message: "third answer" });
    const third = lastDurableSend().payloads[0]?.hookMetadata?.obligationId;

    expect(first).toBe(`${SLACK_CHANNEL}:${FIRST_ASK_TS}`);
    expect(third).toBe(`${SLACK_CHANNEL}:${THIRD_ASK_TS}`);
    expect(first).not.toBe(third);
  });

  it("declares nothing when the send has no identifiable ask", async () => {
    await answerAsk({ threadId: THREAD_ROOT, message: "cron announce" });

    expect(lastDurableSend().payloads[0]?.hookMetadata).toBeUndefined();
  });

  it("declares nothing when the send leaves the source conversation", async () => {
    await answerAsk({
      askTs: THIRD_ASK_TS,
      target: "channel:C0OTHERCHAN",
      message: "cross-channel note",
    });

    expect(lastDurableSend().payloads[0]?.hookMetadata).toBeUndefined();
  });
});
