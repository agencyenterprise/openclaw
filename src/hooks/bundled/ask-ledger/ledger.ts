// Append-only ask ledger stored as JSONL under <workspace>/state. Each line is a
// state change keyed by ask id; the latest line for an id wins when reading. An
// id becomes an ask only when its first line is `open`, so a status line that
// arrives before the ask (or for a message that was never an ask) is ignored.
// The same file and the same rules are read by workspace/scripts/asks.py.
import { appendJsonlRecordsAfterRead } from "../../workspace-state.js";
import { normalizeAskText } from "./ask-text.js";

export const ASK_LEDGER_FILE = "asks.jsonl";

export type AskStatus = "open" | "acknowledged" | "answered" | "duplicate" | "deleted";

/** How far back a repeated ask still counts as the same ask. */
export const DUPLICATE_ASK_WINDOW_MS = 15 * 60 * 1000;

/** Statuses that still owe the user an answer. */
const PENDING_ASK_STATUSES = new Set<AskStatus>(["open", "acknowledged"]);

/** An earlier ask in one of these states already covers a repeat of the same text. */
const DUPLICATE_SUPPRESSING_STATUSES = new Set<AskStatus>(["open", "acknowledged", "answered"]);

export type AskOpenRecord = {
  id: string;
  channel: string;
  thread_ts?: string;
  user: string;
  text: string;
  received_at: string;
  /** Identity of the message this ask came from; the same source is one obligation. */
  source_message_id: string;
  status: "open";
};

/**
 * Marks an open ask as a repeat of an earlier one: a distinct source whose text
 * repeats an ask the ledger already holds. Slack replayed a message the user had
 * deleted during an outage next to the live re-post, and both got answered.
 */
export type AskDuplicateRecord = {
  id: string;
  status: "duplicate";
  duplicate_of: string;
};

/**
 * The same source message recorded again under a different ask id (a replay, an
 * edit, a redelivery). It carries no status on purpose: it names the ask that owns
 * the obligation without overwriting that ask's own state.
 */
export type AskAliasRecord = {
  id: string;
  alias_of: string;
};

/** Only a confirmed send writes this line, so `answer_ts` is always present. */
export type AskAnsweredRecord = {
  id: string;
  status: "answered";
  answered_at: string;
  answer_ts: string;
};

/** Tombstone: the user deleted the message, so the ask is no longer owed an answer. */
export type AskDeletedRecord = {
  id: string;
  status: "deleted";
  deleted_at: string;
};

/** Any ledger line: an open record, or a state change written here or by asks.py. */
export type AskLedgerLine = { id: string; status?: AskStatus } & Record<string, unknown>;

export type AskState = Omit<AskOpenRecord, "status"> & {
  status: AskStatus;
  answered_at?: string;
  answer_ts?: string;
  acknowledged_at?: string;
  deleted_at?: string;
  duplicate_of?: string;
  alias_of?: string;
};

/**
 * A reply the platform confirmed it delivered. `answer_ts` is required on purpose:
 * an ask is closed only by a send that came back with a platform message id, so a
 * `message:sent` that reported success without one can never build an `AskReply`
 * and therefore never marks anything answered.
 */
export type AskReply = {
  channel: string;
  thread_ts?: string;
  answer_ts: string;
  answered_at: string;
};

/** Why an inbound ask carries no obligation of its own. */
export type AskSupersededBy = { kind: "alias" | "duplicate"; askId: string };

/** What recording an inbound ask did, and whether an earlier ask already owns it. */
export type AskRecordOutcome = {
  /** True when this call appended the ask's lines. */
  appended: boolean;
  /** The ask that owns the obligation, when this one is an alias or a duplicate. */
  supersededBy?: AskSupersededBy;
};

/**
 * Identity of the message an ask came from: the Slack workspace account, the
 * channel and the ts of the original message. Every delivery of one message shares
 * it — a replay, an edit and a redelivery are one obligation, not three.
 */
export function buildSourceMessageId(params: {
  accountId?: string;
  channel: string;
  ts: string;
}): string {
  return `${params.accountId ?? "default"}:${params.channel}:${params.ts}`;
}

/** The Slack message ts of an ask is the part of its id after the channel. */
export function askTs(ask: Pick<AskState, "id" | "channel">): string {
  return ask.id.slice(ask.channel.length + 1);
}

/** Fold ledger lines into the current state per ask (latest line wins). */
export function mergeAskLines(lines: AskLedgerLine[]): AskState[] {
  const states = new Map<string, AskState>();
  for (const line of lines) {
    const previous = states.get(line.id);
    if (previous) {
      states.set(line.id, { ...previous, ...line } as AskState);
    } else if (line.status === "open") {
      states.set(line.id, line as AskState);
    }
  }
  return [...states.values()];
}

/** An alias hands its obligation to the ask it names, so it owes nothing itself. */
function isAliasAsk(ask: AskState): boolean {
  return ask.alias_of !== undefined;
}

/** An alias, a duplicate, a tombstone and an answer all owe nothing. */
function isPendingAsk(ask: AskState): boolean {
  return !isAliasAsk(ask) && PENDING_ASK_STATUSES.has(ask.status);
}

/** A threaded reply answers every pending ask in that thread (thread root included). */
function threadReplyAnswersAsk(ask: AskState, threadTs: string): boolean {
  return (ask.thread_ts ?? askTs(ask)) === threadTs;
}

/**
 * Select the asks a reply answers. A threaded reply answers every pending ask in
 * that thread. A top-level reply (DM or channel post without a thread) answers only
 * the newest pending top-level ask in that channel, so one proactive post cannot
 * silently close older asks.
 */
export function selectAnsweredAsks(asks: AskState[], reply: AskReply): AskState[] {
  const pending = asks.filter((ask) => isPendingAsk(ask) && ask.channel === reply.channel);
  if (reply.thread_ts) {
    const threadTs = reply.thread_ts;
    return pending.filter((ask) => threadReplyAnswersAsk(ask, threadTs));
  }
  const newestTopLevel = pending
    .filter((ask) => ask.thread_ts === undefined)
    .toSorted((left, right) => left.received_at.localeCompare(right.received_at))
    .at(-1);
  return newestTopLevel ? [newestTopLevel] : [];
}

/** The ask that already carries this source's obligation, whatever state it is in. */
export function findAskBySource(asks: AskState[], candidate: AskOpenRecord): AskState | undefined {
  return asks.find(
    (ask) => ask.id !== candidate.id && ask.source_message_id === candidate.source_message_id,
  );
}

/** Unparsable timestamps (a hand-edited line) keep the pair apart rather than merging them. */
function receivedWithinDuplicateWindow(ask: AskState, receivedAt: string): boolean {
  const askMs = Date.parse(ask.received_at);
  const candidateMs = Date.parse(receivedAt);
  return (
    Number.isFinite(askMs) &&
    Number.isFinite(candidateMs) &&
    Math.abs(candidateMs - askMs) <= DUPLICATE_ASK_WINDOW_MS
  );
}

/** `AskState` is a cast over JSONL other processes write, so the text may be missing. */
function readAskText(ask: AskState): string | undefined {
  return typeof ask.text === "string" ? normalizeAskText(ask.text) : undefined;
}

/**
 * The earlier ask a new one repeats: same channel, same user, same normalized text,
 * received inside the window, and still open, acknowledged or answered. The oldest
 * match wins, so every repeat points at the original. A deleted original is skipped
 * on purpose: the user withdrew it, so asking again is a real new ask.
 */
export function findDuplicateAsk(asks: AskState[], candidate: AskOpenRecord): AskState | undefined {
  const text = normalizeAskText(candidate.text);
  return asks
    .filter(
      (ask) =>
        ask.id !== candidate.id &&
        !isAliasAsk(ask) &&
        ask.channel === candidate.channel &&
        ask.user === candidate.user &&
        DUPLICATE_SUPPRESSING_STATUSES.has(ask.status) &&
        receivedWithinDuplicateWindow(ask, candidate.received_at) &&
        readAskText(ask) === text,
    )
    .toSorted((left, right) => left.received_at.localeCompare(right.received_at))
    .at(0);
}

function buildAnsweredRecord(ask: AskState, reply: AskReply): AskAnsweredRecord {
  return {
    id: ask.id,
    status: "answered",
    answered_at: reply.answered_at,
    answer_ts: reply.answer_ts,
  };
}

/** The ask an already-recorded line hands its obligation to, if any. */
function readSupersededBy(ask: AskState): AskSupersededBy | undefined {
  if (ask.alias_of) {
    return { kind: "alias", askId: ask.alias_of };
  }
  return ask.duplicate_of ? { kind: "duplicate", askId: ask.duplicate_of } : undefined;
}

export class AskLedger {
  constructor(
    private readonly filePath: string,
    private readonly onMalformedLines?: (lines: number[]) => void,
  ) {}

  private reportMalformed(lines: number[]): void {
    if (lines.length > 0) {
      this.onMalformedLines?.(lines);
    }
  }

  /**
   * Record one inbound ask. Every ask opens with its own record, because an id only
   * becomes an ask when its first line is `open`; the supersession is the line right
   * after it, written in the same append. The same source under a new id is an alias
   * of the ask that already owns the obligation, and a distinct source repeating a
   * recent ask is a duplicate of it. An id already in the ledger is never rewritten.
   */
  recordInboundAsk(ask: AskOpenRecord): Promise<AskRecordOutcome> {
    return appendJsonlRecordsAfterRead<AskLedgerLine, AskRecordOutcome>(
      this.filePath,
      (current) => {
        this.reportMalformed(current.malformedLines);
        const asks = mergeAskLines(current.records);
        // Only an open record counts as known: an orphan status line written by asks.py
        // before the inbound hook ran must not block the record forever.
        const known = asks.find((state) => state.id === ask.id);
        if (known) {
          const supersededBy = readSupersededBy(known);
          return {
            append: [],
            result: { appended: false, ...(supersededBy ? { supersededBy } : {}) },
          };
        }
        const sameSource = findAskBySource(asks, ask);
        if (sameSource) {
          const canonicalId = sameSource.alias_of ?? sameSource.id;
          const alias: AskAliasRecord = { id: ask.id, alias_of: canonicalId };
          return {
            append: [ask, alias],
            result: { appended: true, supersededBy: { kind: "alias", askId: canonicalId } },
          };
        }
        const original = findDuplicateAsk(asks, ask);
        if (!original) {
          return { append: [ask], result: { appended: true } };
        }
        const duplicate: AskDuplicateRecord = {
          id: ask.id,
          status: "duplicate",
          duplicate_of: original.id,
        };
        return {
          append: [ask, duplicate],
          result: { appended: true, supersededBy: { kind: "duplicate", askId: original.id } },
        };
      },
    );
  }

  /** Tombstone the ask whose message was deleted. Returns true when one was written. */
  markDeleted(askId: string, deletedAt: string): Promise<boolean> {
    return appendJsonlRecordsAfterRead<AskLedgerLine, boolean>(this.filePath, (current) => {
      this.reportMalformed(current.malformedLines);
      const known = mergeAskLines(current.records).find((ask) => ask.id === askId);
      if (!known || known.status === "deleted") {
        return { append: [], result: false };
      }
      const tombstone: AskDeletedRecord = { id: askId, status: "deleted", deleted_at: deletedAt };
      return { append: [tombstone], result: true };
    });
  }

  /** Append an answered line for each ask this reply answers. Returns the answered ids. */
  markAnswered(reply: AskReply): Promise<string[]> {
    return appendJsonlRecordsAfterRead<AskLedgerLine, string[]>(this.filePath, (current) => {
      this.reportMalformed(current.malformedLines);
      const answered = selectAnsweredAsks(mergeAskLines(current.records), reply);
      return {
        append: answered.map((ask) => buildAnsweredRecord(ask, reply)),
        result: answered.map((ask) => ask.id),
      };
    });
  }
}
