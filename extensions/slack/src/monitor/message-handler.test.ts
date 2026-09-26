// Slack tests cover message handler plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMock = vi.fn(async (_entry: unknown) => {});
const flushKeyMock = vi.fn(async (_key: string) => {});
const onFlushCallbacks: Array<(entries: Array<Record<string, unknown>>) => Promise<void>> = [];
const prepareSlackMessageMock = vi.fn(async () => ({ ctxPayload: {} }));
const dispatchPreparedSlackMessageMock = vi.fn(async () => {});
const hasSlackInboundMessageDeliveryMock = vi.fn(async () => false);
const recordSlackInboundMessageDeliveriesMock = vi.fn(async () => {});
const resolveThreadTsMock = vi.fn(async ({ message }: { message: Record<string, unknown> }) => ({
  ...message,
}));
const { createSlackMessageHandler } = await import("./message-handler.js");
const { resetSlackInboundThreadWaitsForTest } = await import("./inbound-thread-wait.js");

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    createChannelInboundDebouncer: (params: {
      onFlush: (entries: Array<Record<string, unknown>>) => Promise<void>;
    }) => {
      onFlushCallbacks.push(params.onFlush);
      return {
        debounceMs: 10,
        debouncer: {
          enqueue: (entry: unknown) => enqueueMock(entry),
          flushKey: (key: string) => flushKeyMock(key),
        },
      };
    },
    shouldDebounceTextInbound: ({ hasMedia }: { hasMedia?: boolean }) => !hasMedia,
  };
});

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: (entry: { message: Record<string, unknown> }) => resolveThreadTsMock(entry),
  }),
}));

vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepareSlackMessageMock,
  dispatchPreparedSlackMessage: dispatchPreparedSlackMessageMock,
}));

vi.mock("./inbound-delivery-state.js", () => ({
  hasSlackInboundMessageDelivery: hasSlackInboundMessageDeliveryMock,
  recordSlackInboundMessageDeliveries: recordSlackInboundMessageDeliveriesMock,
}));

type SlackContextOverrides = {
  markMessageSeen?: (channel: string | undefined, ts: string | undefined) => boolean;
  rememberSlackChannelType?: (
    channel: string | null | undefined,
    channelType: string | null | undefined,
  ) => void;
  releaseSeenMessage?: (channel: string | undefined, ts: string | undefined) => void;
  postMessage?: (payload: Record<string, unknown>) => Promise<unknown>;
  runtimeError?: (message: string) => void;
};

function createContext(overrides?: SlackContextOverrides) {
  return {
    cfg: {},
    accountId: "default",
    app: {
      client: {
        chat: {
          postMessage:
            overrides?.postMessage ??
            (async () => ({ ok: true, ts: "1788774800.000100" }) as unknown),
        },
      },
    },
    runtime: { error: overrides?.runtimeError },
    markMessageSeen: (channel: string | undefined, ts: string | undefined) =>
      overrides?.markMessageSeen?.(channel, ts) ?? false,
    rememberSlackChannelType: (
      channel: string | null | undefined,
      channelType: string | null | undefined,
    ) => overrides?.rememberSlackChannelType?.(channel, channelType),
    releaseSeenMessage: (channel: string | undefined, ts: string | undefined) =>
      overrides?.releaseSeenMessage?.(channel, ts),
  } as unknown as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
}

function createHandlerWithTracker(overrides?: SlackContextOverrides) {
  const trackEvent = vi.fn();
  const handler = createSlackMessageHandler({
    ctx: createContext(overrides),
    account: { accountId: "default" } as Parameters<typeof createSlackMessageHandler>[0]["account"],
    trackEvent,
  });
  return { handler, trackEvent };
}

async function handleDirectMessage(
  handler: ReturnType<typeof createHandlerWithTracker>["handler"],
) {
  await handler(
    {
      type: "message",
      channel: "D1",
      ts: "123.456",
      text: "hello",
    } as never,
    { source: "message" },
  );
}

const CLAIM_BUSY_ERROR_MESSAGE =
  "restart recovery claim busy for agent:main:main:thread:C0AHSKBNDB6:1788473062.847669";

const OPS_ALERT_CHANNEL = "C0A3C98HS48";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function withHeldRetry(
  entry: unknown,
  heldRetry: { firstFailureAtMs?: number; attempts: number; sessionInitConflicts?: number },
) {
  const typed = entry as { message: unknown; opts: Record<string, unknown> };
  return {
    ...typed,
    opts: {
      ...typed.opts,
      heldRetry: {
        firstFailureAtMs: heldRetry.firstFailureAtMs ?? Date.now(),
        attempts: heldRetry.attempts,
        sessionInitConflicts: heldRetry.sessionInitConflicts ?? 0,
      },
    },
  };
}

/** The dropped 2026-09-07 directive: an @mention in a thread whose session was busy. */
const BUSY_CLAIM_MENTION = {
  type: "app_mention",
  channel: "C0AHSKBNDB6",
  user: "U03EH553GBE",
  ts: "1788774766.101659",
  thread_ts: "1788473062.847669",
  text: "<@U0AG6682EQZ> long directive",
};

describe("createSlackMessageHandler", () => {
  beforeEach(() => {
    resetSlackInboundThreadWaitsForTest();
    enqueueMock.mockClear();
    flushKeyMock.mockClear();
    onFlushCallbacks.length = 0;
    prepareSlackMessageMock.mockClear();
    dispatchPreparedSlackMessageMock.mockClear();
    hasSlackInboundMessageDeliveryMock.mockReset();
    hasSlackInboundMessageDeliveryMock.mockResolvedValue(false);
    recordSlackInboundMessageDeliveriesMock.mockClear();
    resolveThreadTsMock.mockClear();
  });

  it("does not track invalid non-message events from the message stream", async () => {
    const trackEvent = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
      trackEvent,
    });

    await handler(
      {
        type: "reaction_added",
        channel: "D1",
        ts: "123.456",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("does not track duplicate messages that are already seen", async () => {
    const { handler, trackEvent } = createHandlerWithTracker({ markMessageSeen: () => true });

    await handleDirectMessage(handler);

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("tracks accepted non-duplicate messages", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handleDirectMessage(handler);

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("admits trusted reviewer continuations despite the real thread root already being seen", async () => {
    hasSlackInboundMessageDeliveryMock.mockResolvedValue(true);
    const markMessageSeen = vi.fn(() => true);
    const { handler, trackEvent } = createHandlerWithTracker({ markMessageSeen });

    await handler(
      {
        type: "message",
        channel: "C111",
        ts: "1709000000.000100",
        thread_ts: "1709000000.000100",
        parent_user_id: "U_BOT",
        user: "U_BOT",
        text: "private reviewer correction",
        openclaw_synthetic_message_id: "reviewer:C111:1709000000.000100:iteration-1",
      } as never,
      { source: "message", wasMentioned: true, reviewerSynthetic: true },
    );

    expect(hasSlackInboundMessageDeliveryMock).not.toHaveBeenCalled();
    expect(markMessageSeen).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledOnce();
    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(enqueueMock.mock.calls[0]?.[0]).toMatchObject({
      opts: { reviewerSynthetic: true, wasMentioned: true },
    });
  });

  it("records explicit channel type before the first delivery-state await", async () => {
    let settleDeliveryLookup: ((delivered: boolean) => void) | undefined;
    hasSlackInboundMessageDeliveryMock.mockImplementationOnce(
      async () =>
        await new Promise<boolean>((resolve) => {
          settleDeliveryLookup = resolve;
        }),
    );
    const rememberSlackChannelType = vi.fn();
    const { handler } = createHandlerWithTracker({ rememberSlackChannelType });
    const handled = handler(
      {
        type: "message",
        channel: "C0MPDM42",
        channel_type: "mpim",
        user: "U_HUMAN",
        ts: "123.456",
        text: "human seed",
      } as never,
      { source: "message" },
    );

    expect(rememberSlackChannelType).toHaveBeenCalledWith("C0MPDM42", "mpim");
    expect(enqueueMock).not.toHaveBeenCalled();
    settleDeliveryLookup?.(false);
    await handled;
    expect(enqueueMock).toHaveBeenCalledOnce();
  });

  it("accepts thread_broadcast messages from the message stream", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handler(
      {
        type: "message",
        subtype: "thread_broadcast",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000300",
        text: "also send to channel",
        thread_ts: "1709000000.000100",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("drops message subtypes that do not carry user message text", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handler(
      {
        type: "message",
        subtype: "channel_join",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000400",
        text: "<@U111> joined the channel",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("flushes pending top-level buffered keys before immediate non-debounce follow-ups", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000100",
        text: "first buffered text",
      } as never,
      { source: "message" },
    );
    await handler(
      {
        type: "message",
        subtype: "file_share",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000200",
        text: "file follows",
        files: [{ id: "F1" }],
      } as never,
      { source: "message" },
    );

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
  });

  it("waits for debounced dispatch completion when requested by relay delivery", async () => {
    const { handler } = createHandlerWithTracker();
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000500",
        text: "relay message",
      } as never,
      { source: "message", awaitDispatch: true },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    let settled = false;
    void handled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await onFlushCallbacks[0]?.([entry]);
    await expect(handled).resolves.toBeUndefined();
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("propagates debounced dispatch failures to relay delivery", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(new Error("dispatch failed"));
    const { handler } = createHandlerWithTracker();
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000600",
        text: "relay message",
      } as never,
      { source: "message", awaitDispatch: true },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const handledFailure = expect(handled).rejects.toThrow("dispatch failed");
    const flushFailure = expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow("dispatch failed");
    await Promise.all([handledFailure, flushFailure]);
  });

  it("retries native session initialization conflicts through the delivery gates", async () => {
    const releaseSeenMessage = vi.fn();
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", {
        cause: new Error(
          "reply session initialization conflicted for agent:main:main:thread:123.456",
        ),
      }),
    );
    const { handler } = createHandlerWithTracker({ releaseSeenMessage });
    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000700",
        text: "native message",
      } as never,
      { source: "message" },
    );

    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    vi.useFakeTimers();
    try {
      await expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow("Slack dispatch failed");
      await vi.advanceTimersByTimeAsync(1000);

      expect(releaseSeenMessage).toHaveBeenCalledWith("C111", "1709000000.000700");
      expect(recordSlackInboundMessageDeliveriesMock).not.toHaveBeenCalled();
      expect(hasSlackInboundMessageDeliveryMock).toHaveBeenCalledTimes(2);
      expect(enqueueMock).toHaveBeenCalledTimes(2);
      expect(enqueueMock.mock.calls[1]?.[0]).toMatchObject({
        opts: {
          heldRetry: { attempts: 1, sessionInitConflicts: 1 },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves relay session conflict retries to unacknowledged redelivery", async () => {
    const releaseSeenMessage = vi.fn();
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", {
        cause: new Error(
          "reply session initialization conflicted for agent:main:main:thread:123.456",
        ),
      }),
    );
    const { handler } = createHandlerWithTracker({ releaseSeenMessage });
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000800",
        text: "relay message",
      } as never,
      { source: "message", awaitDispatch: true },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    vi.useFakeTimers();
    try {
      const handledFailure = expect(handled).rejects.toThrow("Slack dispatch failed");
      const flushFailure = expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow(
        "Slack dispatch failed",
      );
      await Promise.all([handledFailure, flushFailure]);
      await vi.advanceTimersByTimeAsync(1000);

      expect(releaseSeenMessage).toHaveBeenCalledWith("C111", "1709000000.000800");
      expect(recordSlackInboundMessageDeliveriesMock).not.toHaveBeenCalled();
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles an already-delivered relay event without enqueueing", async () => {
    hasSlackInboundMessageDeliveryMock.mockResolvedValueOnce(true);
    const { handler } = createHandlerWithTracker();

    await expect(
      handler(
        {
          type: "message",
          channel: "C111",
          user: "U111",
          ts: "1709000000.000850",
          text: "relay replay",
        } as never,
        { source: "message", awaitDispatch: true },
      ),
    ).resolves.toBeUndefined();

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("queues an inbound message behind a busy session claim instead of dropping it", async () => {
    const releaseSeenMessage = vi.fn();
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", { cause: new Error(CLAIM_BUSY_ERROR_MESSAGE) }),
    );
    const { handler } = createHandlerWithTracker({ releaseSeenMessage });
    await handler(BUSY_CLAIM_MENTION as never, { source: "app_mention", wasMentioned: true });

    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    vi.useFakeTimers();
    try {
      await expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow("Slack dispatch failed");
      await vi.advanceTimersByTimeAsync(1_000);

      // Recording the delivery here is what made the incident unrecoverable: the seen
      // gate then suppresses every replay of a message no turn ever ran.
      expect(recordSlackInboundMessageDeliveriesMock).not.toHaveBeenCalled();
      expect(releaseSeenMessage).toHaveBeenCalledWith("C0AHSKBNDB6", "1788774766.101659");
      expect(enqueueMock).toHaveBeenCalledTimes(2);
      expect(enqueueMock.mock.calls[1]?.[0]).toMatchObject({
        opts: { heldRetry: { attempts: 1, sessionInitConflicts: 0 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off further on each successive busy-claim retry", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", { cause: new Error(CLAIM_BUSY_ERROR_MESSAGE) }),
    );
    const { handler } = createHandlerWithTracker();
    await handler(BUSY_CLAIM_MENTION as never, { source: "app_mention", wasMentioned: true });

    const entry = enqueueMock.mock.calls[0]?.[0] as {
      message: unknown;
      opts: Record<string, unknown>;
    };
    // A fifth attempt must wait far longer than the first: a busy claim is held for as
    // long as the turn that owns it runs.
    const retriedEntry = withHeldRetry(entry, { attempts: 4 });
    vi.useFakeTimers();
    try {
      await expect(onFlushCallbacks[0]?.([retriedEntry])).rejects.toThrow("Slack dispatch failed");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(enqueueMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(14_000);
      expect(enqueueMock).toHaveBeenCalledTimes(2);
      expect(enqueueMock.mock.calls[1]?.[0]).toMatchObject({
        opts: { heldRetry: { attempts: 5 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("alerts operators, never the thread, once the busy-thread wait has run six hours", async () => {
    const postMessage = vi.fn(async (_payload: Record<string, unknown>) => ({ ok: true }));
    const runtimeError = vi.fn();
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", { cause: new Error(CLAIM_BUSY_ERROR_MESSAGE) }),
    );
    const { handler } = createHandlerWithTracker({ postMessage, runtimeError });
    await handler(BUSY_CLAIM_MENTION as never, { source: "app_mention", wasMentioned: true });

    const spentEntry = withHeldRetry(enqueueMock.mock.calls[0]?.[0], {
      firstFailureAtMs: Date.now() - SIX_HOURS_MS,
      attempts: 360,
    });

    await expect(onFlushCallbacks[0]?.([spentEntry])).rejects.toThrow("Slack dispatch failed");

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(recordSlackInboundMessageDeliveriesMock).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const alert = postMessage.mock.calls[0]?.[0] as {
      channel: string;
      thread_ts?: string;
      text: string;
    };
    expect(alert.channel).toBe(OPS_ALERT_CHANNEL);
    expect(alert.thread_ts).toBeUndefined();
    expect(alert.text).toContain("channel: C0AHSKBNDB6 | ts: 1788774766.101659");
    expect(alert.text).toContain("attempts: 361");
    expect(alert.text).not.toContain("resend");
    expect(runtimeError.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Slack inbound message undeliverable after 6h",
    );
  });

  it("keeps the redelivery's retry clock when Slack's other copy collapses into its batch", async () => {
    const postMessage = vi.fn(async (_payload: Record<string, unknown>) => ({ ok: true }));
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", { cause: new Error(CLAIM_BUSY_ERROR_MESSAGE) }),
    );
    const { handler } = createHandlerWithTracker({ postMessage });
    await handler(BUSY_CLAIM_MENTION as never, { source: "app_mention", wasMentioned: true });
    await handler({ ...BUSY_CLAIM_MENTION, type: "message" } as never, { source: "message" });

    const redelivery = withHeldRetry(enqueueMock.mock.calls[0]?.[0], {
      firstFailureAtMs: Date.now() - SIX_HOURS_MS,
      attempts: 360,
    });
    const messageCopy = enqueueMock.mock.calls[1]?.[0] as Record<string, unknown>;

    await expect(onFlushCallbacks[0]?.([redelivery, messageCopy])).rejects.toThrow(
      "Slack dispatch failed",
    );

    // The collapse keeps the richer message copy; a fresh clock there would restart six hours.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ channel: OPS_ALERT_CHANNEL });
  });

  it("alerts for a spent entry batched with one that is still inside its wait", async () => {
    const postMessage = vi.fn(async (_payload: Record<string, unknown>) => ({ ok: true }));
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", { cause: new Error(CLAIM_BUSY_ERROR_MESSAGE) }),
    );
    const { handler } = createHandlerWithTracker({ postMessage });
    await handler(BUSY_CLAIM_MENTION as never, { source: "app_mention", wasMentioned: true });
    await handler({ ...BUSY_CLAIM_MENTION, ts: "1788774790.000200" } as never, {
      source: "app_mention",
      wasMentioned: true,
    });

    const spent = withHeldRetry(enqueueMock.mock.calls[0]?.[0], {
      firstFailureAtMs: Date.now() - SIX_HOURS_MS,
      attempts: 360,
    });
    const fresh = enqueueMock.mock.calls[1]?.[0] as Record<string, unknown>;
    vi.useFakeTimers();
    try {
      await expect(onFlushCallbacks[0]?.([spent, fresh])).rejects.toThrow("Slack dispatch failed");

      // Dropping the spent entry silently because a sibling kept waiting is the same class of
      // bug as the original incident.
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ channel: OPS_ALERT_CHANNEL });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(enqueueMock).toHaveBeenCalledTimes(3);
      expect(enqueueMock.mock.calls[2]?.[0]).toMatchObject({
        message: { ts: "1788774790.000200" },
        opts: { heldRetry: { attempts: 1 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the short retry budget for session initialization conflicts", async () => {
    const postMessage = vi.fn(async (_payload: Record<string, unknown>) => ({ ok: true }));
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", {
        cause: new Error(
          "reply session initialization conflicted for agent:main:main:thread:123.456",
        ),
      }),
    );
    const { handler } = createHandlerWithTracker({ postMessage });
    await handler(BUSY_CLAIM_MENTION as never, { source: "app_mention", wasMentioned: true });

    // A busy claim would still be inside its wait at this attempt; a session-init conflict,
    // which settles in milliseconds, must not keep retrying for minutes.
    const spent = withHeldRetry(enqueueMock.mock.calls[0]?.[0], {
      attempts: 3,
      sessionInitConflicts: 3,
    });
    vi.useFakeTimers();
    try {
      await expect(onFlushCallbacks[0]?.([spent])).rejects.toThrow("Slack dispatch failed");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ channel: OPS_ALERT_CHANNEL });
      expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty("thread_ts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet when a competing delivery processed the message after all", async () => {
    const postMessage = vi.fn(async (_payload: Record<string, unknown>) => ({ ok: true }));
    const runtimeError = vi.fn();
    hasSlackInboundMessageDeliveryMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", { cause: new Error(CLAIM_BUSY_ERROR_MESSAGE) }),
    );
    const { handler } = createHandlerWithTracker({ postMessage, runtimeError });
    await handler(BUSY_CLAIM_MENTION as never, { source: "app_mention", wasMentioned: true });

    const spent = withHeldRetry(enqueueMock.mock.calls[0]?.[0], {
      firstFailureAtMs: Date.now() - SIX_HOURS_MS,
      attempts: 360,
    });
    await expect(onFlushCallbacks[0]?.([spent])).rejects.toThrow("Slack dispatch failed");

    expect(postMessage).not.toHaveBeenCalled();
    // A post another path delivered is not a failure, so nothing reports it as one.
    expect(runtimeError.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
      "undeliverable",
    );
  });

  it("skips a native retry when another delivery already succeeded", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("reply session initialization conflicted for agent:main:main:thread:123.456"),
    );
    hasSlackInboundMessageDeliveryMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { handler } = createHandlerWithTracker();
    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000900",
        text: "native message",
      } as never,
      { source: "message" },
    );

    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    vi.useFakeTimers();
    try {
      await expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow(
        "reply session initialization conflicted",
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(hasSlackInboundMessageDeliveryMock).toHaveBeenCalledTimes(2);
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
