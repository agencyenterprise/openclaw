// Slack tests cover inbound posts that wait for a busy thread instead of being dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSlackInboundThreadWaitsForTest,
  type SlackHeldInboundStore,
} from "./inbound-thread-wait.js";

type PreparedFixture = { ctxPayload: { ts?: string; text?: string } };

const threadState = vi.hoisted(() => ({ busy: false }));
const ingressState = vi.hoisted(() => ({ resolveFails: false }));
const delivered = vi.hoisted(() => new Set<string>());
const dispatchedTs: string[] = [];
const dispatchAttempts: string[] = [];

vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: async (params: { message: { ts?: string; text?: string } }) => ({
    ctxPayload: { ts: params.message.ts, text: params.message.text },
  }),
  dispatchPreparedSlackMessage: async (prepared: PreparedFixture) => {
    dispatchAttempts.push(prepared.ctxPayload.ts ?? "");
    if (threadState.busy) {
      throw new Error("NATIVE_BUSY");
    }
    dispatchedTs.push(prepared.ctxPayload.ts ?? "");
  },
}));

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: async ({ message }: { message: Record<string, unknown> }) => {
      if (ingressState.resolveFails) {
        throw new Error("thread lookup failed");
      }
      return message;
    },
  }),
}));

vi.mock("./inbound-delivery-state.js", () => ({
  hasSlackInboundMessageDelivery: async (params: { channelId?: string; ts?: string }) =>
    delivered.has(`${params.channelId}:${params.ts}`),
  recordSlackInboundMessageDeliveries: async (params: {
    messages: ReadonlyArray<{ channel?: string; ts?: string }>;
  }) => {
    for (const message of params.messages) {
      delivered.add(`${message.channel}:${message.ts}`);
    }
  },
}));

const { createSlackMessageHandler } = await import("./message-handler.js");

const OPS_CHANNEL = "C0A3C98HS48";
const THREAD_CHANNEL = "C0AHSKBNDB6";
const THREAD_TS = "1790374065.198139";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The lost 2026-09-25 post: a bare mention in a thread whose dispatch fence stayed busy. */
const JUDD_MENTION = {
  type: "app_mention",
  channel: THREAD_CHANNEL,
  user: "U03EH553GBE",
  ts: "1790380995.461119",
  thread_ts: THREAD_TS,
  text: "<@U0AG6682EQZ>",
};

function createMemoryStore() {
  const rows = new Map<string, unknown>();
  const store: SlackHeldInboundStore = {
    register: async (key, value) => {
      rows.set(key, structuredClone(value));
    },
    delete: async (key) => rows.delete(key),
    entries: async () => Array.from(rows, ([key, value]) => ({ key, value })),
  };
  return { rows, store };
}

function createHarness(store?: SlackHeldInboundStore) {
  const seen = new Set<string>();
  const postMessage = vi.fn(async (_payload: Record<string, unknown>) => ({
    ok: true,
    ts: "1790400000.000100",
  }));
  const errors: string[] = [];
  const handler = createSlackMessageHandler({
    ctx: {
      cfg: {},
      accountId: "default",
      botUserId: "U0AG6682EQZ",
      channelHistories: new Map(),
      app: { client: { chat: { postMessage } } },
      runtime: { error: (line: string) => errors.push(line), log: () => {} },
      markMessageSeen: (channel: string | undefined, ts: string | undefined) => {
        const key = `${channel}:${ts}`;
        if (seen.has(key)) {
          return true;
        }
        seen.add(key);
        return false;
      },
      releaseSeenMessage: (channel: string | undefined, ts: string | undefined) => {
        seen.delete(`${channel}:${ts}`);
      },
      rememberSlackChannelType: () => {},
    } as unknown as Parameters<typeof createSlackMessageHandler>[0]["ctx"],
    account: { accountId: "default" } as Parameters<typeof createSlackMessageHandler>[0]["account"],
    ...(store ? { heldInboundStore: store } : {}),
  });
  return { handler, postMessage, errors };
}

function sendMention(
  handler: ReturnType<typeof createHarness>["handler"],
  overrides: Partial<typeof JUDD_MENTION> = {},
) {
  return handler({ ...JUDD_MENTION, ...overrides } as never, {
    source: "app_mention",
    wasMentioned: true,
  });
}

function postedChannels(postMessage: ReturnType<typeof createHarness>["postMessage"]) {
  return postMessage.mock.calls.map((call) => call[0]?.channel);
}

describe("createSlackMessageHandler busy-thread wait", () => {
  beforeEach(() => {
    resetSlackInboundThreadWaitsForTest();
    vi.useFakeTimers();
    threadState.busy = false;
    ingressState.resolveFails = false;
    delivered.clear();
    dispatchedTs.length = 0;
    dispatchAttempts.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps waiting past the old 21 minute budget and dispatches once the thread frees", async () => {
    const { handler, postMessage } = createHarness();
    threadState.busy = true;

    await sendMention(handler);
    await vi.advanceTimersByTimeAsync(45 * MINUTE_MS);

    expect(dispatchAttempts.length).toBeGreaterThan(20);
    expect(dispatchedTs).toEqual([]);
    expect(postMessage).not.toHaveBeenCalled();

    threadState.busy = false;
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect(dispatchedTs).toEqual([JUDD_MENTION.ts]);
    expect(postMessage).not.toHaveBeenCalled();
    const attemptsAfterDelivery = dispatchAttempts.length;
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(dispatchAttempts).toHaveLength(attemptsAfterDelivery);
  });

  it("dispatches a later post in the same thread only after the earlier waiting post", async () => {
    const { handler } = createHarness();
    threadState.busy = true;

    await sendMention(handler);
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    const attemptsBeforeLaterPost = dispatchAttempts.length;
    await sendMention(handler, { user: "U0SECOND01", ts: "1790381400.000200", text: "and this" });

    // The later post waits behind the earlier one instead of racing it into the fence.
    expect(dispatchAttempts).toHaveLength(attemptsBeforeLaterPost);

    threadState.busy = false;
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    expect(dispatchedTs).toEqual([JUDD_MENTION.ts, "1790381400.000200"]);
  });

  it("keeps different threads independent", async () => {
    const { handler } = createHarness();
    threadState.busy = true;
    await sendMention(handler);

    threadState.busy = false;
    await sendMention(handler, { ts: "1790381500.000300", thread_ts: "1790381000.000001" });

    expect(dispatchedTs).toEqual(["1790381500.000300"]);
  });

  it("alerts operators exactly once at the six hour bound and never posts in the thread", async () => {
    const { handler, postMessage, errors } = createHarness();
    threadState.busy = true;

    await sendMention(handler);
    await vi.advanceTimersByTimeAsync(6 * HOUR_MS + 2 * MINUTE_MS);

    expect(postedChannels(postMessage)).toEqual([OPS_CHANNEL]);
    const alert = postMessage.mock.calls[0]?.[0] as { text: string; thread_ts?: string };
    expect(alert.thread_ts).toBeUndefined();
    expect(alert.text).toContain(`channel: ${THREAD_CHANNEL}`);
    expect(alert.text).toContain(`ts: ${JUDD_MENTION.ts}`);
    expect(alert.text).toContain(`thread: ${THREAD_TS}`);
    expect(alert.text).toContain(`user: ${JUDD_MENTION.user}`);
    expect(alert.text).toContain("last error: NATIVE_BUSY");
    expect(alert.text).toContain("elapsed: 6h");
    // The excerpt must not ping anyone from the ops channel.
    expect(alert.text).toContain('text: "&lt;@U0AG6682EQZ&gt;"');
    expect(alert.text).not.toContain("resend");
    expect(errors.join("\n")).toContain("Slack inbound message undeliverable after 6h");

    const attemptsAtAlert = dispatchAttempts.length;
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(dispatchAttempts).toHaveLength(attemptsAtAlert);
  });

  it("neither redispatches nor alerts a post that another path delivered while it waited", async () => {
    const { handler, postMessage } = createHarness();
    threadState.busy = true;

    await sendMention(handler);
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    delivered.add(`${THREAD_CHANNEL}:${JUDD_MENTION.ts}`);
    const attemptsAtDelivery = dispatchAttempts.length;

    await vi.advanceTimersByTimeAsync(7 * HOUR_MS);
    threadState.busy = false;
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(dispatchAttempts).toHaveLength(attemptsAtDelivery);
    expect(dispatchedTs).toEqual([]);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("still dispatches new posts when the held-post store cannot be read at start", async () => {
    const { store } = createMemoryStore();
    const unreadable: SlackHeldInboundStore = {
      ...store,
      entries: async () => {
        throw new Error("PLUGIN_STATE_READ_FAILED");
      },
    };
    const { handler, errors } = createHarness(unreadable);

    await sendMention(handler);

    expect(dispatchedTs).toEqual([JUDD_MENTION.ts]);
    expect(errors.join("\n")).toContain("slack held inbound store read failed");
  });

  it("recovers stored posts once a failed store read succeeds on retry", async () => {
    const { rows, store } = createMemoryStore();
    const first = createHarness(store);
    threadState.busy = true;
    await sendMention(first.handler);
    expect(rows.size).toBe(1);

    resetSlackInboundThreadWaitsForTest();
    threadState.busy = false;
    let reads = 0;
    const flaky: SlackHeldInboundStore = {
      ...store,
      entries: async () => {
        reads += 1;
        if (reads === 1) {
          throw new Error("SQLITE_BUSY");
        }
        return await store.entries();
      },
    };
    createHarness(flaky);
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    expect(reads).toBe(2);
    expect(dispatchedTs).toEqual([JUDD_MENTION.ts]);
    expect(rows.size).toBe(0);
  });

  it("hands the wait to a monitor restarted in-process without dispatching twice", async () => {
    const { rows, store } = createMemoryStore();
    const first = createHarness(store);
    threadState.busy = true;
    await sendMention(first.handler);
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    const second = createHarness(store);
    threadState.busy = false;
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    expect(dispatchedTs).toEqual([JUDD_MENTION.ts]);
    expect(first.postMessage).not.toHaveBeenCalled();
    expect(second.postMessage).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });

  it("keeps the retry clock when Slack's other copy of the post arrives during the wait", async () => {
    const { handler, postMessage } = createHarness();
    threadState.busy = true;
    await sendMention(handler);
    await vi.advanceTimersByTimeAsync(5 * HOUR_MS + 58 * MINUTE_MS);

    // Slack's message copy of the same post turns up while the app_mention copy waits.
    await handler({ ...JUDD_MENTION, type: "message" } as never, { source: "message" });
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

    expect(postedChannels(postMessage)).toEqual([OPS_CHANNEL]);
  });

  it("alerts at the bound even when redelivery itself keeps throwing", async () => {
    const { handler, postMessage, errors } = createHarness();
    threadState.busy = true;
    await sendMention(handler);
    ingressState.resolveFails = true;

    await vi.advanceTimersByTimeAsync(6 * HOUR_MS + 2 * MINUTE_MS);

    expect(errors.join("\n")).toContain("slack held inbound redelivery failed");
    expect(postedChannels(postMessage)).toEqual([OPS_CHANNEL]);
    const alert = postMessage.mock.calls[0]?.[0] as { text: string };
    expect(alert.text).toContain("last error: thread lookup failed");
    const errorsAtAlert = errors.length;
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(errors).toHaveLength(errorsAtAlert);
  });

  it("re-enqueues held posts in thread order after a gateway restart", async () => {
    const { rows, store } = createMemoryStore();
    const first = createHarness(store);
    threadState.busy = true;

    await sendMention(first.handler);
    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
    await sendMention(first.handler, { user: "U0SECOND01", ts: "1790381400.000200" });
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.size).toBe(2);

    // Process death: the first gateway's timers and memory are gone, only the store remains.
    resetSlackInboundThreadWaitsForTest();
    threadState.busy = false;
    const restarted = createHarness(store);
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    expect(dispatchedTs).toEqual([JUDD_MENTION.ts, "1790381400.000200"]);
    expect(restarted.postMessage).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });
});
