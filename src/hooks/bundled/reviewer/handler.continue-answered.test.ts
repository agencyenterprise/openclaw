/**
 * Tests for reviewerContinueAnswered — the idempotency check that decides whether a
 * dispatched reviewer continue has already been answered by the agent. The key property
 * (and the bug it fixes): a later HUMAN message must NOT un-answer a continue, and a reply
 * is only "answering" if it lands AFTER the dispatch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySlackThreadMessageRole,
  engageAnswered,
  reviewerContinueAnswered,
} from "./handler.js";

const BOT = "UBOT";
const DISPATCH_MS = 1_779_000_000_000; // /1000 - 60 → threshold ts 1779000000 - 60 = 1778999940

function stubThread(
  messages: Array<{
    user?: string;
    text?: string;
    ts?: string;
    edited?: { ts?: string };
  }>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, messages, has_more: false }), {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

const call = () =>
  reviewerContinueAnswered({
    token: "xoxb-test",
    botUserId: BOT,
    channelId: "C0AHSKBNDB6",
    threadTs: "1779000000.000000",
  });

const privateCall = () =>
  reviewerContinueAnswered({
    token: "xoxb-test",
    botUserId: BOT,
    channelId: "C0AHSKBNDB6",
    threadTs: "1779000000.000000",
    dispatchedAtMs: DISPATCH_MS,
  });

const REVIEWER_POST = { user: BOT, text: "🔍 *Reviewer:* fix the thing", ts: "1779000003.000000" };

describe("classifySlackThreadMessageRole", () => {
  it("recognizes an app bot as the assistant when hook context omitted botUserId", () => {
    expect(classifySlackThreadMessageRole({ user: "UAPP", bot_id: "BAPP" })).toBe("Assistant");
  });

  it("does not classify a human as the assistant when botUserId is absent", () => {
    expect(classifySlackThreadMessageRole({ user: "UHUMAN" })).toBe("User (UHUMAN)");
  });
});

describe("reviewerContinueAnswered (clock-free: answer must follow the reviewer's post)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("true when a non-reviewer bot reply follows the latest reviewer post", async () => {
    stubThread([REVIEWER_POST, { user: BOT, text: "done", ts: "1779000005.000000" }]);
    await expect(call()).resolves.toBe(true);
  });

  it("false when there is no bot reply after the reviewer post", async () => {
    stubThread([REVIEWER_POST]);
    await expect(call()).resolves.toBe(false);
  });

  it("false when the only bot reply PRECEDES the reviewer post (the reviewed reply)", async () => {
    stubThread([{ user: BOT, text: "earlier reply", ts: "1779000001.000000" }, REVIEWER_POST]);
    await expect(call()).resolves.toBe(false);
  });

  it("true even when a HUMAN posts after the agent's reply (a later human does not un-answer)", async () => {
    stubThread([
      REVIEWER_POST,
      { user: BOT, text: "done", ts: "1779000005.000000" },
      { user: "UHUMAN", text: "thanks!", ts: "1779000010.000000" },
    ]);
    await expect(call()).resolves.toBe(true);
  });

  it("false when there is no reviewer post at all (no dispatch marker → re-engage)", async () => {
    stubThread([{ user: BOT, text: "some reply", ts: "1779000005.000000" }]);
    await expect(call()).resolves.toBe(false);
  });

  it("true in private mode when the prior answer was edited after dispatch", async () => {
    stubThread([
      {
        user: BOT,
        text: "corrected answer",
        ts: "1778999900.000000",
        edited: { ts: "1779000001.000000" },
      },
    ]);
    await expect(privateCall()).resolves.toBe(true);
  });

  it("false in private mode when the prior edit predates dispatch", async () => {
    stubThread([
      {
        user: BOT,
        text: "old answer",
        ts: "1778999900.000000",
        edited: { ts: "1778999990.000000" },
      },
    ]);
    await expect(privateCall()).resolves.toBe(false);
  });

  it("false (no-loss bias) when the Slack fetch errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: "thread_not_found" }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(call()).resolves.toBe(false);
  });
});

const engage = () =>
  engageAnswered({
    token: "xoxb-test",
    botUserId: BOT,
    channelId: "C0AHSKBNDB6",
    threadTs: "1779000000.000000",
  });

describe("engageAnswered (engage-row recovery check — reply must be the latest)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("true when the bot's reply is the latest substantive message", async () => {
    stubThread([{ user: BOT, text: "handled it", ts: "1779000005.000000" }]);
    await expect(engage()).resolves.toBe(true);
  });

  it("true when an engage row was recreated after the latest bot reply", async () => {
    stubThread([
      { user: "UHUMAN", text: "@bot please help", ts: "1778999900.000000" },
      { user: BOT, text: "handled it", ts: "1778999905.000000" },
    ]);
    await expect(engage()).resolves.toBe(true);
  });

  it("false when a human message is newer than the bot's reply (re-engage)", async () => {
    stubThread([
      { user: BOT, text: "handled it", ts: "1779000005.000000" },
      { user: "UHUMAN", text: "actually, also do X", ts: "1779000010.000000" },
    ]);
    await expect(engage()).resolves.toBe(false);
  });

  it("false when there is no bot reply at all (re-engage)", async () => {
    stubThread([{ user: "UHUMAN", text: "@bot please help", ts: "1779000005.000000" }]);
    await expect(engage()).resolves.toBe(false);
  });

  it("does not count the reviewer's own feedback post as the bot's reply", async () => {
    stubThread([{ user: BOT, text: "🔍 *Reviewer:* do the thing", ts: "1779000005.000000" }]);
    await expect(engage()).resolves.toBe(false);
  });
});
