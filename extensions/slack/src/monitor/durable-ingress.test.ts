import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocketModeReceiver } from "@slack/bolt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../../../../src/channels/message/ingress-queue.js";
import {
  createSlackDurableIngress,
  normalizeSlackIngress,
  wrapSlackDurableReceiver,
  type SlackIngressPayload,
  type SlackIngressMetadata,
  type SlackIngressEnvelope,
} from "./durable-ingress.js";

const scope = {
  accountId: "fixture",
  teamId: "T123",
  appId: "A123",
  channelId: "C123",
  threadTs: "100.000001",
};
function body() {
  return {
    type: "event_callback",
    team_id: "T123",
    api_app_id: "A123",
    event_id: "Ev123",
    event_time: 100,
    event: {
      type: "message",
      channel: "C123",
      user: "U123",
      ts: "101.000001",
      thread_ts: "100.000001",
      text: "fixture",
    },
  };
}
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "slack-ingress-"));
  dirs.push(stateDir);
  const queue = createChannelIngressQueue<
    SlackIngressPayload,
    SlackIngressMetadata,
    SlackIngressMetadata
  >({ channelId: "slack", accountId: scope.accountId, stateDir });
  const delegate = vi.fn(async () => {});
  return {
    queue,
    stateDir,
    delegate,
    journal: createSlackDurableIngress({ scope, queue, delegate }),
  };
}

describe("Slack scoped durable receiver", () => {
  it("actual queue commits before ACK; no direct handler and restart sees same source", async () => {
    const { queue, stateDir, journal, delegate } = await setup();
    const ack = vi.fn(async () => {
      expect(await queue.listPending()).toHaveLength(1);
    });
    await journal.receive({ body: body(), ack });
    expect(ack).toHaveBeenCalledOnce();
    expect(delegate).not.toHaveBeenCalled();
    const reopened = createChannelIngressQueue<
      SlackIngressPayload,
      SlackIngressMetadata,
      SlackIngressMetadata
    >({ channelId: "slack", accountId: scope.accountId, stateDir });
    const claim = await createSlackDurableIngress({ scope, queue: reopened, delegate }).claimOne(
      "pid:fixture:2",
    );
    expect(claim?.payload.body).toEqual(body());
    expect(claim?.id).toBe(normalizeSlackIngress(body(), scope)?.sourceId);
  });
  it("lost ACK preserves row; exact repeat ACKs once more without dispatch", async () => {
    const { queue, journal, delegate } = await setup();
    await expect(
      journal.receive({
        body: body(),
        ack: async () => {
          throw new Error("lost fixture ack");
        },
      }),
    ).rejects.toThrow("IO_FAILURE");
    const ack = vi.fn(async () => {});
    await journal.receive({ body: body(), ack });
    expect(await queue.listPending()).toHaveLength(1);
    expect(delegate).not.toHaveBeenCalled();
  });
  it("refuses changed duplicate before ACK, including completed tombstone", async () => {
    const { queue, journal } = await setup();
    await journal.receive({ body: body(), ack: async () => {} });
    const changed = body();
    changed.event.text = "changed";
    const ack = vi.fn(async () => {});
    await expect(journal.receive({ body: changed, ack })).rejects.toThrow("DUPLICATE_CONFLICT");
    const claim = await journal.claimOne("fixture");
    expect(claim).not.toBeNull();
    await queue.complete(claim!, { metadata: { digest: claim!.payload.digest } });
    await expect(journal.receive({ body: changed, ack })).rejects.toThrow("DUPLICATE_CONFLICT");
    await journal.receive({ body: body(), ack });
    expect(ack).toHaveBeenCalledOnce();
  });
  it.each([{ team_id: "T999" }, {}, { team_id: "T123", is_enterprise_install: true }])(
    "rejects alternate Bolt authorization scope %j",
    (authorization) => {
      expect(() =>
        normalizeSlackIngress({ ...body(), authorizations: [authorization] }, scope),
      ).toThrow("AUTHORIZATION_SCOPE");
    },
  );
  it("strips capabilities without altering message content or meaningful digest", async () => {
    const value = {
      ...body(),
      token: "synthetic-secret",
      response_url: "https://invalid.example/cap",
      response_urls: [{ response_url: "synthetic-cap" }],
    };
    const result = normalizeSlackIngress(value, scope)!;
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(result.digest).toBe(normalizeSlackIngress(body(), scope)?.digest);
  });
  it.each(["files", "attachments", "subtype"])(
    "refuses unsupported scoped %s without ACK",
    async (key) => {
      const { journal } = await setup();
      const value = body();
      Object.assign(value.event, { [key]: [] });
      const ack = vi.fn(async () => {});
      await expect(journal.receive({ body: value, ack })).rejects.toThrow("UNSUPPORTED_EVENT");
      expect(ack).not.toHaveBeenCalled();
    },
  );
  it("foreign team in scoped thread fails closed, unrelated thread delegates unchanged", async () => {
    const { journal, delegate } = await setup();
    const value = body();
    value.team_id = "T999";
    const ack = vi.fn(async () => {});
    await expect(journal.receive({ body: value, ack })).rejects.toThrow("IDENTITY");
    value.event.thread_ts = "999.1";
    const envelope = { body: value, ack };
    await journal.receive(envelope);
    expect(delegate).toHaveBeenCalledWith(envelope);
    expect(ack).not.toHaveBeenCalled();
  });
  it("UTF8 bytes are bounded; no truncation", () => {
    const value = body();
    value.event.text = "😀".repeat(20000);
    expect(() => normalizeSlackIngress(value, scope)).toThrow("PAYLOAD_LIMIT");
  });
  it("queue failure prevents ACK; no fail/prune or dead-owner recovery", async () => {
    const { queue, journal } = await setup();
    vi.spyOn(queue, "enqueue").mockRejectedValue(new Error("synthetic disk failure"));
    const ack = vi.fn(async () => {});
    await expect(journal.receive({ body: body(), ack })).rejects.toThrow("IO_FAILURE");
    expect(ack).not.toHaveBeenCalled();
    const next = vi.spyOn(queue, "claimNext");
    await journal.claimOne("fixture");
    expect(next).not.toHaveBeenCalled();
  });
  it("does not claim an unrelated thread's actual queue row", async () => {
    const { queue, journal } = await setup();
    const other = body();
    other.event.thread_ts = "999.000001";
    const otherScope = { ...scope, threadTs: "999.000001" };
    const payload = normalizeSlackIngress(other, otherScope)!;
    await queue.enqueue(payload.sourceId, payload, {
      metadata: { digest: payload.digest },
      laneKey: JSON.stringify([scope.teamId, scope.channelId, otherScope.threadTs]),
    });
    const before = await queue.listPending();
    expect(await journal.claimOne("fixture")).toBeNull();
    expect(await queue.listClaims()).toEqual([]);
    expect(await queue.listPending()).toEqual(before);
  });
  it("claims scoped work beyond32 unrelated pending rows without claiming those rows", async () => {
    const { queue, journal } = await setup();
    for (let i = 0; i < 35; i++) {
      const other = body();
      other.event_id = `EvOther${i}`;
      other.event.thread_ts = "999.000001";
      const payload = normalizeSlackIngress(other, { ...scope, threadTs: "999.000001" })!;
      await queue.enqueue(payload.sourceId, payload, {
        metadata: { digest: payload.digest },
        laneKey: JSON.stringify([scope.teamId, scope.channelId, "999.000001"]),
      });
    }
    await journal.receive({ body: body(), ack: async () => {} });
    const claim = await journal.claimOne("fixture");
    expect(claim?.id).toBe(normalizeSlackIngress(body(), scope)?.sourceId);
    expect(await queue.listPending()).toHaveLength(35);
    expect(await queue.listClaims()).toHaveLength(1);
  });
  it.each(["101", "101.1", "x.000001"])("rejects noncanonical timestamp %s", (ts) => {
    const value = body();
    value.event.ts = ts;
    expect(() => normalizeSlackIngress(value, scope)).toThrow("TIMESTAMP");
  });
  it("actual installed SocketModeReceiver listener journals before ACK and suppresses private failure logs", async () => {
    const { queue } = await setup();
    const lines: string[] = [];
    const logger = {
      debug: (...args: unknown[]) => lines.push(args.join(" ")),
      info: vi.fn(),
      warn: vi.fn(),
      error: (...args: unknown[]) => lines.push(args.join(" ")),
      setLevel: vi.fn(),
      getLevel: vi.fn(),
      setName: vi.fn(),
    };
    const receiver = new SocketModeReceiver({ appToken: "xapp-synthetic-fixture", logger });
    const app = { processEvent: vi.fn(async () => {}) };
    // Actual maintained receiver's init + registered transport listener, without starting its network client.
    const wrapped = wrapSlackDurableReceiver({
      receiver: receiver as unknown as {
        init(app: typeof app): void;
        start(): unknown;
        stop(): unknown;
      },
      scope,
      queue,
    });
    wrapped.init(app);
    const listener = receiver.client.listeners("slack_event")[0] as (
      args: unknown,
    ) => Promise<void>;
    const ack = vi.fn(async () => {
      expect(await queue.listPending()).toHaveLength(1);
    });
    await listener({ body: body(), ack });
    expect(ack).toHaveBeenCalledOnce();
    expect(app.processEvent).not.toHaveBeenCalled();
    vi.spyOn(queue, "enqueue").mockRejectedValue(new Error("PRIVATE_FIXTURE_SQL_OR_CAPABILITY"));
    const failedAck = vi.fn(async () => {});
    await listener({ body: body(), ack: failedAck });
    expect(failedAck).not.toHaveBeenCalled();
    expect(lines.join(" ")).not.toContain("PRIVATE_FIXTURE");
    expect(lines.join(" ")).toContain("SLACK_INGRESS_IO_FAILURE");
  });
  it("wraps the SDK receiver's pre-processEvent seam, preserving lifecycle and unrelated delegate", async () => {
    const { queue } = await setup();
    let installed: { processEvent(event: SlackIngressEnvelope): Promise<unknown> } | undefined;
    const receiver = {
      init(app: typeof installed) {
        installed = app;
      },
      start: vi.fn(() => "started"),
      stop: vi.fn(() => "stopped"),
    };
    const app = {
      processEvent: vi.fn(async (event: SlackIngressEnvelope) => {
        await event.ack();
      }),
    };
    const wrapped = wrapSlackDurableReceiver({ receiver, scope, queue });
    wrapped.init(app);
    expect(wrapped.start()).toBe("started");
    const ack = vi.fn(async () => {
      expect(await queue.listPending()).toHaveLength(1);
    });
    await installed!.processEvent({ body: body(), ack });
    expect(app.processEvent).not.toHaveBeenCalled();
    await installed!.processEvent({ body: { type: "url_verification" }, ack: async () => {} });
    expect(app.processEvent).toHaveBeenCalledOnce();
    expect(wrapped.stop()).toBe("stopped");
    expect(() => wrapped.init(app)).toThrow("ALREADY_INITIALIZED");
  });
});
