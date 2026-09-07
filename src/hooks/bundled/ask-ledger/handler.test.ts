import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInternalHookEvent } from "../../internal-hooks.js";
import { createAskLedgerHandler, createInboundTurnGateHandler } from "./handler.js";
import { InboundTurnGate } from "./inbound-turn-gate.js";
import { ASK_LEDGER_FILE, type AskLedgerLine, type AskState, mergeAskLines } from "./ledger.js";

const THREAD_SESSION = "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609";
const CHANNEL = "C0A3C98HS48";
const DM_SESSION = "agent:main:slack:direct:u012";
const DM = { sessionKey: DM_SESSION, conversationId: "channel:D0BPP782T2B", chatType: "direct" };
const DISPATCH_CTX = { channelId: "slack", senderId: "U012" };
/** The ts Slack returns for a send it actually delivered. */
const SENT_ANSWER_TS = "1786592000.000100";
const OTHER_CHANNEL = "C0AHSKBNDB6";

/** The session key shape production builds for a Slack thread. */
function threadSession(threadTs: string): string {
  return `agent:main:slack:channel:c0a3c98hs48:thread:${threadTs}`;
}

// The real incident: Slack reconnected after an outage and replayed a message the
// user had deleted, alongside the live re-post of the same question.
const LIVE_TS = "1788479558.561999";
const REPLAYED_TS = "1788479206.951729";
const LIVE_TEXT = "what did we learn from the BRIBE stage 0 study?";
const REPLAYED_TEXT = "  <@U0BOTFRACTAL>  WHAT did we learn from the BRIBE stage 0 study?  ";

let workspaceDir = "";
let gate: InboundTurnGate;
let handler: ReturnType<typeof createAskLedgerHandler>;
let gateHandler: ReturnType<typeof createInboundTurnGateHandler>;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-ledger-"));
  gate = new InboundTurnGate();
  handler = createAskLedgerHandler({ resolveWorkspaceDir: () => workspaceDir, gate });
  gateHandler = createInboundTurnGateHandler(gate);
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

function ledgerPath(): string {
  return path.join(workspaceDir, "state", ASK_LEDGER_FILE);
}

function parseLine(line: string): AskLedgerLine | undefined {
  try {
    return JSON.parse(line) as AskLedgerLine;
  } catch {
    return undefined;
  }
}

async function readLines(): Promise<AskLedgerLine[]> {
  const content = await fs.readFile(ledgerPath(), "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => parseLine(line) ?? []);
}

async function readState(): Promise<AskState[]> {
  return mergeAskLines(await readLines());
}

async function askById(id: string): Promise<AskState | undefined> {
  return (await readState()).find((ask) => ask.id === id);
}

async function ledgerHasRecords(): Promise<boolean> {
  return fs
    .readFile(ledgerPath(), "utf-8")
    .then((content) => content.trim().length > 0)
    .catch(() => false);
}

function receivedEvent(params: {
  ts: string;
  text?: string;
  sessionKey?: string;
  conversationId?: string;
  threadId?: string;
  sourceTs?: string;
  wasMentioned?: boolean;
  chatType?: string;
  channelId?: string;
}) {
  return createInternalHookEvent("message", "received", params.sessionKey ?? THREAD_SESSION, {
    from: "slack:U012",
    content: params.text ?? "status now?",
    channelId: params.channelId ?? "slack",
    conversationId: params.conversationId ?? `channel:${CHANNEL}`,
    messageId: params.ts,
    metadata: {
      senderId: "U012",
      threadId: params.threadId,
      sourceTs: params.sourceTs,
      wasMentioned: params.wasMentioned,
      chatType: params.chatType,
    },
  });
}

/**
 * `messageId: undefined` is a real case — the provider reported success and returned
 * no message id — so only an absent key picks the default confirmed ts.
 */
function sentEvent(params: {
  sessionKey?: string;
  to?: string;
  messageId?: string;
  success?: boolean;
}) {
  const messageId = "messageId" in params ? params.messageId : SENT_ANSWER_TS;
  return createInternalHookEvent("message", "sent", params.sessionKey ?? THREAD_SESSION, {
    to: params.to ?? `channel:${CHANNEL}`,
    content: "working on it, ETA 10 min",
    success: params.success ?? true,
    channelId: "slack",
    conversationId: params.to ?? `channel:${CHANNEL}`,
    messageId,
  });
}

function deletedEvent(params: { ts: string; sessionKey?: string; channelId?: string }) {
  return createInternalHookEvent("message", "deleted", params.sessionKey ?? THREAD_SESSION, {
    channelId: params.channelId ?? "slack",
    conversationId: `channel:${CHANNEL}`,
    messageId: params.ts,
    from: "slack:U012",
    metadata: { senderId: "U012" },
  });
}

function dispatchEvent(content: string, sessionKey: string = THREAD_SESSION) {
  return { content, channel: "slack", senderId: "U012", sessionKey };
}

/** Replay both halves of the incident: the live re-post first, then Slack's replay. */
async function recordTheIncident(): Promise<void> {
  await handler(
    receivedEvent({
      ts: LIVE_TS,
      sessionKey: threadSession(LIVE_TS),
      threadId: LIVE_TS,
      wasMentioned: true,
      text: LIVE_TEXT,
    }),
  );
  await handler(
    receivedEvent({
      ts: REPLAYED_TS,
      sessionKey: threadSession(REPLAYED_TS),
      threadId: REPLAYED_TS,
      wasMentioned: true,
      text: REPLAYED_TEXT,
    }),
  );
}

describe("ask-ledger handler", () => {
  it("writes the asks.py open-record schema for a mention", async () => {
    await handler(
      receivedEvent({
        ts: "1786591970.000200",
        threadId: "1786591963.108609",
        wasMentioned: true,
        text: "x".repeat(400),
      }),
    );

    const [record] = await readLines();
    expect(Object.keys(record ?? {}).toSorted()).toEqual([
      "channel",
      "id",
      "received_at",
      "source_message_id",
      "status",
      "text",
      "thread_ts",
      "user",
    ]);
    expect(record).toMatchObject({
      id: `${CHANNEL}:1786591970.000200`,
      channel: CHANNEL,
      thread_ts: "1786591963.108609",
      user: "U012",
      source_message_id: `default:${CHANNEL}:1786591970.000200`,
      status: "open",
    });
    expect(record?.text).toHaveLength(300);
    expect(typeof record?.received_at).toBe("string");
  });

  it("records DMs and in-thread replies without a mention", async () => {
    await handler(receivedEvent({ ts: "1.1", ...DM }));
    await handler(receivedEvent({ ts: "2.2", threadId: "1786591963.108609" }));

    const asks = await readState();
    expect(asks.map((ask) => ask.channel)).toEqual(["D0BPP782T2B", CHANNEL]);
    expect(asks[0]?.thread_ts).toBeUndefined();
    expect(asks[1]?.thread_ts).toBe("1786591963.108609");
  });

  it("ignores top-level channel chatter without a mention and non-Slack traffic", async () => {
    await handler(receivedEvent({ ts: "3.3", sessionKey: "agent:main:slack:channel:c0a3c98hs48" }));
    await handler(receivedEvent({ ts: "4.4", wasMentioned: true, channelId: "telegram" }));
    expect(await ledgerHasRecords()).toBe(false);
  });

  it("never duplicates a replayed message", async () => {
    const event = receivedEvent({ ts: "5.5", wasMentioned: true });
    await handler(event);
    await handler(event);
    expect(await readLines()).toHaveLength(1);
  });

  it("appends an answered line for asks in the thread the bot replied to", async () => {
    await handler(receivedEvent({ ts: "6.6", threadId: "1786591963.108609", wasMentioned: true }));
    await handler(
      receivedEvent({
        ts: "7.7",
        sessionKey: "agent:main:slack:channel:c0a3c98hs48:thread:9999.0001",
        threadId: "9999.0001",
        wasMentioned: true,
        text: "any update on the deploy?",
      }),
    );

    await handler(sentEvent({ messageId: "8.8" }));

    const lines = await readLines();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ id: `${CHANNEL}:6.6`, status: "answered", answer_ts: "8.8" });
    expect(typeof lines[2]?.answered_at).toBe("string");
    expect((await askById(`${CHANNEL}:6.6`))?.status).toBe("answered");
    expect((await askById(`${CHANNEL}:7.7`))?.status).toBe("open");
  });

  it("treats a reply in the thread rooted at the ask as an answer", async () => {
    await handler(
      receivedEvent({
        ts: "1786591963.108609",
        sessionKey: "agent:main:slack:channel:c0a3c98hs48",
        wasMentioned: true,
      }),
    );
    await handler(sentEvent({ sessionKey: THREAD_SESSION }));
    expect((await readState())[0]?.status).toBe("answered");
  });

  it("lets a top-level reply answer only the newest pending top-level ask", async () => {
    await handler(receivedEvent({ ts: "11.1", text: "first question", ...DM }));
    await handler(receivedEvent({ ts: "11.2", text: "second question", ...DM }));

    await handler(sentEvent({ sessionKey: DM_SESSION, to: "channel:D0BPP782T2B" }));

    expect((await askById("D0BPP782T2B:11.1"))?.status).toBe("open");
    expect((await askById("D0BPP782T2B:11.2"))?.status).toBe("answered");
  });

  it("answers acknowledged asks and keeps lines written by asks.py", async () => {
    await handler(receivedEvent({ ts: "12.1", wasMentioned: true }));
    await fs.appendFile(
      ledgerPath(),
      `${JSON.stringify({ id: `${CHANNEL}:12.1`, status: "acknowledged", acknowledged_at: "2026-09-03T00:00:00Z", note: "eta 5m" })}\n{not json\n`,
    );

    await handler(sentEvent({ messageId: "12.2" }));

    const content = await fs.readFile(ledgerPath(), "utf-8");
    expect(content).toContain("{not json\n");
    expect(content).toContain('"note":"eta 5m"');
    const [ask] = await readState();
    expect(ask).toMatchObject({
      status: "answered",
      answer_ts: "12.2",
      acknowledged_at: "2026-09-03T00:00:00Z",
    });
  });

  it("still records the open ask when asks.py wrote a status line first", async () => {
    await fs.mkdir(path.dirname(ledgerPath()), { recursive: true });
    await fs.appendFile(
      ledgerPath(),
      `${JSON.stringify({ id: `${CHANNEL}:13.1`, status: "acknowledged", acknowledged_at: "2026-09-03T00:00:00Z" })}\n`,
    );
    await handler(receivedEvent({ ts: "13.1", wasMentioned: true }));

    const [ask] = await readState();
    expect(ask).toMatchObject({ id: `${CHANNEL}:13.1`, status: "open", text: "status now?" });
  });

  it("ignores messages from bots and apps", async () => {
    const event = receivedEvent({ ts: "14.1", wasMentioned: true });
    (event.context.metadata as Record<string, unknown>).senderIsBot = true;
    await handler(event);
    expect(await ledgerHasRecords()).toBe(false);
  });

  it("records the parent_deleted sentinel as the answer ts", async () => {
    await handler(receivedEvent({ ts: "40.1", wasMentioned: true }));

    await handler(sentEvent({ messageId: "parent_deleted" }));

    expect(await askById(`${CHANNEL}:40.1`)).toMatchObject({
      status: "answered",
      answer_ts: "parent_deleted",
    });
  });

  it("marks nothing answered when the provider returned no message id", async () => {
    await handler(receivedEvent({ ts: "41.1", wasMentioned: true }));

    await handler(sentEvent({ messageId: undefined }));

    const ask = await askById(`${CHANNEL}:41.1`);
    expect(ask?.status).toBe("open");
    expect(ask?.answer_ts).toBeUndefined();
    expect(await readLines()).toHaveLength(1);
  });

  it.each(["ok", "1234", "not-a-ts"])(
    "marks nothing answered when the message id %s is not a Slack ts",
    async (messageId) => {
      await handler(receivedEvent({ ts: "41.2", wasMentioned: true }));

      await handler(sentEvent({ messageId }));

      expect((await askById(`${CHANNEL}:41.2`))?.status).toBe("open");
      expect(await readLines()).toHaveLength(1);
    },
  );

  it("marks answered and records the answer ts for a confirmed Slack ts", async () => {
    await handler(receivedEvent({ ts: "42.1", wasMentioned: true }));

    await handler(sentEvent({ messageId: "1786592000.000900" }));

    expect(await askById(`${CHANNEL}:42.1`)).toMatchObject({
      status: "answered",
      answer_ts: "1786592000.000900",
    });
  });

  it("never closes an ask in a channel the reply did not go to", async () => {
    await handler(receivedEvent({ ts: "43.1", wasMentioned: true }));

    await handler(sentEvent({ to: `channel:${OTHER_CHANNEL}` }));

    expect((await askById(`${CHANNEL}:43.1`))?.status).toBe("open");
    expect(await readLines()).toHaveLength(1);
  });

  it("leaves asks open when the send failed", async () => {
    await handler(receivedEvent({ ts: "10.10", wasMentioned: true }));
    await handler(sentEvent({ success: false }));
    expect((await readState())[0]?.status).toBe("open");
  });
});

describe("ask-ledger duplicate suppression", () => {
  it("records Slack's replay of a deleted message as a duplicate of the live re-post", async () => {
    await recordTheIncident();

    const lines = await readLines();
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ id: `${CHANNEL}:${REPLAYED_TS}`, status: "open" });
    expect(lines[2]).toEqual({
      id: `${CHANNEL}:${REPLAYED_TS}`,
      status: "duplicate",
      duplicate_of: `${CHANNEL}:${LIVE_TS}`,
    });
    expect(await askById(`${CHANNEL}:${REPLAYED_TS}`)).toMatchObject({
      status: "duplicate",
      duplicate_of: `${CHANNEL}:${LIVE_TS}`,
    });
  });

  it("stops the duplicate's turn and lets the first ask through", async () => {
    await recordTheIncident();

    expect(
      await gateHandler(dispatchEvent(LIVE_TEXT, threadSession(LIVE_TS)), DISPATCH_CTX),
    ).toBeUndefined();
    expect(
      await gateHandler(dispatchEvent(REPLAYED_TEXT, threadSession(REPLAYED_TS)), DISPATCH_CTX),
    ).toEqual({ handled: true });
  });

  it("keeps stopping the turn when Slack replays the duplicate again", async () => {
    await recordTheIncident();
    await handler(
      receivedEvent({
        ts: REPLAYED_TS,
        sessionKey: threadSession(REPLAYED_TS),
        threadId: REPLAYED_TS,
        wasMentioned: true,
        text: REPLAYED_TEXT,
      }),
    );

    expect(await readLines()).toHaveLength(3);
    expect(
      await gateHandler(dispatchEvent(REPLAYED_TEXT, threadSession(REPLAYED_TS)), DISPATCH_CTX),
    ).toEqual({ handled: true });
  });

  it("does not stop a turn the recorder never claimed", async () => {
    const channelSession = "agent:main:slack:channel:c0a3c98hs48";
    await handler(receivedEvent({ ts: "20.1", sessionKey: channelSession }));

    expect(
      await gateHandler(dispatchEvent("status now?", channelSession), DISPATCH_CTX),
    ).toBeUndefined();
  });

  it("answers the live ask and never answers its duplicate", async () => {
    await recordTheIncident();

    await handler(
      sentEvent({
        sessionKey: `agent:main:slack:channel:c0a3c98hs48:thread:${LIVE_TS}`,
        messageId: "1788479746.150769",
      }),
    );
    await handler(
      sentEvent({
        sessionKey: `agent:main:slack:channel:c0a3c98hs48:thread:${REPLAYED_TS}`,
        messageId: "1788479779.831029",
      }),
    );

    expect((await askById(`${CHANNEL}:${LIVE_TS}`))?.status).toBe("answered");
    expect((await askById(`${CHANNEL}:${REPLAYED_TS}`))?.status).toBe("duplicate");
  });

  it("gives two byte-identical messages independent verdicts", async () => {
    await handler(
      receivedEvent({
        ts: LIVE_TS,
        sessionKey: threadSession(LIVE_TS),
        threadId: LIVE_TS,
        wasMentioned: true,
        text: LIVE_TEXT,
      }),
    );
    await handler(
      receivedEvent({
        ts: REPLAYED_TS,
        sessionKey: threadSession(REPLAYED_TS),
        threadId: REPLAYED_TS,
        wasMentioned: true,
        text: LIVE_TEXT,
      }),
    );

    // Same channel, same user, same bytes: only the thread session tells them apart.
    // The replay is read first on purpose — a key that cannot separate them hands it
    // the live question's allowance and suppresses the live turn instead.
    expect(
      await gateHandler(dispatchEvent(LIVE_TEXT, threadSession(REPLAYED_TS)), DISPATCH_CTX),
    ).toEqual({ handled: true });
    expect(
      await gateHandler(dispatchEvent(LIVE_TEXT, threadSession(LIVE_TS)), DISPATCH_CTX),
    ).toBeUndefined();
  });

  it("keeps the same question in another channel open", async () => {
    await handler(receivedEvent({ ts: "21.1", wasMentioned: true, text: "same question" }));
    await handler(
      receivedEvent({
        ts: "21.2",
        wasMentioned: true,
        text: "same question",
        conversationId: "channel:C0AHSKBNDB6",
        sessionKey: "agent:main:slack:channel:c0ahskbndb6:thread:21.2",
      }),
    );

    const asks = await readState();
    expect(asks.map((ask) => ask.status)).toEqual(["open", "open"]);
  });
});

describe("ask-ledger source aliasing", () => {
  it("aliases a redelivery of the same source arriving under a new id", async () => {
    await handler(
      receivedEvent({ ts: LIVE_TS, threadId: LIVE_TS, wasMentioned: true, text: LIVE_TEXT }),
    );
    await handler(
      receivedEvent({
        ts: "1788479999.000100",
        threadId: LIVE_TS,
        sourceTs: LIVE_TS,
        wasMentioned: true,
        text: "edited: what did we learn from the BRIBE stage 0 study?",
      }),
    );

    const lines = await readLines();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toEqual({
      id: `${CHANNEL}:1788479999.000100`,
      alias_of: `${CHANNEL}:${LIVE_TS}`,
    });
    const alias = await askById(`${CHANNEL}:1788479999.000100`);
    expect(alias).toMatchObject({ status: "open", alias_of: `${CHANNEL}:${LIVE_TS}` });
  });

  it("stops the aliased redelivery's turn", async () => {
    const editedText = "edited: what did we learn?";
    await handler(
      receivedEvent({ ts: LIVE_TS, threadId: LIVE_TS, wasMentioned: true, text: LIVE_TEXT }),
    );
    await handler(
      receivedEvent({
        ts: "1788479999.000100",
        threadId: LIVE_TS,
        sourceTs: LIVE_TS,
        wasMentioned: true,
        text: editedText,
      }),
    );

    expect(await gateHandler(dispatchEvent(editedText), DISPATCH_CTX)).toEqual({ handled: true });
  });

  it("points a second redelivery at the same canonical ask, not at the alias", async () => {
    await handler(
      receivedEvent({ ts: LIVE_TS, threadId: LIVE_TS, wasMentioned: true, text: LIVE_TEXT }),
    );
    await handler(
      receivedEvent({
        ts: "1788479999.000100",
        threadId: LIVE_TS,
        sourceTs: LIVE_TS,
        wasMentioned: true,
        text: "first edit",
      }),
    );
    await handler(
      receivedEvent({
        ts: "1788480000.000200",
        threadId: LIVE_TS,
        sourceTs: LIVE_TS,
        wasMentioned: true,
        text: "second edit",
      }),
    );

    expect((await askById(`${CHANNEL}:1788480000.000200`))?.alias_of).toBe(`${CHANNEL}:${LIVE_TS}`);
  });

  it("never answers an aliased ask sharing the thread", async () => {
    await handler(
      receivedEvent({ ts: LIVE_TS, threadId: LIVE_TS, wasMentioned: true, text: LIVE_TEXT }),
    );
    await handler(
      receivedEvent({
        ts: "1788479999.000100",
        threadId: LIVE_TS,
        sourceTs: LIVE_TS,
        wasMentioned: true,
        text: "edited",
      }),
    );

    await handler(
      sentEvent({
        sessionKey: `agent:main:slack:channel:c0a3c98hs48:thread:${LIVE_TS}`,
        messageId: "1788479746.150769",
      }),
    );

    expect((await askById(`${CHANNEL}:${LIVE_TS}`))?.status).toBe("answered");
    expect((await askById(`${CHANNEL}:1788479999.000100`))?.status).toBe("open");
  });
});

describe("ask-ledger deletion tombstones", () => {
  it("tombstones the ask whose message the user deleted", async () => {
    await handler(receivedEvent({ ts: "30.1", wasMentioned: true }));

    await handler(deletedEvent({ ts: "30.1" }));

    const lines = await readLines();
    expect(lines[1]).toMatchObject({ id: `${CHANNEL}:30.1`, status: "deleted" });
    expect(typeof lines[1]?.deleted_at).toBe("string");
    expect((await askById(`${CHANNEL}:30.1`))?.status).toBe("deleted");
  });

  it("stops the in-flight turn for the deleted message", async () => {
    await handler(receivedEvent({ ts: "31.1", wasMentioned: true, text: "cancel this" }));

    await handler(deletedEvent({ ts: "31.1" }));

    expect(await gateHandler(dispatchEvent("cancel this"), DISPATCH_CTX)).toEqual({
      handled: true,
    });
  });

  it("never answers a tombstoned ask", async () => {
    await handler(receivedEvent({ ts: "32.1", threadId: "32.1", wasMentioned: true }));
    await handler(deletedEvent({ ts: "32.1" }));

    await handler(sentEvent({ sessionKey: "agent:main:slack:channel:c0a3c98hs48:thread:32.1" }));

    expect((await askById(`${CHANNEL}:32.1`))?.status).toBe("deleted");
  });

  it("writes nothing for a deleted message that was never an ask, and never twice", async () => {
    await handler(deletedEvent({ ts: "33.1" }));
    expect(await ledgerHasRecords()).toBe(false);

    await handler(receivedEvent({ ts: "34.1", wasMentioned: true }));
    await handler(deletedEvent({ ts: "34.1" }));
    await handler(deletedEvent({ ts: "34.1" }));
    expect(await readLines()).toHaveLength(2);
  });

  it("ignores deletions from other channels", async () => {
    await handler(receivedEvent({ ts: "35.1", wasMentioned: true }));
    await handler(deletedEvent({ ts: "35.1", channelId: "telegram" }));

    expect((await askById(`${CHANNEL}:35.1`))?.status).toBe("open");
  });
});
