// Drives the real durable send path (the one cron announces and heartbeat
// replies use: sendDurableMessageBatch -> deliverOutboundPayloads ->
// message_sending) through the outbound-dedupe guard registered as a core hook.
//
// The last block drives the real reply path on top of it (routeReply ->
// sendDurableMessageBatch -> ... -> message_sending), which declares the ask a
// reply answers on the payload.
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

import { routeReply } from "../../../auto-reply/reply/route-reply.js";
import { sendDurableMessageBatch } from "../../../channels/message/send.js";
import type { ChannelOutboundAdapter } from "../../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OutboundSessionContext } from "../../../infra/outbound/session-context.js";
import { resetCoreHooksForTest } from "../../../plugins/core-hooks.js";
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
import { OUTBOUND_HASHES_FILE, type OutboundHashStore } from "./hash-store.js";

const ANNOUNCE = "[hcom-bridge] reconciliation required: worker state drifted from hcom.db";
const cfg = {} as OpenClawConfig;

const SLACK_CHANNEL = "C0A3C98HS48";
const ASK_TS = "1788479206.951729";
const ASK_SESSION = `agent:main:slack:channel:c0a3c98hs48:thread:${ASK_TS}`;
const ACKNOWLEDGEMENT = "I'll pull the ARP capture off the pod and reply here shortly.";
const ANSWER = "The ARP capture is on the pod under /workspace/captures, 41 MB.";
/** 13:17:59 -> 13:38:20 EDT, the gap between the acknowledgement and the answer on 2026-09-22. */
const ACK_TO_ANSWER_MS = (20 * 60 + 21) * 1_000;

let workspaceDir = "";
let sendText: ReturnType<typeof vi.fn>;
let clockOffsetMs = 0;

async function readStore(): Promise<OutboundHashStore> {
  return JSON.parse(
    await fs.readFile(path.join(workspaceDir, "state", OUTBOUND_HASHES_FILE), "utf-8"),
  ) as OutboundHashStore;
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-dedupe-durable-"));
  clockOffsetMs = 0;
  const deps = {
    resolveWorkspaceDir: () => workspaceDir,
    resolveConfig: () => DEFAULT_OUTBOUND_DEDUPE_CONFIG,
    now: () => new Date(Date.now() + clockOffsetMs),
  };
  registerOutboundDedupeGuard(deps);
  registerInternalHook(
    "message:sent",
    createOutboundDedupeHandler(createOutboundSentRecorder(deps)),
  );

  sendText = vi.fn(async () => ({ channel: "matrix", messageId: "m1" }));
  const outbound: ChannelOutboundAdapter = {
    deliveryMode: "direct",
    sendText: sendText as ChannelOutboundAdapter["sendText"],
    sendMedia: async () => ({ channel: "matrix", messageId: "m1" }),
  };
  const registry = createTestRegistry([
    {
      pluginId: "matrix",
      source: "test",
      plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
    },
    {
      pluginId: "slack",
      source: "test",
      plugin: createOutboundTestPlugin({ id: "slack", outbound }),
    },
  ]);
  setActivePluginRegistry(registry);
  initializeGlobalHookRunner(registry);
});

async function waitForConfirmedEntry(threadKey: string): Promise<void> {
  await vi.waitFor(async () => {
    const store = await readStore();
    expect(store[threadKey]?.at(-1)?.confirmedAt).toBeDefined();
  });
}

afterEach(async () => {
  clearInternalHooks();
  resetCoreHooksForTest();
  resetGlobalHookRunner();
  await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("outbound-dedupe on the durable send path", () => {
  it("suppresses a repeated cron announce into the same thread", async () => {
    const announce = () =>
      sendDurableMessageBatch({
        cfg,
        channel: "matrix",
        to: "!ops:example",
        threadId: "1786591963.108609",
        payloads: [{ text: ANNOUNCE }],
        session: { key: "agent:main:main", agentId: "main" } as OutboundSessionContext,
      });

    expect((await announce()).status).toBe("sent");
    await waitForConfirmedEntry("matrix:!ops:example:1786591963.108609");

    const repeat = await announce();
    expect(repeat.status).toBe("suppressed");
    expect(repeat.payloadOutcomes?.[0]).toMatchObject({
      status: "suppressed",
      reason: "cancelled_by_message_sending_hook",
    });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("suppresses a repeated heartbeat reply and lets a new one through", async () => {
    const heartbeatReply = (text: string) =>
      sendDurableMessageBatch({
        cfg,
        channel: "matrix",
        to: "!ops:example",
        payloads: [{ text }],
        session: {
          key: "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609",
          agentId: "main",
        } as OutboundSessionContext,
      });

    expect(
      (await heartbeatReply("Foundry stale for 368 min. Auto-restart attempted.")).status,
    ).toBe("sent");
    expect(
      (await heartbeatReply("Foundry stale for 368 min. Auto-restart attempted.")).status,
    ).toBe("suppressed");
    expect(
      (await heartbeatReply("Foundry recovered: worker responded, no restart needed.")).status,
    ).toBe("sent");
    expect(sendText).toHaveBeenCalledTimes(2);
    await waitForConfirmedEntry("matrix:!ops:example:1786591963.108609");
  });

  it("lets a retry through after the platform send failed", async () => {
    sendText.mockRejectedValueOnce(new Error("slack down"));
    const send = () =>
      sendDurableMessageBatch({
        cfg,
        channel: "matrix",
        to: "!ops:example",
        payloads: [{ text: ANNOUNCE }],
        session: { key: "agent:main:main", agentId: "main" } as OutboundSessionContext,
      });

    expect((await send()).status).toBe("failed");
    await vi.waitFor(async () => {
      const store = await readStore();
      expect(store["matrix:!ops:example:root"] ?? []).toHaveLength(0);
    });
    expect((await send()).status).toBe("sent");
    await waitForConfirmedEntry("matrix:!ops:example:root");
  });
});

describe("outbound-dedupe on the routed reply path", () => {
  /** One run replying to the ask it was given, through the real reply router. */
  const replyToAsk = (text: string) =>
    routeReply({
      payload: { text, replyToId: ASK_TS },
      channel: "slack",
      to: `channel:${SLACK_CHANNEL}`,
      sessionKey: ASK_SESSION,
      cfg,
      mirror: false,
      replyKind: "final",
    });

  beforeEach(() => {
    // Slack confirms a send with the ts of the posted message; only such a send
    // holds its reservation for the whole window.
    sendText
      .mockResolvedValueOnce({ channel: "slack", messageId: "1788479300.000100" })
      .mockResolvedValueOnce({ channel: "slack", messageId: "1788480500.000200" });
  });

  it("delivers the answer a run posts after acknowledging the same ask", async () => {
    expect((await replyToAsk(ACKNOWLEDGEMENT)).ok).toBe(true);
    await waitForConfirmedEntry(`slack:${SLACK_CHANNEL}:${ASK_TS}`);
    clockOffsetMs += ACK_TO_ANSWER_MS;

    const answer = await replyToAsk(ANSWER);

    expect(answer.ok).toBe(true);
    expect(answer.messageId).toBeDefined();
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("still suppresses the identical reply sent twice", async () => {
    expect((await replyToAsk(ANSWER)).ok).toBe(true);
    await waitForConfirmedEntry(`slack:${SLACK_CHANNEL}:${ASK_TS}`);
    clockOffsetMs += ACK_TO_ANSWER_MS;

    // A cancelled message_sending hook is not a routing failure, so routeReply
    // still reports ok; the channel simply never saw the second copy.
    const repeat = await replyToAsk(ANSWER);

    expect(repeat.ok).toBe(true);
    expect(repeat.messageId).toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
