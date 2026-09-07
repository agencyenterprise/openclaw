// Which lanes govern a command. An explicit `# lane:<id>` marker inside the
// command wins, because the operator named it. Otherwise the lanes are the
// active ones authorized in the thread this turn came from: a lane is authorized
// in a thread, so the thread is what links a command to it.
//
// Three spellings of that one fact exist, because three writers write it: an
// explicit `origin` object, a permalink carrying the thread in its query, and a
// permalink to the go message — which is usually a reply inside the thread, not
// its root. Only the last one needs resolving, and it is resolved from the ask
// ledger the sibling hook maintains rather than from Slack, so this stays offline.
//
// Everything here fails closed. Both halves are matched exactly, never as a
// substring: `C123` is a substring of `C1234`, and a thread ts can be a substring
// of a longer one. Sources that contradict each other authorize nothing rather
// than being resolved by precedence, because a channel taken from one source and
// a thread from another is an authorization nobody wrote. A ts that is not a
// Slack ts is not a thread.
//
// Several lanes can cover one thread — a parent lane and the run it spawned —
// so every match is returned. Which one authorizes a given command is a
// different question, answered by lane-selection.ts.
import path from "node:path";
import { buildAskId } from "../../slack-thread.js";
import {
  readJsonFile,
  readJsonlRecords,
  resolveWorkspaceStatePath,
} from "../../workspace-state.js";
import { ASK_LEDGER_FILE } from "../ask-ledger/ledger.js";
import { extractExplicitLaneId } from "./classify.js";
import { listActiveLaneIds, type LaneCliRunner, resolveLaneStateDir } from "./lane-cli.js";

export type LaneThread = {
  channel?: string;
  threadTs?: string;
};

/** `https://<host>/archives/<CHANNEL>/p<ts without its dot>[?thread_ts=<root>&cid=<CHANNEL>]` */
const PERMALINK_ARCHIVE_RE = /\/archives\/([a-z0-9]+)\/p(\d+)(?=[?#]|$)/i;
/** Every archive-looking segment, anchored to nothing: a permalink may carry only one. */
const PERMALINK_ARCHIVE_SEGMENTS_RE = /\/archives\/[a-z0-9]+\/p\d+/gi;
const PERMALINK_THREAD_TS_RE = /[?&]thread_ts=(\d+\.\d+)/;
const PERMALINK_CID_RE = /[?&]cid=([a-z0-9]+)/i;
/**
 * A Slack ts is ten second digits and exactly six microsecond digits. The shared
 * `isSlackTs` accepts any fractional length, and tightening it would change how
 * the ask-ledger, outbound-dedupe and turn-gate hooks validate message ids, so
 * the precision this matcher needs lives here instead.
 */
const CANONICAL_TS_RE = /^\d{10}\.\d{6}$/;
const TS_MICROSECOND_DIGITS = 6;

type LaneRecord = {
  origin_permalink?: unknown;
  origin?: { channel?: unknown; thread_ts?: unknown };
};

/** Where a lane record says it was authorized. A lane with no channel is nobody's. */
type LaneOrigin = {
  channel: string;
  /** The thread the record names outright: `origin.thread_ts`, or the permalink query. */
  threadTs?: string;
  /** The message the permalink points at, whose own thread still has to be resolved. */
  messageTs?: string;
};

type LaneCandidate = { laneId: string; origin: LaneOrigin };

type ArchiveSegment = { channel: string; messageTs?: string };

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}

/** True when two sources state different values for one fact. */
function disagree(
  values: string[],
  normalize: (value: string) => string = (value) => value,
): boolean {
  return new Set(values.map(normalize)).size > 1;
}

function isCanonicalSlackTs(value: string): boolean {
  return CANONICAL_TS_RE.test(value);
}

/** Slack permalinks drop the dot: `p1788507056648349` is `1788507056.648349`. */
function canonicalTsFromDigits(digits: string): string | undefined {
  const ts = `${digits.slice(0, -TS_MICROSECOND_DIGITS)}.${digits.slice(-TS_MICROSECOND_DIGITS)}`;
  return isCanonicalSlackTs(ts) ? ts : undefined;
}

/**
 * The one `/archives/<CH>/p<ts>` segment a permalink carries. More than one, or
 * anything after the message ts, is not a Slack permalink and contributes
 * nothing — the record's own `origin` object still speaks for it.
 */
function readArchiveSegment(permalink: string): ArchiveSegment | undefined {
  const segments = permalink.match(PERMALINK_ARCHIVE_SEGMENTS_RE);
  const parsed = segments?.length === 1 ? permalink.match(PERMALINK_ARCHIVE_RE) : undefined;
  const channel = parsed?.[1];
  const digits = parsed?.[2];
  if (!channel) {
    return undefined;
  }
  return { channel, messageTs: digits ? canonicalTsFromDigits(digits) : undefined };
}

/** Where the record says it was authorized, or undefined when its own sources disagree. */
function readLaneOrigin(record: LaneRecord): LaneOrigin | undefined {
  const permalink = readString(record.origin_permalink) ?? "";
  const archive = readArchiveSegment(permalink);
  const channels = [
    readString(record.origin?.channel),
    archive?.channel,
    permalink.match(PERMALINK_CID_RE)?.[1],
  ].filter(isPresent);
  const threads = [
    readString(record.origin?.thread_ts),
    permalink.match(PERMALINK_THREAD_TS_RE)?.[1],
  ].filter(isPresent);
  const channel = channels[0];
  if (
    !channel ||
    disagree(channels, (value) => value.toLowerCase()) ||
    disagree(threads) ||
    threads.some((ts) => !isCanonicalSlackTs(ts))
  ) {
    return undefined;
  }
  return { channel, threadTs: threads[0], messageTs: archive?.messageTs };
}

/** A lane is authorized in one channel; a bare thread ts must not cross into another. */
function sameChannel(origin: LaneOrigin, thread: LaneThread): boolean {
  return origin.channel.toLowerCase() === thread.channel?.toLowerCase();
}

/** The spellings the lane record answers on its own: a named thread, or a permalink to its root. */
function originNamesThread(origin: LaneOrigin, thread: LaneThread): boolean {
  return origin.threadTs === thread.threadTs || origin.messageTs === thread.threadTs;
}

type AskLedgerLine = { id?: unknown; channel?: unknown; thread_ts?: unknown };

/** Ask ids are `<channel>:<ts>`, and a channel id reaches the ledger and the session key in either case. */
function askKey(askId: string): string {
  return askId.toUpperCase();
}

/** An ask id starts with its own channel; a line naming another one is not about that ask. */
function channelMatchesAskId(record: AskLedgerLine, askId: string): boolean {
  const channel = readString(record.channel);
  return channel === undefined || askKey(askId).startsWith(`${channel.toUpperCase()}:`);
}

/**
 * The thread each ask belongs to, from the ledger the ask-ledger hook maintains.
 * Only an `open` line carries `thread_ts`; the later status lines for the same id
 * carry none, so they cannot erase it.
 *
 * Python crons share this file, so a second writer can contradict the first. An
 * ask id that names two threads, a ts that is not a Slack ts, or a line whose
 * channel is not the one in its own id answers for nothing at all: last writer
 * wins would let one bad line move a lane into a thread of the writer's choosing.
 */
async function readAskThreads(workspaceDir: string): Promise<Map<string, string>> {
  const { records } = await readJsonlRecords<AskLedgerLine>(
    resolveWorkspaceStatePath(workspaceDir, ASK_LEDGER_FILE),
  );
  const threads = new Map<string, string>();
  const contradicted = new Set<string>();
  for (const record of records) {
    const askId = readString(record.id);
    const threadTs = readString(record.thread_ts);
    if (!askId || !threadTs) {
      continue;
    }
    const key = askKey(askId);
    const known = threads.get(key);
    if (
      (known !== undefined && known !== threadTs) ||
      !isCanonicalSlackTs(threadTs) ||
      !channelMatchesAskId(record, askId)
    ) {
      contradicted.add(key);
      continue;
    }
    threads.set(key, threadTs);
  }
  for (const key of contradicted) {
    threads.delete(key);
  }
  return threads;
}

function messageBelongsToThread(
  origin: LaneOrigin,
  thread: LaneThread,
  askThreads: Map<string, string>,
): boolean {
  if (!origin.messageTs) {
    return false;
  }
  return askThreads.get(askKey(buildAskId(origin.channel, origin.messageTs))) === thread.threadTs;
}

function readLaneRecord(laneStateDir: string, laneId: string): Promise<LaneRecord> {
  return readJsonFile<LaneRecord>(path.join(laneStateDir, `${laneId}.json`), {});
}

/** Every active lane in this thread's channel, in the order `lane.py list` returned them. */
async function readChannelCandidates(params: {
  thread: LaneThread;
  workspaceDir: string;
  run: LaneCliRunner;
}): Promise<LaneCandidate[]> {
  const laneStateDir = resolveLaneStateDir(params.workspaceDir);
  const candidates: LaneCandidate[] = [];
  for (const laneId of await listActiveLaneIds(params.run)) {
    const origin = readLaneOrigin(await readLaneRecord(laneStateDir, laneId));
    if (origin && sameChannel(origin, params.thread)) {
      candidates.push({ laneId, origin });
    }
  }
  return candidates;
}

/**
 * Every active lane this thread was authorized in, in the order `lane.py list
 * --state active` returns them — it sorts by lane id, so the order is stable but
 * says nothing about which lane authorizes any particular work.
 *
 * Throws when the lane records or the ask ledger cannot be read; a lookup that
 * failed is not the same answer as a thread without a lane.
 */
export async function resolveLanesForThread(params: {
  thread: LaneThread;
  workspaceDir: string;
  run: LaneCliRunner;
}): Promise<string[]> {
  const { thread, workspaceDir } = params;
  if (!thread.channel || !thread.threadTs || !isCanonicalSlackTs(thread.threadTs)) {
    return [];
  }
  const candidates = await readChannelCandidates(params);
  const declared = candidates.filter(({ origin }) => originNamesThread(origin, thread));
  if (declared.length === candidates.length) {
    return declared.map(({ laneId }) => laneId);
  }
  // Read once, and only because some candidate's permalink named a message rather than a thread.
  const askThreads = await readAskThreads(workspaceDir);
  return candidates
    .filter(
      ({ origin }) =>
        originNamesThread(origin, thread) || messageBelongsToThread(origin, thread, askThreads),
    )
    .map(({ laneId }) => laneId);
}

/**
 * The lanes this command may be charged to. The `# lane:<id>` marker is honoured
 * here and nowhere else: an operator typed this command, so an id inside it names
 * the lane. Throws for the same reason `resolveLanesForThread` does.
 */
export async function resolveLanesForCommand(params: {
  command: string;
  thread: LaneThread;
  workspaceDir: string;
  run: LaneCliRunner;
}): Promise<string[]> {
  const explicit = extractExplicitLaneId(params.command);
  return explicit
    ? [explicit]
    : resolveLanesForThread({
        thread: params.thread,
        workspaceDir: params.workspaceDir,
        run: params.run,
      });
}
