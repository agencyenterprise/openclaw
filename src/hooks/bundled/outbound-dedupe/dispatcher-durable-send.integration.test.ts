// The one path where `message_sending` fires twice for a single physical send:
// the inbound dispatcher fires it in `beforeDeliver`, then the channel turn's
// deliver wrapper (src/channels/turn/kernel.ts) hands the same payload to durable
// delivery, which fires it again inside `deliverOutboundPayloads`.
//
// Everything below the agent turn is real: dispatchAssembledChannelTurn ->
// dispatchReplyWithBufferedBlockDispatcher -> dispatchInboundMessageWithBufferedDispatcher
// (fire 1) -> kernel deliver wrapper -> deliverInboundReplyWithMessageSendContext
// -> sendDurableMessageBatch -> deliverOutboundPayloads (fire 2) -> the adapter.
// Only the agent turn itself is stubbed, so the payload really travels the chain
// that has to carry `hookMetadata` from one fire to the other.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queueMocks = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(async (_params: unknown) => "mock-queue-id"),
  ackDelivery: vi.fn(async () => {}),
  failDelivery: vi.fn(async () => {}),
  failDeliveryAfterPlatformSend: vi.fn(async () => {}),
  failDeliveryBeforePlatformSend: vi.fn(async () => {}),
  markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {}),
  markDeliveryPlatformSendDispatched: vi.fn(async () => {}),
  markDeliveryPlatformSendAttemptStarted: vi.fn(async () => {}),
  withActiveDeliveryClaim: vi.fn(async (_entryId: string, fn: () => Promise<unknown>) => ({
    status: "claimed",
    value: await fn(),
  })),
}));

vi.mock("../../../infra/outbound/delivery-queue.js", () => queueMocks);

const dispatchReplyFromConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../../../auto-reply/reply/dispatch-from-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../auto-reply/reply/dispatch-from-config.js")>()),
  dispatchReplyFromConfig: (...args: unknown[]) => dispatchReplyFromConfigMock(...args),
}));

import { dispatchReplyWithBufferedBlockDispatcher } from "../../../auto-reply/reply/provider-dispatcher.js";
import type { ReplyDispatcher } from "../../../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../../auto-reply/templating.js";
import type { ChannelOutboundAdapter } from "../../../channels/plugins/types.public.js";
import type { RecordInboundSession } from "../../../channels/session.types.js";
import { dispatchAssembledChannelTurn } from "../../../channels/turn/kernel.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { registerCoreHook, resetCoreHooksForTest } from "../../../plugins/core-hooks.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { clearInternalHooks, registerInternalHook } from "../../internal-hooks.js";
import { createOutboundSentRecorder, DEFAULT_OUTBOUND_DEDUPE_CONFIG } from "./guard.js";
import { createOutboundDedupeHandler, registerOutboundDedupeGuard } from "./handler.js";

const cfg = {} as OpenClawConfig;
const SLACK_CHANNEL = "C0A3C98HS48";
const TARGET = `channel:${SLACK_CHANNEL}`;
const ASK_TS = "1788479206.951729";
const OBLIGATION_ID = `${SLACK_CHANNEL}:${ASK_TS}`;
const ANSWER = "The ARP capture is on the pod under /workspace/captures, 41 MB.";
const PARAPHRASE = "You will find the capture at /workspace/captures on the pod (41 MB).";
/** The run that was handed the ask, and the second run that answered it again. */
const FIRST_RUN = `agent:main:slack:channel:c0a3c98hs48:thread:${ASK_TS}`;
const SECOND_RUN = `agent:main:slack:channel:c0a3c98hs48:thread:1788479558.561999`;

type ObservedSend = { content: string; metadata?: Record<string, unknown> };

let workspaceDir = "";
let sendText: ReturnType<typeof vi.fn>;
let observed: ObservedSend[];

function ctxFor(sessionKey: string): FinalizedMsgContext {
  return {
    Body: "where is the capture?",
    RawBody: "where is the capture?",
    CommandBody: "where is the capture?",
    From: "U0SENDER",
    To: TARGET,
    OriginatingTo: TARGET,
    OriginatingChannel: "slack",
    Provider: "slack",
    Surface: "slack",
    AccountId: "acct-1",
    SessionKey: sessionKey,
  } as FinalizedMsgContext;
}

/** One inbound turn whose agent answers with `text`, delivered durably. */
async function runTurn(params: { sessionKey: string; text: string }) {
  dispatchReplyFromConfigMock.mockImplementationOnce(
    async (args: { dispatcher: ReplyDispatcher }) => {
      args.dispatcher.sendFinalReply({ text: params.text, replyToId: ASK_TS });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    },
  );
  return await dispatchAssembledChannelTurn({
    cfg,
    channel: "slack",
    accountId: "acct-1",
    agentId: "main",
    routeSessionKey: params.sessionKey,
    storePath: path.join(workspaceDir, "sessions.json"),
    ctxPayload: ctxFor(params.sessionKey),
    recordInboundSession: vi.fn(async () => {}) as unknown as RecordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      // Durable delivery handles every final here; a fallback send would mean the
      // overlap under test never happened, so make that loud instead of silent.
      deliver: () => {
        throw new Error("expected durable delivery to handle the final reply");
      },
      durable: () => ({ to: TARGET, requiredCapabilities: {} }),
    },
  });
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-dedupe-dispatcher-"));
  observed = [];
  // Registered before the guard so it still records the event when the guard
  // cancels: a cancel is terminal for the handlers after it.
  registerCoreHook({
    pluginId: "test-message-sending-observer",
    hookName: "message_sending",
    handler: (event) => {
      observed.push({ content: event.content, metadata: event.metadata });
    },
  });
  const deps = {
    resolveWorkspaceDir: () => workspaceDir,
    resolveConfig: () => DEFAULT_OUTBOUND_DEDUPE_CONFIG,
  };
  registerOutboundDedupeGuard(deps);
  registerInternalHook(
    "message:sent",
    createOutboundDedupeHandler(createOutboundSentRecorder(deps)),
  );

  sendText = vi.fn(async () => ({ channel: "slack", messageId: "m1" }));
  const outbound: ChannelOutboundAdapter = {
    deliveryMode: "direct",
    sendText: sendText as ChannelOutboundAdapter["sendText"],
    sendMedia: async () => ({ channel: "slack", messageId: "m1" }),
  };
  const registry = createTestRegistry([
    {
      pluginId: "slack",
      source: "test",
      plugin: createOutboundTestPlugin({ id: "slack", outbound }),
    },
  ]);
  setActivePluginRegistry(registry);
  initializeGlobalHookRunner(registry);
});

afterEach(async () => {
  dispatchReplyFromConfigMock.mockReset();
  clearInternalHooks();
  resetCoreHooksForTest();
  resetGlobalHookRunner();
  await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("outbound-dedupe on the dispatcher path with durable channel delivery", () => {
  it("runs both fires of one send under one identity and sends once", async () => {
    await runTurn({ sessionKey: FIRST_RUN, text: ANSWER });

    // Both fires happened for this one reply...
    expect(observed).toHaveLength(2);
    const nonces = observed.map((event) => event.metadata?.sendNonce);
    expect(nonces[0]).toEqual(expect.any(String));
    // ...and they name the same physical send, which is what stops the second
    // fire from reading the first fire's reservation as a duplicate.
    expect(nonces[1]).toBe(nonces[0]);
    // The ask is declared at both fires, so the obligation half of the guard is
    // live on the dispatcher path and not only on the routed one.
    expect(observed.map((event) => event.metadata?.obligationId)).toEqual([
      OBLIGATION_ID,
      OBLIGATION_ID,
    ]);
    // One reply, one message on the channel.
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("still cancels a second run answering the same ask in that thread", async () => {
    await runTurn({ sessionKey: FIRST_RUN, text: ANSWER });
    expect(sendText).toHaveBeenCalledTimes(1);

    // The 2026-09-03 leak: another run answers the same ask, paraphrased, so only
    // the obligation key can catch it. Making the two fires idempotent must not
    // make this pass through.
    await runTurn({ sessionKey: SECOND_RUN, text: PARAPHRASE });

    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
