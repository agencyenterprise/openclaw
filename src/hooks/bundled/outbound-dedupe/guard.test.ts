import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageSentHookContext } from "../../internal-hooks.js";
import { fingerprintOutboundContent } from "./content-fingerprint.js";
import {
  buildThreadKey,
  createOutboundDedupeGuard,
  createOutboundSentRecorder,
  DEFAULT_OUTBOUND_DEDUPE_CONFIG,
  type OutboundDedupeConfig,
} from "./guard.js";
import { OUTBOUND_HASHES_FILE, PENDING_TTL_MS, type OutboundHashStore } from "./hash-store.js";

const SESSION = "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609";
const LONG_TEXT = "[hcom-bridge] reconciliation required: worker state drifted from hcom.db";
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

function slackCtx(sessionKey = SESSION) {
  return { channelId: "slack", conversationId: "channel:C0A3C98HS48", sessionKey };
}

function sentCtx(content: string, success = true): MessageSentHookContext {
  return { to: "channel:C0A3C98HS48", content, success, channelId: "slack", messageId: "9.9" };
}

async function readStore(): Promise<OutboundHashStore> {
  return JSON.parse(
    await fs.readFile(path.join(workspaceDir, "state", OUTBOUND_HASHES_FILE), "utf-8"),
  ) as OutboundHashStore;
}

function advance(ms: number) {
  clock = new Date(clock.getTime() + ms);
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-dedupe-"));
  clock = new Date("2026-09-03T10:00:00.000Z");
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

function countEntries(store: OutboundHashStore): number {
  return Object.values(store).reduce((total, entries) => total + entries.length, 0);
}

describe("one physical send that fires the hook twice", () => {
  // The inbound dispatcher runs `message_sending` before it hands the payload to
  // delivery, and durable channel delivery runs it again for the same payload.
  // Both fires quote one `sendNonce`, so the second must not read the first
  // fire's own reservation as a duplicate and cancel a send that never went out.
  const NONCE = "6b3d9f2e-0000-4a1a-9c11-1f2e3d4c5b6a";

  it("does not cancel the second fire of the send it already reserved", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const event = {
      to: "channel:C0A3C98HS48",
      content: LONG_TEXT,
      metadata: { sendNonce: NONCE },
    };

    expect(await guard(event, slackCtx())).toBeUndefined();
    expect(await guard(event, slackCtx())).toBeUndefined();
    expect(countEntries(await readStore())).toBe(1);
  });

  it("keeps one reservation, fingerprinting the text the channel actually sends", async () => {
    const rendered = `${LONG_TEXT} (rendered by the channel)`;
    const guard = createOutboundDedupeGuard(deps());
    // Fire 1 is the dispatcher: no thread id, the payload text as authored.
    expect(
      await guard(
        { to: "channel:C0A3C98HS48", content: LONG_TEXT, metadata: { sendNonce: NONCE } },
        slackCtx(),
      ),
    ).toBeUndefined();
    // Fire 2 is delivery: it knows the thread id, and the channel re-rendered the
    // text, so both the thread key and the content hash differ from fire 1.
    expect(
      await guard(
        {
          to: "channel:C0A3C98HS48",
          content: rendered,
          threadId: "1786591963.108609",
          metadata: { sendNonce: NONCE },
        },
        slackCtx(),
      ),
    ).toBeUndefined();

    const entries = Object.values(await readStore()).flat();
    expect(entries).toHaveLength(1);
    // The reservation now fingerprints what goes to the channel, not the earlier
    // text the dispatcher saw; otherwise a later repeat of the sent message would
    // not match anything and would go out twice.
    expect(entries[0]?.hash).toBe(fingerprintOutboundContent(rendered));

    const recorder = createOutboundSentRecorder(deps());
    await recorder(sentCtx(rendered), SESSION);
    const confirmed = Object.values(await readStore())
      .flat()
      .filter((entry) => entry.confirmedAt !== undefined);
    expect(confirmed).toHaveLength(1);
    // And the delivered text is now guarded like any other confirmed send.
    const repeat = await guard({ to: "channel:C0A3C98HS48", content: rendered }, slackCtx());
    expect(repeat?.cancel).toBe(true);
  });

  it("refuses a replay that quotes the nonce of an already delivered send", async () => {
    // A nonce identifies one send attempt, not the payload for ever: once the
    // send is confirmed, a payload replayed with the same nonce is a duplicate.
    const guard = createOutboundDedupeGuard(deps());
    const event = {
      to: "channel:C0A3C98HS48",
      content: LONG_TEXT,
      metadata: { sendNonce: NONCE },
    };
    expect(await guard(event, slackCtx())).toBeUndefined();
    await createOutboundSentRecorder(deps())(sentCtx(LONG_TEXT), SESSION);

    const replay = await guard(event, slackCtx());
    expect(replay?.cancel).toBe(true);
    expect(replay?.cancelReason).toContain("outbound-dedupe");
  });

  it("still cancels a genuine repeat that is a different send", async () => {
    const guard = createOutboundDedupeGuard(deps());
    expect(
      await guard(
        { to: "channel:C0A3C98HS48", content: LONG_TEXT, metadata: { sendNonce: NONCE } },
        slackCtx(),
      ),
    ).toBeUndefined();
    const repeat = await guard(
      {
        to: "channel:C0A3C98HS48",
        content: LONG_TEXT,
        metadata: { sendNonce: "a-different-send-entirely" },
      },
      slackCtx(),
    );
    expect(repeat?.cancel).toBe(true);
    expect(repeat?.cancelReason).toContain("outbound-dedupe");
  });
});

describe("outbound-dedupe guard", () => {
  it("lets the first send through and cancels the identical repeat", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const event = { to: "channel:C0A3C98HS48", content: LONG_TEXT };

    expect(await guard(event, slackCtx())).toBeUndefined();
    const second = await guard(event, slackCtx());
    expect(second?.cancel).toBe(true);
    expect(second?.cancelReason).toContain("outbound-dedupe");
  });

  it("treats timestamp-only differences as duplicates but keeps counters distinct", async () => {
    const guard = createOutboundDedupeGuard(deps());
    await guard(
      { to: "C0A3C98HS48", content: "Reconciliation required, last checked 10:05 UTC 2026-09-03." },
      slackCtx(),
    );
    const repeat = await guard(
      { to: "C0A3C98HS48", content: "Reconciliation required, last checked 23:59 UTC 2026-09-04." },
      slackCtx(),
    );
    expect(repeat?.cancel).toBe(true);
    expect(
      await guard(
        { to: "C0A3C98HS48", content: "Foundry stale for 1219 min, restart attempted" },
        slackCtx(),
      ),
    ).toBeUndefined();
    expect(
      await guard(
        { to: "C0A3C98HS48", content: "Foundry stale for 1284 min, restart attempted" },
        slackCtx(),
      ),
    ).toBeUndefined();
  });

  it("allows different content and the same content in another thread", async () => {
    const guard = createOutboundDedupeGuard(deps());
    await guard({ to: "C0A3C98HS48", content: LONG_TEXT }, slackCtx());

    expect(
      await guard({ to: "C0A3C98HS48", content: `${LONG_TEXT} plus a new finding` }, slackCtx()),
    ).toBeUndefined();
    expect(
      await guard(
        { to: "C0A3C98HS48", content: LONG_TEXT },
        slackCtx("agent:main:slack:channel:c0a3c98hs48:thread:1.1"),
      ),
    ).toBeUndefined();
  });

  it("confirms a reservation on message:sent and keeps it for the whole window", async () => {
    const guard = createOutboundDedupeGuard(deps({ windowHours: 1 }));
    const record = createOutboundSentRecorder(deps({ windowHours: 1 }));
    await guard({ to: "C0A3C98HS48", content: LONG_TEXT }, slackCtx());
    await record(sentCtx(LONG_TEXT), SESSION);

    const store = await readStore();
    const key = buildThreadKey({ to: "C0A3C98HS48", content: "" }, slackCtx());
    expect(store[key]?.[0]?.confirmedAt).toBe(clock.toISOString());

    advance(PENDING_TTL_MS + 1_000);
    expect((await guard({ to: "C0A3C98HS48", content: LONG_TEXT }, slackCtx()))?.cancel).toBe(true);
    advance(HOUR_MS);
    expect(await guard({ to: "C0A3C98HS48", content: LONG_TEXT }, slackCtx())).toBeUndefined();
  });

  it("expires an unconfirmed reservation after the pending TTL", async () => {
    const guard = createOutboundDedupeGuard(deps());
    await guard({ to: "C0A3C98HS48", content: LONG_TEXT }, slackCtx());
    advance(PENDING_TTL_MS - 1_000);
    expect((await guard({ to: "C0A3C98HS48", content: LONG_TEXT }, slackCtx()))?.cancel).toBe(true);
    advance(2_000);
    expect(await guard({ to: "C0A3C98HS48", content: LONG_TEXT }, slackCtx())).toBeUndefined();
  });

  it("lets a retry pass right after a failed send", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const record = createOutboundSentRecorder(deps());
    await guard({ to: "C0A3C98HS48", content: LONG_TEXT }, slackCtx());
    await record(sentCtx(LONG_TEXT, false), SESSION);

    expect(await guard({ to: "C0A3C98HS48", content: LONG_TEXT }, slackCtx())).toBeUndefined();
  });

  it("confirms an announce reserved with an explicit threadId from a session-keyed message:sent", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const record = createOutboundSentRecorder(deps());
    await guard(
      { to: "channel:C0A3C98HS48", content: LONG_TEXT, threadId: "1786591963.108609" },
      { channelId: "slack", conversationId: "channel:C0A3C98HS48", sessionKey: "agent:main:main" },
    );
    await record(sentCtx(LONG_TEXT), "agent:main:main");

    const store = await readStore();
    expect(store["slack:C0A3C98HS48:1786591963.108609"]?.[0]?.confirmedAt).toBeDefined();
  });

  it("confirms the oldest pending reservation when the channel rendered the text", async () => {
    const guard = createOutboundDedupeGuard(deps({ windowHours: 1 }));
    const record = createOutboundSentRecorder(deps({ windowHours: 1 }));
    await guard({ to: "C0A3C98HS48", content: `**bold** ${LONG_TEXT}` }, slackCtx());
    await record(sentCtx(`*bold* ${LONG_TEXT}`), SESSION);

    advance(PENDING_TTL_MS + 1_000);
    expect(
      (await guard({ to: "C0A3C98HS48", content: `**bold** ${LONG_TEXT}` }, slackCtx()))?.cancel,
    ).toBe(true);
  });

  it("keeps non-Slack targets verbatim in the thread key", () => {
    expect(buildThreadKey({ to: "!ops:Example", content: "" }, { channelId: "matrix" })).toBe(
      "matrix:!ops:Example:root",
    );
  });

  it("never deduplicates short acknowledgements", async () => {
    const guard = createOutboundDedupeGuard(deps());
    await guard({ to: "C0A3C98HS48", content: "OK" }, slackCtx());
    expect(await guard({ to: "C0A3C98HS48", content: "OK" }, slackCtx())).toBeUndefined();
  });

  it("keeps only the last maxPerThread hashes", async () => {
    const guard = createOutboundDedupeGuard(deps({ maxPerThread: 2 }));
    for (const suffix of ["one", "two", "three"]) {
      await guard({ to: "C0A3C98HS48", content: `${LONG_TEXT} ${suffix}` }, slackCtx());
    }
    const key = buildThreadKey({ to: "C0A3C98HS48", content: "" }, slackCtx());
    expect((await readStore())[key]).toHaveLength(2);
    expect(
      await guard({ to: "C0A3C98HS48", content: `${LONG_TEXT} one` }, slackCtx()),
    ).toBeUndefined();
  });

  it("uses the explicit threadId for cron and heartbeat announces", () => {
    expect(
      buildThreadKey(
        { to: "channel:C0A3C98HS48", content: "", threadId: "1786591963.108609" },
        { channelId: "slack", conversationId: "channel:C0A3C98HS48" },
      ),
    ).toBe("slack:C0A3C98HS48:1786591963.108609");
    expect(buildThreadKey({ to: "C0A3C98HS48", content: "" }, { channelId: "slack" })).toBe(
      "slack:C0A3C98HS48:root",
    );
  });
});

describe("an acknowledgement followed by the answer to the same ask", () => {
  // 2026-09-22, #C0C303K80UQ thread 1790097322.070849: the run posted "I'll review
  // the ESR bundle…" at 13:17:59 EDT and its 2028-char review at 13:38:20 EDT was
  // cancelled as "a second answer for one obligation". Both sends declared the ask
  // C0C303K80UQ:1790097410.218249 and came from the same session.
  const ESR_SESSION = "agent:main:slack:channel:c0c303k80uq:thread:1790097322.070849";
  const ESR_ASK = "C0C303K80UQ:1790097410.218249";
  const ACK = "I'll review the ESR bundle and the two papers, then reply here shortly.";
  const ANSWER =
    "My read: these papers sharpen the ESR question; they don't settle whether stakes change the reading.";
  const ACK_TO_ANSWER_MS = (20 * 60 + 21) * 1_000;

  function esrCtx(sessionKey = ESR_SESSION) {
    return { channelId: "slack", conversationId: "channel:C0C303K80UQ", sessionKey };
  }

  function replyToAsk(content: string) {
    return {
      to: "channel:C0C303K80UQ",
      content,
      threadId: "1790097322.070849",
      metadata: { obligationId: ESR_ASK },
    };
  }

  function confirmedSend(content: string): MessageSentHookContext {
    return {
      to: "channel:C0C303K80UQ",
      content,
      success: true,
      channelId: "slack",
      messageId: "1790097479.244900",
    };
  }

  it("delivers the answer that follows a confirmed acknowledgement", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const record = createOutboundSentRecorder(deps());

    expect(await guard(replyToAsk(ACK), esrCtx())).toBeUndefined();
    await record(confirmedSend(ACK), ESR_SESSION);
    advance(ACK_TO_ANSWER_MS);

    expect(await guard(replyToAsk(ANSWER), esrCtx())).toBeUndefined();
  });

  it("delivers a reply to the same ask from another session", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const record = createOutboundSentRecorder(deps());

    expect(await guard(replyToAsk(ACK), esrCtx())).toBeUndefined();
    await record(confirmedSend(ACK), ESR_SESSION);

    const otherSession = "agent:main:slack:channel:c0c303k80uq:thread:1790097410.218249";
    expect(await guard(replyToAsk(ANSWER), esrCtx(otherSession))).toBeUndefined();
  });

  it("still cancels the identical answer sent twice", async () => {
    const guard = createOutboundDedupeGuard(deps());
    const record = createOutboundSentRecorder(deps());

    expect(await guard(replyToAsk(ANSWER), esrCtx())).toBeUndefined();
    await record(confirmedSend(ANSWER), ESR_SESSION);
    advance(ACK_TO_ANSWER_MS);

    const repeat = await guard(replyToAsk(ANSWER), esrCtx());
    expect(repeat?.cancel).toBe(true);
    expect(repeat?.cancelReason).toContain("duplicate of a send");
  });
});
