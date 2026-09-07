// Drives the real durable send path (the one cron announces and heartbeat
// replies use: sendDurableMessageBatch -> deliverOutboundPayloads ->
// message_sending) through the outbound-dedupe guard registered as a core hook.
//
// The last block drives the real reply path on top of it (routeReply ->
// sendDurableMessageBatch -> ... -> message_sending), which is the only path
// that knows which ask a reply answers and declares it on the payload.
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
import { buildObligationKey } from "./obligation-key.js";
import { OUTBOUND_OBLIGATIONS_FILE, type ObligationReservationStore } from "./obligation-store.js";

const ANNOUNCE = "[hcom-bridge] reconciliation required: worker state drifted from hcom.db";
const cfg = {} as OpenClawConfig;

/** The 2026-09-03 leak: one ask, answered by the replay run and by the live run. */
const SLACK_CHANNEL = "C0A3C98HS48";
const ASK_TS = "1788479206.951729";
const LIVE_ASK_TS = "1788479558.561999";
const OBLIGATION_ID = `${SLACK_CHANNEL}:${ASK_TS}`;
const ANSWER = "The ARP capture is on the pod under /workspace/captures, 41 MB.";
const PARAPHRASE = "You will find the capture at /workspace/captures on the pod (41 MB).";

let workspaceDir = "";
let sendText: ReturnType<typeof vi.fn>;

async function readStore(): Promise<OutboundHashStore> {
  return JSON.parse(
    await fs.readFile(path.join(workspaceDir, "state", OUTBOUND_HASHES_FILE), "utf-8"),
  ) as OutboundHashStore;
}

async function readObligations(): Promise<ObligationReservationStore> {
  return JSON.parse(
    await fs.readFile(path.join(workspaceDir, "state", OUTBOUND_OBLIGATIONS_FILE), "utf-8"),
  ) as ObligationReservationStore;
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-dedupe-durable-"));
  const deps = {
    resolveWorkspaceDir: () => workspaceDir,
    resolveConfig: () => DEFAULT_OUTBOUND_DEDUPE_CONFIG,
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
  /** One run answering the ask it was given, through the real reply router. */
  const answerAsk = (params: { sessionKey: string; text: string }) =>
    routeReply({
      payload: { text: params.text, replyToId: ASK_TS },
      channel: "slack",
      to: `channel:${SLACK_CHANNEL}`,
      sessionKey: params.sessionKey,
      cfg,
      mirror: false,
      replyKind: "final",
    });

  it("carries the ask id from routeReply to the message_sending guard", async () => {
    const result = await answerAsk({
      sessionKey: `agent:main:slack:channel:c0a3c98hs48:thread:${ASK_TS}`,
      text: ANSWER,
    });

    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    const reserved = buildObligationKey({
      channel: SLACK_CHANNEL,
      threadRootTs: ASK_TS,
      obligationId: OBLIGATION_ID,
      responseVersion: 0,
    });
    expect(Object.keys(await readObligations())).toEqual([reserved]);
  });

  it("suppresses a second run answering the same ask with different words", async () => {
    // The leak: the replayed ask and the live re-post started two runs, so the
    // session keys differ and neither answer is a chunk of the other. The text is
    // paraphrased, so only the obligation key can catch it.
    expect(
      (
        await answerAsk({
          sessionKey: `agent:main:slack:channel:c0a3c98hs48:thread:${ASK_TS}`,
          text: ANSWER,
        })
      ).ok,
    ).toBe(true);

    const secondRun = await answerAsk({
      sessionKey: `agent:main:slack:channel:c0a3c98hs48:thread:${LIVE_ASK_TS}`,
      text: PARAPHRASE,
    });

    // A cancelled message_sending hook is not a routing failure, so routeReply
    // still reports ok; the channel simply never saw the second answer.
    expect(secondRun.ok).toBe(true);
    expect(secondRun.messageId).toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("lets the same run keep delivering the payloads of one answer", async () => {
    const sessionKey = `agent:main:slack:channel:c0a3c98hs48:thread:${ASK_TS}`;
    expect((await answerAsk({ sessionKey, text: ANSWER })).ok).toBe(true);
    expect((await answerAsk({ sessionKey, text: PARAPHRASE })).ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(2);
  });
});
