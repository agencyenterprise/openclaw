// The obligation half of the guard, driven through `createOutboundDedupeGuard`.
// The shape under test is the 2026-09-03 leak: Slack replayed an ask the user had
// deleted next to the user's live re-post, two runs answered the same obligation
// with differently paraphrased text, and the second answer reached the channel
// because the two sends sat under different thread keys.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageSentHookContext } from "../../internal-hooks.js";
import {
  createOutboundDedupeGuard,
  createOutboundSentRecorder,
  DEFAULT_OUTBOUND_DEDUPE_CONFIG,
  type OutboundDedupeConfig,
} from "./guard.js";
import { PENDING_TTL_MS } from "./hash-store.js";
import { type ObligationReservationStore, OUTBOUND_OBLIGATIONS_FILE } from "./obligation-store.js";

const CHANNEL = "C0A3C98HS48";
const REPLAYED_ASK_TS = "1788479206.951729";
const LIVE_ASK_TS = "1788479558.561999";
/** The canonical ask id both answers are for; the replay collapses onto the original. */
const OBLIGATION = `${CHANNEL}:${REPLAYED_ASK_TS}`;
const LIVE_SESSION = `agent:main:slack:channel:c0a3c98hs48:thread:${LIVE_ASK_TS}`;
const REPLAY_SESSION = `agent:main:slack:channel:c0a3c98hs48:thread:${REPLAYED_ASK_TS}`;
const ANSWER = "The ARP capture is on the pod under /workspace/captures, 41 MB.";
const PARAPHRASE = "You will find the capture at /workspace/captures on the pod (41 MB).";
const HOUR_MS = 60 * 60 * 1000;

let workspaceDir = "";
let clock = new Date("2026-09-03T10:00:00.000Z");

function deps(overrides: Partial<OutboundDedupeConfig> = {}) {
  return {
    resolveWorkspaceDir: () => workspaceDir,
    resolveConfig: () => ({ ...DEFAULT_OUTBOUND_DEDUPE_CONFIG, ...overrides }),
    now: () => clock,
  };
}

function ctxFor(sessionKey: string) {
  return { channelId: "slack", conversationId: `channel:${CHANNEL}`, sessionKey };
}

/** The answer the bot posted in the live ask's thread. */
function threadedAnswer(content = ANSWER, metadata: Record<string, unknown> = {}) {
  return {
    to: `channel:${CHANNEL}`,
    content,
    threadId: LIVE_ASK_TS,
    metadata: { obligationId: OBLIGATION, ...metadata },
  };
}

/** The answer that leaked: same obligation, another run, no thread left to post into. */
function topLevelAnswer(content = PARAPHRASE, metadata: Record<string, unknown> = {}) {
  return {
    to: `channel:${CHANNEL}`,
    content,
    metadata: { obligationId: OBLIGATION, ...metadata },
  };
}

function sentCtx(content: string, success = true): MessageSentHookContext {
  return { to: `channel:${CHANNEL}`, content, success, channelId: "slack", messageId: "9.9" };
}

function obligationFile(): string {
  return path.join(workspaceDir, "state", OUTBOUND_OBLIGATIONS_FILE);
}

async function readObligations(): Promise<ObligationReservationStore> {
  return JSON.parse(await fs.readFile(obligationFile(), "utf-8")) as ObligationReservationStore;
}

function advance(ms: number) {
  clock = new Date(clock.getTime() + ms);
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-obligation-guard-"));
  clock = new Date("2026-09-03T10:00:00.000Z");
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("outbound-dedupe obligation reservation", () => {
  it("does not read delivery's re-fire of one send as a second answer, even past the burst", async () => {
    // The inbound dispatcher fires `message_sending`, then core outbound delivery
    // fires it again for the same payload. The holder burst cannot cover that gap
    // — a queued send takes as long as it takes — so the send identity has to.
    const guard = createOutboundDedupeGuard(deps({ answerBurstSeconds: 60 }));
    const sendNonce = "0f5a6b7c-1111-4d2e-8a3f-9b0c1d2e3f40";

    expect(
      await guard(threadedAnswer(ANSWER, { sendNonce }), ctxFor(LIVE_SESSION)),
    ).toBeUndefined();
    advance(61_000);
    expect(
      await guard(threadedAnswer(ANSWER, { sendNonce }), ctxFor(LIVE_SESSION)),
    ).toBeUndefined();

    // A genuinely different send answering the same ask is still refused.
    const reAnswer = await guard(
      topLevelAnswer(PARAPHRASE, { sendNonce: "9e8d7c6b-2222-4a1b-9c8d-7e6f5a4b3c21" }),
      ctxFor(REPLAY_SESSION),
    );
    expect(reAnswer?.cancel).toBe(true);
    expect(reAnswer?.cancelReason).toContain(OBLIGATION);
  });

  it("cancels a second answer to one obligation even when the text is completely different", async () => {
    const guard = createOutboundDedupeGuard(deps());

    expect(await guard(threadedAnswer(), ctxFor(LIVE_SESSION))).toBeUndefined();
    const second = await guard(topLevelAnswer(), ctxFor(REPLAY_SESSION));

    expect(second?.cancel).toBe(true);
    expect(second?.cancelReason).toContain(OBLIGATION);
  });

  it("collapses a threaded reply and a top-level post onto one key", async () => {
    const guard = createOutboundDedupeGuard(deps());
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));

    expect(Object.keys(await readObligations())).toEqual([
      `${CHANNEL}:${REPLAYED_ASK_TS}:${OBLIGATION}:v0`,
    ]);
    expect((await guard(topLevelAnswer(), ctxFor(REPLAY_SESSION)))?.cancel).toBe(true);
  });

  it("takes the reservation before the send, so two concurrent answers never both pass", async () => {
    const guard = createOutboundDedupeGuard(deps());

    expect(await guard(threadedAnswer(), ctxFor(LIVE_SESSION))).toBeUndefined();
    const store = await readObligations();
    expect(store[`${CHANNEL}:${REPLAYED_ASK_TS}:${OBLIGATION}:v0`]).toMatchObject({
      holder: LIVE_SESSION,
    });
    expect(store[`${CHANNEL}:${REPLAYED_ASK_TS}:${OBLIGATION}:v0`]?.confirmedAt).toBeUndefined();
  });

  it("cancels all but one of a set of concurrent answers to the same obligation", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const results = await Promise.all([
      guard(threadedAnswer(), ctxFor(LIVE_SESSION)),
      guard(topLevelAnswer(), ctxFor(REPLAY_SESSION)),
      guard(topLevelAnswer(`${PARAPHRASE} Ping me if it is gone.`), ctxFor("agent:main:main")),
    ]);

    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(results.filter((result) => result?.cancel === true)).toHaveLength(2);
  });

  it("lets an answer to a different obligation in the same thread go out", async () => {
    const guard = createOutboundDedupeGuard(deps());
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));

    expect(
      await guard(
        threadedAnswer(PARAPHRASE, { obligationId: `${CHANNEL}:${LIVE_ASK_TS}` }),
        ctxFor(LIVE_SESSION),
      ),
    ).toBeUndefined();
  });

  it("lets a deliberate follow-up with a new response version go out", async () => {
    const guard = createOutboundDedupeGuard(deps());
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));
    advance(30 * 60 * 1000);

    expect(
      await guard(
        threadedAnswer("Correction: the capture is 62 MB, not 41 MB.", { responseVersion: 1 }),
        ctxFor(REPLAY_SESSION),
      ),
    ).toBeUndefined();
    expect(
      (
        await guard(
          threadedAnswer("Correction again: it is 62 MB.", { responseVersion: 1 }),
          ctxFor(LIVE_SESSION),
        )
      )?.cancel,
    ).toBe(true);
  });

  it("derives the obligation from the message a reply answers", async () => {
    const guard = createOutboundDedupeGuard(deps());
    // A reply to one message inside a thread: the target names that ask, not the
    // thread, so it is safe to derive an obligation from it.
    const reply = (content: string) => ({
      to: `channel:${CHANNEL}`,
      content,
      threadId: LIVE_ASK_TS,
      replyToId: REPLAYED_ASK_TS,
    });

    expect(await guard(reply(ANSWER), ctxFor(REPLAY_SESSION))).toBeUndefined();
    expect((await guard(reply(PARAPHRASE), ctxFor(LIVE_SESSION)))?.cancel).toBe(true);
  });

  // The 2026-09-04 mute, second mechanism: two sends were cancelled under
  // `C0AHSKBNDB6:1788473062.847669:...` with `source: "reply-target"` because a
  // threaded reply's target IS the thread root, which every ask in that thread
  // shares. Such a send names no single ask and must not reserve one.
  it("derives no obligation from a reply that targets the root of its own thread", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const threadRootReply = (content: string) => ({
      to: `channel:${CHANNEL}`,
      content,
      threadId: LIVE_ASK_TS,
      replyToId: LIVE_ASK_TS,
    });

    expect(await guard(threadRootReply(ANSWER), ctxFor(LIVE_SESSION))).toBeUndefined();
    // A different ask in the same thread, answered after the burst, still goes out.
    advance(10 * 60 * 1000);
    expect(await guard(threadRootReply(PARAPHRASE), ctxFor(LIVE_SESSION))).toBeUndefined();
  });

  it("keeps the holder's own payload chunks going out and stops it re-answering later", async () => {
    const guard = createOutboundDedupeGuard(deps({ answerBurstSeconds: 60 }));
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));

    advance(500);
    expect(await guard(threadedAnswer(PARAPHRASE), ctxFor(LIVE_SESSION))).toBeUndefined();
    advance(60 * 1000);
    expect(
      (await guard(threadedAnswer("Third take on the same ask."), ctxFor(LIVE_SESSION)))?.cancel,
    ).toBe(true);
  });

  it("holds the obligation for the window once the send is confirmed", async () => {
    const guard = createOutboundDedupeGuard(deps({ windowHours: 1 }));
    const record = createOutboundSentRecorder(deps({ windowHours: 1 }));
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));
    await record(sentCtx(ANSWER), LIVE_SESSION);

    expect(Object.values(await readObligations())[0]?.confirmedAt).toBe(clock.toISOString());
    advance(PENDING_TTL_MS + 1_000);
    expect((await guard(topLevelAnswer(), ctxFor(REPLAY_SESSION)))?.cancel).toBe(true);
    advance(HOUR_MS);
    expect(await guard(topLevelAnswer(), ctxFor(REPLAY_SESSION))).toBeUndefined();
  });

  it("releases the obligation when the send failed, so the answer can be retried", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const record = createOutboundSentRecorder(deps());
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));
    await record(sentCtx(ANSWER, false), LIVE_SESSION);

    expect(await readObligations()).toEqual({});
    advance(10 * 60 * 1000);
    expect(await guard(topLevelAnswer(), ctxFor(REPLAY_SESSION))).toBeUndefined();
  });

  // The 2026-09-04 shape: the agent kept its final reply private (message_tool_only,
  // no message tool call), so nothing was delivered and no `message:sent` arrived.
  // The next attempt at that same ask has to go through.
  it("lets the next attempt through when the first one never reached the channel", async () => {
    const guard = createOutboundDedupeGuard(deps({ answerBurstSeconds: 60 }));
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));

    // No message:sent at all: the reservation stays pending and expires.
    advance(PENDING_TTL_MS + 1_000);
    expect(await guard(threadedAnswer(PARAPHRASE), ctxFor(LIVE_SESSION))).toBeUndefined();
  });

  it("does not hold the obligation for the window on a send with no platform message id", async () => {
    const guard = createOutboundDedupeGuard(deps({ windowHours: 24 }));
    const record = createOutboundSentRecorder(deps({ windowHours: 24 }));
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));
    // An ephemeral slash reply, a suppressed silent token or a stream ack: it
    // reports success and names no message that landed.
    await record({ ...sentCtx(ANSWER), messageId: undefined }, LIVE_SESSION);

    expect(Object.values(await readObligations())[0]?.confirmedAt).toBeUndefined();
    advance(PENDING_TTL_MS + 1_000);
    expect(await guard(threadedAnswer(PARAPHRASE), ctxFor(LIVE_SESSION))).toBeUndefined();
  });

  // The content hash must follow the same rule, or an unconfirmed send still
  // blocks the SAME answer for the window even though its obligation expired.
  it("does not hold the content hash for the window on a send with no platform message id", async () => {
    const guard = createOutboundDedupeGuard(deps({ windowHours: 24 }));
    const record = createOutboundSentRecorder(deps({ windowHours: 24 }));
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));
    await record({ ...sentCtx(ANSWER), messageId: undefined }, LIVE_SESSION);

    advance(PENDING_TTL_MS + 1_000);
    // The very same text, re-sent after the reservations expired.
    expect(await guard(threadedAnswer(ANSWER), ctxFor(LIVE_SESSION))).toBeUndefined();
  });

  it("does not confirm on the parent_deleted sentinel, whose answer never reached Slack", async () => {
    const guard = createOutboundDedupeGuard(deps({ windowHours: 24 }));
    const record = createOutboundSentRecorder(deps({ windowHours: 24 }));
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));
    await record({ ...sentCtx(ANSWER), messageId: "parent_deleted" }, LIVE_SESSION);

    expect(Object.values(await readObligations())[0]?.confirmedAt).toBeUndefined();
  });

  it("guards a short answer that the content hash ignores", async () => {
    const guard = createOutboundDedupeGuard(deps());

    expect(await guard(threadedAnswer("Yes."), ctxFor(LIVE_SESSION))).toBeUndefined();
    expect((await guard(topLevelAnswer("No."), ctxFor(REPLAY_SESSION)))?.cancel).toBe(true);
  });

  it("cancels the send when the obligation store is unreachable, and leaves other sends alone", async () => {
    // A directory where the store file belongs: every read and write of it throws.
    await fs.mkdir(obligationFile(), { recursive: true });
    const guard = createOutboundDedupeGuard(deps());

    const blocked = await guard(threadedAnswer(), ctxFor(LIVE_SESSION));
    expect(blocked?.cancel).toBe(true);
    expect(blocked?.cancelReason).toContain("obligation store unreachable");

    expect(
      await guard(
        { to: `channel:${CHANNEL}`, content: "[hcom-bridge] reconciliation required now" },
        ctxFor("agent:main:main"),
      ),
    ).toBeUndefined();
  });

  it("does not leave the cancelled send's content hash behind", async () => {
    const guard = createOutboundDedupeGuard(deps());
    await guard(threadedAnswer(), ctxFor(LIVE_SESSION));
    expect((await guard(topLevelAnswer(), ctxFor(REPLAY_SESSION)))?.cancel).toBe(true);

    // The cancelled paraphrase must still be sendable for another obligation:
    // its pending hash reservation was released when the obligation cancelled it.
    expect(
      await guard(
        topLevelAnswer(PARAPHRASE, { obligationId: `${CHANNEL}:${LIVE_ASK_TS}` }),
        ctxFor(REPLAY_SESSION),
      ),
    ).toBeUndefined();
  });

  it("leaves the content-hash guard exactly as it was for sends with no obligation", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const announce = (content: string) => ({ to: `channel:${CHANNEL}`, content });
    const text = "[hcom-bridge] reconciliation required: worker state drifted from hcom.db";

    expect(await guard(announce(text), ctxFor("agent:main:main"))).toBeUndefined();
    expect((await guard(announce(text), ctxFor("agent:main:main")))?.cancel).toBe(true);
    expect(
      await guard(announce(`${text} plus a new finding`), ctxFor("agent:main:main")),
    ).toBeUndefined();
    await expect(fs.readFile(obligationFile(), "utf-8")).rejects.toThrow();
  });
});
