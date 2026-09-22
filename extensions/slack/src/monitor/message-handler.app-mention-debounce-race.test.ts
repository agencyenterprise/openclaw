// Slack tests cover the app_mention copy that waits in the debouncer while the message copy
// of the same post (a file share skips debounce) already reaches dispatch.
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setSlackRuntime } from "../runtime.js";

type FlushEntry = {
  message: Record<string, unknown>;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
};

const heldAppMentionFlushes = vi.hoisted(() => ({
  pending: [] as Array<() => Promise<void>>,
}));

const prepareSlackMessageMock = vi.fn<
  (params: {
    message: { ts?: string; text?: string };
    opts: { source: "message" | "app_mention" };
  }) => Promise<unknown>
>();
const dispatchPreparedSlackMessageMock = vi.fn<(prepared: unknown) => Promise<void>>();
const inboundDeliveryTestCache = resolveGlobalDedupeCache(
  Symbol.for("openclaw.slackInboundDeliveries"),
  { ttlMs: 24 * 60 * 60 * 1000, maxSize: 20_000 },
);

const combinedFlushMode = vi.hoisted(() => ({ enabled: false, pending: [] as FlushEntry[] }));

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    // Only the app_mention copy is text-only and gets debounced; the message copy carries the
    // file share and flushes at once.
    shouldDebounceTextInbound: ({ hasMedia }: { hasMedia: boolean }) => !hasMedia,
    createChannelInboundDebouncer: (params: {
      onFlush: (entries: FlushEntry[]) => Promise<void>;
    }) => ({
      debounceMs: 5_000,
      debouncer: {
        enqueue: async (entry: FlushEntry) => {
          if (combinedFlushMode.enabled && !entry.message.files) {
            combinedFlushMode.pending.push(entry);
            return;
          }
          if (entry.opts.source === "app_mention") {
            heldAppMentionFlushes.pending.push(() => params.onFlush([entry]));
            return;
          }
          await params.onFlush([entry]);
        },
        flushKey: async (_key: string) => {
          const entries = combinedFlushMode.pending.splice(0);
          if (entries.length > 0) {
            await params.onFlush(entries);
          }
        },
      },
    }),
  };
});

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: async ({ message }: { message: Record<string, unknown> }) => message,
  }),
}));

vi.mock("./message-handler/prepare.js", () => ({
  prepareSlackMessage: (
    params: Parameters<typeof prepareSlackMessageMock>[0],
  ): ReturnType<typeof prepareSlackMessageMock> => prepareSlackMessageMock(params),
}));

vi.mock("./message-handler/dispatch.js", () => ({
  dispatchPreparedSlackMessage: (
    prepared: Parameters<typeof dispatchPreparedSlackMessageMock>[0],
  ): ReturnType<typeof dispatchPreparedSlackMessageMock> =>
    dispatchPreparedSlackMessageMock(prepared),
}));

let createSlackMessageHandler: typeof import("./message-handler.js").createSlackMessageHandler;

function createSeenMessageGate() {
  const seen = new Set<string>();
  return {
    markMessageSeen(channel: string | undefined, ts: string | undefined) {
      if (!channel || !ts) {
        return false;
      }
      const key = `${channel}:${ts}`;
      if (seen.has(key)) {
        return true;
      }
      seen.add(key);
      return false;
    },
    releaseSeenMessage(channel: string | undefined, ts: string | undefined) {
      if (channel && ts) {
        seen.delete(`${channel}:${ts}`);
      }
    },
  };
}

function createTestHandler() {
  const seenMessages = createSeenMessageGate();
  return createSlackMessageHandler({
    ctx: {
      cfg: {},
      accountId: "default",
      botUserId: "U_BOT",
      channelHistories: new Map(),
      app: { client: {} },
      runtime: {},
      markMessageSeen: seenMessages.markMessageSeen,
      rememberSlackChannelType: () => {},
      releaseSeenMessage: seenMessages.releaseSeenMessage,
    } as unknown as Parameters<typeof createSlackMessageHandler>[0]["ctx"],
    account: { accountId: "default" } as Parameters<typeof createSlackMessageHandler>[0]["account"],
  });
}

const POST_TS = "1790097410.218249";
let lastHandler: ReturnType<typeof createTestHandler>;

function sendFileShareMessageEvent(handler: ReturnType<typeof createTestHandler>) {
  return handler(
    {
      type: "message",
      subtype: "file_share",
      channel: "C1",
      ts: POST_TS,
      text: "<@U_BOT>",
      files: [{ id: "F1", name: "esr-status.zip" }],
    } as never,
    { source: "message" },
  );
}

function sendMentionEvent(handler: ReturnType<typeof createTestHandler>) {
  return handler({ type: "app_mention", channel: "C1", ts: POST_TS, text: "<@U_BOT>" } as never, {
    source: "app_mention",
    wasMentioned: true,
  });
}

async function releaseHeldAppMentionFlushes() {
  const pending = heldAppMentionFlushes.pending.splice(0);
  for (const flush of pending) {
    await flush();
  }
}

/** Message copy is mid-prepare when the app_mention copy passes the seen gate. */
async function startPostWithMentionWaitingInDebouncer() {
  let resolveMessagePrepare: ((value: unknown) => void) | undefined;
  const messagePrepare = new Promise<unknown>((resolve) => {
    resolveMessagePrepare = resolve;
  });
  prepareSlackMessageMock.mockImplementation(async ({ opts }) =>
    opts.source === "message" ? messagePrepare : { ctxPayload: {} },
  );

  const handler = createTestHandler();
  lastHandler = handler;
  const messagePending = sendFileShareMessageEvent(handler);
  await Promise.resolve();
  await sendMentionEvent(handler);

  expect(heldAppMentionFlushes.pending).toHaveLength(1);
  return { messagePending, resolveMessagePrepare };
}

describe("createSlackMessageHandler app_mention copy held in the debouncer", () => {
  beforeAll(async () => {
    ({ createSlackMessageHandler } = await import("./message-handler.js"));
  });

  beforeEach(() => {
    prepareSlackMessageMock.mockReset();
    dispatchPreparedSlackMessageMock.mockReset();
    dispatchPreparedSlackMessageMock.mockResolvedValue(undefined);
    heldAppMentionFlushes.pending.length = 0;
    combinedFlushMode.enabled = false;
    combinedFlushMode.pending.length = 0;
    inboundDeliveryTestCache.clear();
    setSlackRuntime(null as never);
  });

  afterEach(() => {
    setSlackRuntime(null as never);
    vi.restoreAllMocks();
  });

  it("drops the debounced app_mention copy once the message copy has dispatched the post", async () => {
    const { messagePending, resolveMessagePrepare } =
      await startPostWithMentionWaitingInDebouncer();

    resolveMessagePrepare?.({ ctxPayload: {} });
    await messagePending;
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);

    await releaseHeldAppMentionFlushes();

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("still lets the app_mention copy dispatch when the message copy was dropped in prepare", async () => {
    const { messagePending, resolveMessagePrepare } =
      await startPostWithMentionWaitingInDebouncer();

    resolveMessagePrepare?.(null);
    await messagePending;
    expect(dispatchPreparedSlackMessageMock).not.toHaveBeenCalled();

    await releaseHeldAppMentionFlushes();

    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("forgets the message copy's dispatch mark when a retryable failure releases the post", async () => {
    vi.useFakeTimers();
    try {
      const { messagePending, resolveMessagePrepare } =
        await startPostWithMentionWaitingInDebouncer();
      dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
        new Error("restart recovery claim busy for agent:main:slack:channel:c1"),
      );

      resolveMessagePrepare?.({ ctxPayload: {} });
      await messagePending.catch(() => undefined);
      expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
      heldAppMentionFlushes.pending.length = 0;

      // The seen gate was released, so Slack's app_mention retry of the same post must run.
      const handler = lastHandler;
      await sendMentionEvent(handler);
      await releaseHeldAppMentionFlushes();

      expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a post the thread fence reports busy instead of dropping it", async () => {
    vi.useFakeTimers();
    try {
      prepareSlackMessageMock.mockResolvedValue({ ctxPayload: {} });
      dispatchPreparedSlackMessageMock.mockRejectedValueOnce(new Error("NATIVE_BUSY"));
      const handler = createTestHandler();

      await sendFileShareMessageEvent(handler).catch(() => undefined);
      expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("presents a mentioned text post once when both copies debounce into one flush", async () => {
    combinedFlushMode.enabled = true;
    prepareSlackMessageMock.mockResolvedValue({ ctxPayload: {} });
    const handler = createTestHandler();
    const text = "<@U_BOT> explore how this relates to the earlier world-model ideas";

    await handler(
      { type: "message", channel: "C1", ts: POST_TS, text, user: "U_HUMAN" } as never,
      { source: "message" },
    );
    await handler(
      { type: "app_mention", channel: "C1", ts: POST_TS, text, user: "U_HUMAN" } as never,
      { source: "app_mention", wasMentioned: true },
    );
    expect(combinedFlushMode.pending).toHaveLength(2);
    await handler(
      { type: "message", channel: "C1", ts: "1790097499.000001", text: "x", user: "U_HUMAN", files: [{ id: "F2" }] } as never,
      { source: "message" },
    );

    const combinedPrepare = prepareSlackMessageMock.mock.calls.find(
      ([params]) => params.message.ts === POST_TS,
    );
    expect(combinedPrepare?.[0].message.text).toBe(text);
    expect(
      dispatchPreparedSlackMessageMock.mock.calls.length,
    ).toBe(2);
  });

  it("drops the message copy when the app_mention copy flushes and dispatches first", async () => {
    const { messagePending, resolveMessagePrepare } =
      await startPostWithMentionWaitingInDebouncer();

    await releaseHeldAppMentionFlushes();
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);

    resolveMessagePrepare?.({ ctxPayload: {} });
    await messagePending;

    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });
});
