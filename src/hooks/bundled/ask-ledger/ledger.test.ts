import { describe, expect, it } from "vitest";
import {
  type AskLedgerLine,
  type AskOpenRecord,
  type AskState,
  type AskStatus,
  buildSourceMessageId,
  DUPLICATE_ASK_WINDOW_MS,
  findAskBySource,
  findDuplicateAsk,
  mergeAskLines,
  selectAnsweredAsks,
} from "./ledger.js";

// The real incident: Slack reconnected after an outage and replayed a message the
// user had deleted, alongside the live re-post of the same question.
const CHANNEL = "C0A3C98HS48";
const USER = "U03EH553GBE";
const TEXT = "what did we learn from the BRIBE stage 0 study?";
const LIVE_TS = "1788479558.561999";
const REPLAYED_TS = "1788479206.951729";
const LIVE_ID = `${CHANNEL}:${LIVE_TS}`;
const REPLAYED_ID = `${CHANNEL}:${REPLAYED_TS}`;
const LIVE_RECEIVED_AT = "2026-09-03T23:52:47.741Z";
const ANSWER_TS = "1788479746.150769";
const REPLAYED_RECEIVED_AT = "2026-09-03T23:53:14.768Z";

function shiftIso(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function liveAsk(overrides: Partial<AskState> = {}): AskState {
  return {
    id: LIVE_ID,
    channel: CHANNEL,
    thread_ts: LIVE_TS,
    user: USER,
    text: TEXT,
    received_at: LIVE_RECEIVED_AT,
    source_message_id: buildSourceMessageId({ channel: CHANNEL, ts: LIVE_TS }),
    status: "open",
    ...overrides,
  };
}

function replayedAsk(overrides: Partial<AskOpenRecord> = {}): AskOpenRecord {
  return {
    id: REPLAYED_ID,
    channel: CHANNEL,
    thread_ts: REPLAYED_TS,
    user: USER,
    text: TEXT,
    received_at: REPLAYED_RECEIVED_AT,
    source_message_id: buildSourceMessageId({ channel: CHANNEL, ts: REPLAYED_TS }),
    status: "open",
    ...overrides,
  };
}

describe("buildSourceMessageId", () => {
  it("scopes the message ts by workspace account and channel", () => {
    expect(buildSourceMessageId({ accountId: "T01", channel: CHANNEL, ts: LIVE_TS })).toBe(
      `T01:${CHANNEL}:${LIVE_TS}`,
    );
    expect(buildSourceMessageId({ channel: CHANNEL, ts: LIVE_TS })).toBe(
      `default:${CHANNEL}:${LIVE_TS}`,
    );
  });

  it("keeps the same message apart across workspace accounts", () => {
    expect(buildSourceMessageId({ accountId: "T01", channel: CHANNEL, ts: LIVE_TS })).not.toBe(
      buildSourceMessageId({ accountId: "T02", channel: CHANNEL, ts: LIVE_TS }),
    );
  });
});

describe("findAskBySource", () => {
  it("finds the ask that already owns this source, whatever state it is in", () => {
    const sameSource = replayedAsk({
      id: `${CHANNEL}:1788479999.000100`,
      source_message_id: liveAsk().source_message_id,
    });

    expect(findAskBySource([liveAsk({ status: "answered" })], sameSource)?.id).toBe(LIVE_ID);
  });

  it("does not match a different source or the ask itself", () => {
    expect(findAskBySource([liveAsk()], replayedAsk())).toBeUndefined();
    expect(findAskBySource([liveAsk()], replayedAsk({ id: LIVE_ID }))).toBeUndefined();
  });
});

describe("findDuplicateAsk", () => {
  it("matches the replayed outage message against the live re-post", () => {
    expect(findDuplicateAsk([liveAsk()], replayedAsk())?.id).toBe(LIVE_ID);
  });

  it.each<AskStatus>(["open", "acknowledged", "answered"])(
    "matches an existing ask that is %s",
    (status) => {
      expect(findDuplicateAsk([liveAsk({ status })], replayedAsk())?.id).toBe(LIVE_ID);
    },
  );

  it("skips a deleted original, because asking again after a delete is a new ask", () => {
    expect(findDuplicateAsk([liveAsk({ status: "deleted" })], replayedAsk())).toBeUndefined();
  });

  it("ignores an existing duplicate or alias, so every repeat points at the original", () => {
    const original = liveAsk({ status: "answered" });
    const earlierDuplicate = liveAsk({
      id: `${CHANNEL}:1788479300.000100`,
      status: "duplicate",
      duplicate_of: LIVE_ID,
      received_at: shiftIso(LIVE_RECEIVED_AT, 60_000),
    });
    const earlierAlias = liveAsk({
      id: `${CHANNEL}:1788479400.000100`,
      alias_of: LIVE_ID,
      received_at: shiftIso(LIVE_RECEIVED_AT, 90_000),
    });

    expect(findDuplicateAsk([original, earlierDuplicate, earlierAlias], replayedAsk())?.id).toBe(
      LIVE_ID,
    );
  });

  it("normalizes case, surrounding whitespace and the leading bot mention", () => {
    const candidate = replayedAsk({
      text: "  <@U0BOTFRACTAL>   WHAT did we learn from the BRIBE   stage 0 study?  ",
    });

    expect(findDuplicateAsk([liveAsk()], candidate)?.id).toBe(LIVE_ID);
  });

  it("keeps asks apart when the mention is inside the sentence", () => {
    const existing = liveAsk({ text: "ping <@U0ALICE> about the run" });
    const candidate = replayedAsk({ text: "ping <@U0BOB> about the run" });

    expect(findDuplicateAsk([existing], candidate)).toBeUndefined();
  });

  it("matches at the edge of the window and not past it", () => {
    const atEdge = replayedAsk({
      received_at: shiftIso(LIVE_RECEIVED_AT, DUPLICATE_ASK_WINDOW_MS),
    });
    const pastEdge = replayedAsk({
      received_at: shiftIso(LIVE_RECEIVED_AT, DUPLICATE_ASK_WINDOW_MS + 1),
    });

    expect(findDuplicateAsk([liveAsk()], atEdge)?.id).toBe(LIVE_ID);
    expect(findDuplicateAsk([liveAsk()], pastEdge)).toBeUndefined();
  });

  it("does not match another user, another channel or other text", () => {
    expect(findDuplicateAsk([liveAsk({ user: "U0OTHER" })], replayedAsk())).toBeUndefined();
    expect(findDuplicateAsk([liveAsk({ channel: "C0AHSKBNDB6" })], replayedAsk())).toBeUndefined();
    expect(findDuplicateAsk([liveAsk()], replayedAsk({ text: "and stage 1?" }))).toBeUndefined();
  });

  it("does not match the ask against itself", () => {
    expect(findDuplicateAsk([liveAsk()], replayedAsk({ id: LIVE_ID }))).toBeUndefined();
  });

  it("picks the oldest match so repeats chain to one original", () => {
    const older = liveAsk({ id: `${CHANNEL}:1.1`, received_at: LIVE_RECEIVED_AT });
    const newer = liveAsk({
      id: `${CHANNEL}:2.2`,
      received_at: shiftIso(LIVE_RECEIVED_AT, 30_000),
    });

    expect(findDuplicateAsk([newer, older], replayedAsk())?.id).toBe(`${CHANNEL}:1.1`);
  });

  it("skips ledger lines with no usable received_at or text", () => {
    expect(
      findDuplicateAsk([liveAsk({ received_at: "not a date" })], replayedAsk()),
    ).toBeUndefined();
    expect(
      findDuplicateAsk(
        [liveAsk({ text: undefined as unknown as string })],
        replayedAsk({ text: "" }),
      ),
    ).toBeUndefined();
  });
});

describe("mergeAskLines", () => {
  it("folds a duplicate line onto the open record it follows", () => {
    const lines: AskLedgerLine[] = [
      { ...replayedAsk() },
      { id: REPLAYED_ID, status: "duplicate", duplicate_of: LIVE_ID },
    ];

    expect(mergeAskLines(lines)).toEqual([
      { ...replayedAsk(), status: "duplicate", duplicate_of: LIVE_ID },
    ]);
  });

  it("folds a statusless alias line without touching the ask's own status", () => {
    const lines: AskLedgerLine[] = [{ ...replayedAsk() }, { id: REPLAYED_ID, alias_of: LIVE_ID }];

    expect(mergeAskLines(lines)).toEqual([{ ...replayedAsk(), alias_of: LIVE_ID }]);
  });

  it("folds a deleted tombstone onto the open record", () => {
    const lines: AskLedgerLine[] = [
      { ...replayedAsk() },
      { id: REPLAYED_ID, status: "deleted", deleted_at: "2026-09-03T23:58:00.000Z" },
    ];

    expect(mergeAskLines(lines)[0]).toMatchObject({
      status: "deleted",
      deleted_at: "2026-09-03T23:58:00.000Z",
    });
  });

  it("creates nothing from an alias, a tombstone or a status line with no open line first", () => {
    const lines: AskLedgerLine[] = [
      { id: REPLAYED_ID, alias_of: LIVE_ID },
      { id: `${CHANNEL}:3.3`, status: "deleted", deleted_at: "2026-09-03T23:58:00.000Z" },
      { id: `${CHANNEL}:4.4`, status: "acknowledged", acknowledged_at: "2026-09-03T23:54:00.000Z" },
      { id: `${CHANNEL}:5.5`, status: "duplicate", duplicate_of: LIVE_ID },
    ];

    expect(mergeAskLines(lines)).toEqual([]);
  });
});

describe("selectAnsweredAsks", () => {
  it("never answers a duplicate sharing the thread with a pending ask", () => {
    const pending = liveAsk();
    const duplicate = liveAsk({
      id: REPLAYED_ID,
      thread_ts: LIVE_TS,
      status: "duplicate",
      duplicate_of: LIVE_ID,
    });

    const answered = selectAnsweredAsks([pending, duplicate], {
      channel: CHANNEL,
      thread_ts: LIVE_TS,
      answer_ts: ANSWER_TS,
      answered_at: "2026-09-03T23:55:46.214Z",
    });

    expect(answered.map((ask) => ask.id)).toEqual([LIVE_ID]);
  });

  it("never answers an alias or a tombstoned ask in the thread", () => {
    const pending = liveAsk();
    const alias = liveAsk({ id: `${CHANNEL}:6.6`, thread_ts: LIVE_TS, alias_of: LIVE_ID });
    const deleted = liveAsk({ id: `${CHANNEL}:7.7`, thread_ts: LIVE_TS, status: "deleted" });

    const answered = selectAnsweredAsks([pending, alias, deleted], {
      channel: CHANNEL,
      thread_ts: LIVE_TS,
      answer_ts: ANSWER_TS,
      answered_at: "2026-09-03T23:55:46.214Z",
    });

    expect(answered.map((ask) => ask.id)).toEqual([LIVE_ID]);
  });

  it("never answers a duplicate as the newest top-level ask", () => {
    const older = liveAsk({ id: `${CHANNEL}:1.1`, thread_ts: undefined });
    const duplicate = liveAsk({
      id: REPLAYED_ID,
      thread_ts: undefined,
      received_at: shiftIso(LIVE_RECEIVED_AT, 30_000),
      status: "duplicate",
      duplicate_of: `${CHANNEL}:1.1`,
    });

    const answered = selectAnsweredAsks([older, duplicate], {
      channel: CHANNEL,
      answer_ts: ANSWER_TS,
      answered_at: "2026-09-03T23:55:46.214Z",
    });

    expect(answered.map((ask) => ask.id)).toEqual([`${CHANNEL}:1.1`]);
  });
});
