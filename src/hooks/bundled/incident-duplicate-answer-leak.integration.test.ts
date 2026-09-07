/**
 * Regression for the 2026-09-03 duplicate-answer leak in #flavio-test.
 *
 * On reconnect Slack replayed a message the user had posted during the outage and
 * then deleted (ts 1788479206.951729) alongside the user's live re-post
 * (ts 1788479558.561999) — same user, same channel, identical text. Both became
 * asks. The bot answered the live one in thread, then answered the replayed one
 * too; that threaded send failed with `thread_not_found` and the answer was posted
 * top-level in the channel.
 *
 * This drives the real inbound path — the `message:received` recorder and the
 * `before_dispatch` turn gate it feeds — and asserts the end state: exactly one
 * obligation is answerable, and it is the live one.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
} from "../../plugins/hook-types.js";
import { createInternalHookEvent } from "../internal-hooks.js";
import { resolveWorkspaceStatePath } from "../workspace-state.js";
import { createAskLedgerHandler, createInboundTurnGateHandler } from "./ask-ledger/handler.js";
import { InboundTurnGate } from "./ask-ledger/inbound-turn-gate.js";
import {
  ASK_LEDGER_FILE,
  mergeAskLines,
  type AskLedgerLine,
  type AskState,
} from "./ask-ledger/ledger.js";

const CHANNEL = "C0A3C98HS48";
const USER = "U03EH553GBE";
const TEXT = "<@U0BOTID> how do we keep going on the ARP routing work?";
/** Posted during the outage, deleted by the user, replayed by Slack on reconnect. */
const REPLAYED_TS = "1788479206.951729";
/** The user's live re-post, the one that deserves the answer. */
const LIVE_TS = "1788479558.561999";
const BOT_ANSWER_TS = "1788479600.000100";

let workspaceDir = "";
let gate: InboundTurnGate;
let record: ReturnType<typeof createAskLedgerHandler>;
let runGate: ReturnType<typeof createInboundTurnGateHandler>;

/** The real Slack session-key shape the hooks parse channel and thread out of. */
function sessionKey(threadTs: string): string {
  return `agent:main:slack:channel:${CHANNEL.toLowerCase()}:thread:${threadTs}`;
}

async function receive(ts: string): Promise<void> {
  await record(
    createInternalHookEvent("message", "received", sessionKey(ts), {
      from: USER,
      content: TEXT,
      channelId: "slack",
      conversationId: CHANNEL,
      messageId: ts,
      metadata: { senderId: USER, threadId: ts, wasMentioned: true },
    }),
  );
}

/** The turn gate sees the same canonical inbound fields the recorder saw. */
async function dispatchAllowed(ts: string): Promise<boolean> {
  const event = {
    content: TEXT,
    channel: "slack",
    senderId: USER,
  } as PluginHookBeforeDispatchEvent;
  const ctx = {
    channelId: "slack",
    conversationId: CHANNEL,
    sessionKey: sessionKey(ts),
    senderId: USER,
  } as PluginHookBeforeDispatchContext;
  return (await runGate(event, ctx))?.handled !== true;
}

async function deleteMessage(ts: string): Promise<void> {
  await record(
    createInternalHookEvent("message", "deleted", sessionKey(ts), {
      channelId: "slack",
      conversationId: CHANNEL,
      messageId: ts,
      from: USER,
      metadata: { senderId: USER },
    }),
  );
}

async function botAnswered(threadTs: string): Promise<void> {
  await record(
    createInternalHookEvent("message", "sent", sessionKey(threadTs), {
      to: CHANNEL,
      content: "Here is where the ARP routing work stands.",
      success: true,
      channelId: "slack",
      messageId: BOT_ANSWER_TS,
    }),
  );
}

async function readAsks(): Promise<AskState[]> {
  const raw = await fs.readFile(resolveWorkspaceStatePath(workspaceDir, ASK_LEDGER_FILE), "utf-8");
  const lines = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AskLedgerLine);
  return mergeAskLines(lines);
}

/** What `scripts/asks.py --open` would still call an obligation. */
function openObligations(asks: AskState[]): AskState[] {
  return asks.filter(
    (ask) =>
      ask.alias_of === undefined &&
      ask.status !== "answered" &&
      ask.status !== "duplicate" &&
      ask.status !== "deleted",
  );
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-ledger-incident-"));
  gate = new InboundTurnGate();
  record = createAskLedgerHandler({ resolveWorkspaceDir: () => workspaceDir, gate });
  runGate = createInboundTurnGateHandler(gate);
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("2026-09-03 duplicate-answer leak", () => {
  it("answers the live re-post once and never gives the replayed deletion a turn", async () => {
    await receive(LIVE_TS);
    await receive(REPLAYED_TS);

    expect(await dispatchAllowed(LIVE_TS)).toBe(true);
    expect(await dispatchAllowed(REPLAYED_TS)).toBe(false);

    await botAnswered(LIVE_TS);
    await deleteMessage(REPLAYED_TS);

    const asks = await readAsks();
    expect(asks).toHaveLength(2);
    expect(asks.find((ask) => ask.id === `${CHANNEL}:${LIVE_TS}`)?.status).toBe("answered");
    expect(asks.find((ask) => ask.id === `${CHANNEL}:${REPLAYED_TS}`)?.status).toBe("deleted");
    expect(openObligations(asks)).toEqual([]);
  });

  it("gives the live re-post its turn even when the replay is delivered first", async () => {
    await receive(REPLAYED_TS);
    await deleteMessage(REPLAYED_TS);
    await receive(LIVE_TS);

    expect(await dispatchAllowed(REPLAYED_TS)).toBe(false);
    expect(await dispatchAllowed(LIVE_TS)).toBe(true);

    await botAnswered(LIVE_TS);

    const asks = await readAsks();
    expect(asks.find((ask) => ask.id === `${CHANNEL}:${LIVE_TS}`)?.status).toBe("answered");
    expect(openObligations(asks)).toEqual([]);
  });

  it("closes the ask with the sentinel instead of posting the answer top-level", async () => {
    await receive(REPLAYED_TS);

    // The Slack reply path drops a threaded send that fails with thread_not_found
    // and reports the sentinel instead of a real ts, so the ask is closed without
    // a top-level post ever happening.
    await record(
      createInternalHookEvent("message", "sent", sessionKey(REPLAYED_TS), {
        to: CHANNEL,
        content: "Here is where the ARP routing work stands.",
        success: true,
        channelId: "slack",
        messageId: "parent_deleted",
      }),
    );

    const replayed = (await readAsks()).find((ask) => ask.id === `${CHANNEL}:${REPLAYED_TS}`);
    expect(replayed?.answer_ts).toBe("parent_deleted");
  });
});
