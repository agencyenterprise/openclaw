// Slack tests cover dropping threaded replies whose parent message was deleted.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

const triggerInternalHook = vi.hoisted(() => vi.fn(async (_event: unknown) => {}));
const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: () => messageHookRunner,
  };
});

import { deliverReplies } from "./replies.js";

// The incident thread: the user deleted this message during an outage and Slack
// replayed it on reconnect, so its parent no longer exists.
const THREAD_TS = "1788479206.951729";
const CHANNEL = "C123";
const SESSION_KEY = `agent:main:slack:channel:c0a3c98hs48:thread:${THREAD_TS}`;
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

function slackApiError(code: string) {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
}

function threadedParams(overrides?: Record<string, unknown>) {
  return {
    cfg: SLACK_TEST_CFG,
    replies: [{ text: "the answer" }],
    target: CHANNEL,
    token: "xoxb-test",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    textLimit: 4000,
    replyToMode: "all" as const,
    replyThreadTs: THREAD_TS,
    sessionKeyForInternalHooks: SESSION_KEY,
    ...overrides,
  };
}

function sentHookContexts(): Record<string, unknown>[] {
  return triggerInternalHook.mock.calls.map(
    ([event]) => (event as { context: Record<string, unknown> }).context,
  );
}

function sentThreadTsValues(): unknown[] {
  return sendMock.mock.calls.map((call) => (call[2] as Record<string, unknown>).threadTs);
}

function loggedMessages(runtime: { log: ReturnType<typeof vi.fn> }): string[] {
  return runtime.log.mock.calls.map((call) => String(call[0]));
}

describe("deliverReplies thread_not_found handling", () => {
  beforeEach(() => {
    sendMock.mockReset();
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSent.mockReset();
    triggerInternalHook.mockReset();
  });

  it("drops the reply instead of posting it at the channel root", async () => {
    sendMock.mockRejectedValue(slackApiError("thread_not_found"));
    const params = threadedParams();

    await expect(deliverReplies(params)).resolves.toBeUndefined();

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sentThreadTsValues()).toEqual([THREAD_TS]);
  });

  it("warns with the channel and thread_ts of the deleted parent", async () => {
    sendMock.mockRejectedValue(slackApiError("thread_not_found"));
    const params = threadedParams();

    await deliverReplies(params);

    const warning = loggedMessages(params.runtime).find((message) =>
      message.includes("parent message was deleted"),
    );
    expect(warning).toBeDefined();
    expect(warning).toContain(CHANNEL);
    expect(warning).toContain(THREAD_TS);
  });

  it("reports the parent_deleted answer timestamp so the ask ledger can close the ask", async () => {
    sendMock.mockRejectedValue(slackApiError("thread_not_found"));

    await deliverReplies(threadedParams());

    expect(sentHookContexts()).toEqual([
      expect.objectContaining({
        channelId: "slack",
        conversationId: CHANNEL,
        content: expect.stringContaining("the answer"),
        success: true,
        messageId: "parent_deleted",
      }),
    ]);
  });

  it("still fails loudly when a top-level send reports thread_not_found", async () => {
    sendMock.mockRejectedValue(slackApiError("thread_not_found"));
    const params = threadedParams({ replyToMode: "off" as const, replyThreadTs: undefined });

    await expect(deliverReplies(params)).rejects.toThrow(/thread_not_found/);

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sentThreadTsValues()).toEqual([undefined]);
  });

  it("keeps the existing failure behaviour for every other Slack error", async () => {
    sendMock.mockRejectedValue(slackApiError("ratelimited"));
    const params = threadedParams();

    await expect(deliverReplies(params)).rejects.toThrow(/ratelimited/);

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sentThreadTsValues()).toEqual([THREAD_TS]);
    expect(sentHookContexts()).toEqual([
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("ratelimited"),
      }),
    ]);
    expect(
      loggedMessages(params.runtime).some((message) =>
        message.includes("parent message was deleted"),
      ),
    ).toBe(false);
  });
});
