/* oxlint-disable -- Preserved crash-recovery ledger overlay; behavior is covered by its deterministic SQLite tests. */
/**
 * Reviewer in-flight ledger — crash-safe durable record of reviewer continues.
 *
 * WHY THIS EXISTS
 *   After the reviewer dispatches a synthetic "continue" to the main agent, the
 *   gateway can die (OOM, SIGTERM, a config-deploy that restarts twice) before
 *   the agent finishes its reply. The continue is an in-process callback with no
 *   Slack record, so it is lost forever and the bot looks silent on the reviewer.
 *   (Incident: 2026-05-28, thread 1779990203 — a continue was permanently dropped
 *   when a double-restart wiped the old read-and-clear JSON recovery files.)
 *
 * THE DURABILITY CONTRACT — AT-LEAST-ONCE + IDEMPOTENT REPLAY
 *   - NEVER clear on read. A row is removed ONLY when the work is provably done
 *     (reviewer approve / maxIterations / agent turn-complete) or when recovery
 *     confirms via Slack that the agent already replied after the dispatch.
 *   - Recovery is therefore safe to run any number of times: re-dispatching an
 *     already-answered continue is prevented by the Slack "did the bot reply
 *     after last_dispatch?" idempotency check (reviewerContinueAnswered in
 *     handler.ts), and closes are compare-and-delete on last_dispatch. At most one
 *     reply ever lands.
 *   - A crash DURING recovery loses nothing: the rows are still on disk, the next
 *     boot re-reads them. This is the exact property the old JSON ledgers lacked.
 *
 * STORAGE
 *   node:sqlite (Node >= 22.5) in WAL mode, mirroring the runtime's other stores
 *   (plugin-state, task-registry). synchronous=NORMAL is durable against process
 *   death (the entire threat model here); only raw power loss can drop the last
 *   commit, and WAL never corrupts. WAL also gives torn-write atomicity for free.
 *
 * ISOLATION
 *   Self-contained fork-local module. All ledger logic lives here; handler.ts only
 *   calls the exported functions. Every function is best-effort and NEVER throws
 *   into the live reviewer path — a broken ledger degrades to "no recovery", never
 *   to a broken bot.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../../../infra/node-sqlite.js";
import {
  configureSqliteWalMaintenance,
  type SqliteWalMaintenance,
} from "../../../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/inflight-ledger");

/**
 * Row kind decides the recovery "answered?" test:
 *   - "continue": a reviewer continue was dispatched. Answered = a bot reply lands AFTER
 *     last_dispatch (a later human message does NOT un-answer it).
 *   - "engage": the bot owes a reply to the thread (a mention arrived, or a review was
 *     mid-flight). Answered = the bot's reply is the latest substantive message (i.e. no
 *     unaddressed newer human message) — the original active-threads semantics.
 */
export type InflightKind = "continue" | "engage";

export interface InflightTurnRow {
  key: string;
  channel: string;
  thread: string;
  kind: InflightKind;
  iteration: number;
  payload: string;
  opened_at: number;
  last_dispatch: number;
  attempts: number;
}

export interface RecoverResult {
  /** Rows to verify-and-maybe-respawn (newest-first, within cap, under ceiling). NOT deleted. */
  recovered: InflightTurnRow[];
  /** Eligible rows beyond the respawn cap — KEPT (deferred to a later restart), never lost. */
  deferredOverflow: number;
  /** Rows over the attempts ceiling — KEPT and escalated (manual attention), never lost. */
  quarantined: number;
}

const CHANNEL_RE = /^C[A-Z0-9]+$/i;
const THREAD_RE = /^\d+\.\d+$/;

function keyOf(channel: string, thread: string): string {
  return `${channel}:${thread}`;
}

function isValidKey(channel: string, thread: string): boolean {
  return CHANNEL_RE.test(channel) && THREAD_RE.test(thread);
}

export function getInflightLedgerPath(): string {
  if (process.env.OPENCLAW_REVIEWER_INFLIGHT_DB_PATH) {
    return process.env.OPENCLAW_REVIEWER_INFLIGHT_DB_PATH;
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "reviewer-inflight.sqlite");
}

interface LedgerHandle {
  db: DatabaseSync;
  wal: SqliteWalMaintenance;
  upsert: StatementSync;
  del: StatementSync;
  delIfUnchanged: StatementSync;
  selectByKey: StatementSync;
  bumpAttempt: StatementSync;
  selectForRecovery: StatementSync;
}

let cached: LedgerHandle | null = null;

function ensureParentDir(target: string): void {
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

/**
 * Open (or return the cached) ledger. Never throws — returns null if SQLite is
 * unavailable or the DB can't be opened, so callers degrade gracefully.
 */
export function openInflightLedger(): LedgerHandle | null {
  if (cached) {
    return cached;
  }
  try {
    const dbPath = getInflightLedgerPath();
    ensureParentDir(dbPath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    // WAL + NORMAL: durable against OOM/SIGTERM/restart; busy_timeout for the rare
    // overlap between a live write and the startup recovery read.
    const wal = configureSqliteWalMaintenance(db);
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS inflight_turn (
        key           TEXT PRIMARY KEY,
        channel       TEXT NOT NULL,
        thread        TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'continue',
        iteration     INTEGER NOT NULL,
        payload       TEXT NOT NULL DEFAULT '',
        opened_at     INTEGER NOT NULL,
        last_dispatch INTEGER NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Defensive migration: add `kind` to a pre-existing table created before this column.
    if (!tableHasColumn(db, "inflight_turn", "kind")) {
      db.exec(`ALTER TABLE inflight_turn ADD COLUMN kind TEXT NOT NULL DEFAULT 'continue';`);
    }
    cached = {
      db,
      wal,
      // opened_at is preserved on conflict (age ordering). attempts RESET to 0: an upsert is
      // LIVE activity (a fresh mention / review / continue), which means the thread is being
      // actively handled — so the recovery-failure counter is cleared. The quarantine ceiling
      // therefore only trips on consecutive *recovery* failures with no intervening live activity
      // (a genuine poison pill), never a thread that is making normal progress. A "continue"
      // never downgrades to "engage" (a real reviewer ask outranks a bare mention).
      upsert: db.prepare(`
        INSERT INTO inflight_turn (key, channel, thread, kind, iteration, payload, opened_at, last_dispatch, attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(key) DO UPDATE SET
          kind          = CASE WHEN inflight_turn.kind = 'continue' THEN 'continue' ELSE excluded.kind END,
          iteration     = excluded.iteration,
          payload       = CASE WHEN inflight_turn.kind = 'continue' AND excluded.kind = 'engage' THEN inflight_turn.payload ELSE excluded.payload END,
          last_dispatch = excluded.last_dispatch,
          attempts      = 0
      `),
      del: db.prepare(`DELETE FROM inflight_turn WHERE key = ?`),
      // Compare-and-delete: only close if the row's continue is the one we read (same
      // last_dispatch). If a newer continue refreshed the row between our read and this
      // delete, it's a no-op — the newer, still-outstanding continue is preserved.
      delIfUnchanged: db.prepare(`DELETE FROM inflight_turn WHERE key = ? AND last_dispatch = ?`),
      selectByKey: db.prepare(`SELECT * FROM inflight_turn WHERE key = ?`),
      bumpAttempt: db.prepare(
        `UPDATE inflight_turn SET attempts = attempts + 1, last_dispatch = ? WHERE key = ?`,
      ),
      // Filter + order by last_dispatch (NOT opened_at, which UPSERT preserves): this excludes
      // a row a live review refreshed during startup (its last_dispatch jumps past
      // recoveryStartMs → the live flow owns it), and surfaces the most-recently-active first.
      selectForRecovery: db.prepare(
        `SELECT * FROM inflight_turn WHERE last_dispatch < ? ORDER BY last_dispatch DESC`,
      ),
    };
    return cached;
  } catch (err) {
    // Loud: if the durable store can't open, crash-recovery of reviewer continues is
    // disabled for this run (the bot still works; it just can't replay across a restart).
    log.error(`open failed — reviewer continue recovery DISABLED this run: ${String(err)}`);
    cached = null;
    return null;
  }
}

/**
 * OPEN / refresh an in-flight row. For a "continue" call it the instant the reviewer
 * dispatches, BEFORE awaiting the dispatch (so the record survives a mid-dispatch kill).
 * For an "engage" call it when a mention arrives or a review starts. A "continue" never
 * downgrades to "engage" (the UPSERT preserves the stronger kind + its payload). Never throws.
 */
export function upsertInflightTurn(entry: {
  channel: string;
  thread: string;
  kind: InflightKind;
  iteration: number;
  payload: string;
}): void {
  if (!isValidKey(entry.channel, entry.thread)) {
    log.warn(`refusing to track invalid Slack key: ${entry.channel}:${entry.thread}`);
    return;
  }
  const h = openInflightLedger();
  if (!h) return;
  try {
    const now = Date.now();
    h.upsert.run(
      keyOf(entry.channel, entry.thread),
      entry.channel,
      entry.thread,
      entry.kind,
      entry.iteration,
      entry.payload,
      now,
      now,
    );
  } catch (err) {
    log.warn(`upsert failed for ${entry.channel}:${entry.thread}: ${String(err)}`);
  }
}

/**
 * CLOSE an in-flight turn — call when the work is provably done (reviewer approve,
 * maxIterations, agent turn-complete, or recovery-confirmed-answered). Never throws.
 */
export function closeInflightTurn(channel: string, thread: string): void {
  const h = openInflightLedger();
  if (!h) return;
  try {
    const res = h.del.run(keyOf(channel, thread));
    if (res.changes > 0) {
      log.info(`closed: ${channel}:${thread}`);
    }
  } catch (err) {
    log.warn(`close failed for ${channel}:${thread}: ${String(err)}`);
  }
}

/**
 * Compare-and-delete close: remove the row ONLY if its `last_dispatch` still equals
 * `expectedLastDispatch` (the value the caller read before its async answer-check). If a
 * newer continue refreshed the row in between, this is a no-op — so a stale close (from a
 * delayed turn-complete or an in-flight recovery probe) can't delete newer outstanding
 * work. Use this whenever there is an await between reading the row and closing it.
 * Never throws.
 */
export function closeInflightTurnIfUnchanged(
  channel: string,
  thread: string,
  expectedLastDispatch: number,
): void {
  const h = openInflightLedger();
  if (!h) return;
  try {
    const res = h.delIfUnchanged.run(keyOf(channel, thread), expectedLastDispatch);
    if (res.changes > 0) {
      log.info(`closed (confirmed answered): ${channel}:${thread}`);
    }
  } catch (err) {
    log.warn(`compare-and-delete close failed for ${channel}:${thread}: ${String(err)}`);
  }
}

/**
 * Look up the open in-flight row for a thread (or undefined). Cheap — used by the
 * agent:turn-complete handler to decide, without a Slack call in the common case, whether
 * a thread even has outstanding reviewer work before doing the answer-confirmation check.
 * Never throws.
 */
export function getOpenInflightTurn(channel: string, thread: string): InflightTurnRow | undefined {
  const h = openInflightLedger();
  if (!h) return undefined;
  try {
    return (h.selectByKey.get(keyOf(channel, thread)) as InflightTurnRow | undefined) ?? undefined;
  } catch (err) {
    log.warn(`lookup failed for ${channel}:${thread}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Record a recovery respawn attempt — call BEFORE awaiting the respawn dispatch,
 * so a crash mid-dispatch over-counts by at most one (safe; the attempts ceiling
 * still trips) rather than under-counting (which would loop forever). Never throws.
 */
export function markInflightAttempt(channel: string, thread: string): void {
  const h = openInflightLedger();
  if (!h) return;
  try {
    h.bumpAttempt.run(Date.now(), keyOf(channel, thread));
  } catch (err) {
    log.warn(`markAttempt failed for ${channel}:${thread}: ${String(err)}`);
  }
}

/**
 * RECOVERY read — returns the rows to verify-and-maybe-respawn. The durability
 * contract: recovery NEVER deletes a row. Cap overflow is DEFERRED (kept for a later
 * restart) and ceiling-exceeded rows are QUARANTINED (kept, escalated) — a row only
 * ever leaves the ledger on a confirmed answer (recovery / turn-complete) or explicit
 * resolution (approve / maxIterations). `recoveryStartMs` (captured before any startup
 * await) excludes rows opened by a live review racing the startup loop. Never throws.
 */
export function recoverInflightTurns(opts: {
  capNewestFirst: number;
  attemptsCeiling: number;
  recoveryStartMs: number;
}): RecoverResult {
  const empty: RecoverResult = { recovered: [], deferredOverflow: 0, quarantined: 0 };
  const h = openInflightLedger();
  if (!h) return empty;
  try {
    const rows = h.selectForRecovery.all(opts.recoveryStartMs) as unknown as InflightTurnRow[]; // most-recently-dispatched first

    // Over the attempts ceiling → quarantine: stop auto-respawning, but KEEP the row
    // (escalation, never deletion — a poison-pill continue gets human attention, not loss).
    const quarantined = rows.filter((r) => r.attempts > opts.attemptsCeiling).length;
    const eligible = rows.filter((r) => r.attempts <= opts.attemptsCeiling); // still newest-first
    const recovered = eligible.slice(0, opts.capNewestFirst);
    // Eligible rows beyond the cap are DEFERRED (kept) — a later restart picks them up as
    // the active ones drain. Respawning <= cap per restart honors "don't respawn everything".
    const deferredOverflow = Math.max(0, eligible.length - opts.capNewestFirst);

    return { recovered, deferredOverflow, quarantined };
  } catch (err) {
    log.warn(`recover failed: ${String(err)}`);
    return empty;
  }
}

/** Explicit WAL checkpoint — call after the recovery loop (the auto-checkpoint timer is unref'd). */
export function checkpointInflightLedger(): void {
  const h = openInflightLedger();
  if (!h) return;
  try {
    h.wal.checkpoint();
  } catch (err) {
    log.warn(`checkpoint failed: ${String(err)}`);
  }
}

/**
 * Test-only: close the DB handle and drop the cache so the next call reopens from
 * disk (simulates a gateway restart). Also used by tests to point at a tmp path.
 */
export function closeInflightLedgerForTest(): void {
  if (!cached) return;
  try {
    cached.wal.close();
    cached.db.close();
  } catch {
    /* best-effort */
  }
  cached = null;
}

/** Test-only: insert/replace a row with explicit timestamps for deterministic tests. */
export function _seedInflightRowForTest(row: InflightTurnRow): void {
  const h = openInflightLedger();
  if (!h) return;
  h.db
    .prepare(
      `INSERT OR REPLACE INTO inflight_turn
         (key, channel, thread, kind, iteration, payload, opened_at, last_dispatch, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.key,
      row.channel,
      row.thread,
      row.kind,
      row.iteration,
      row.payload,
      row.opened_at,
      row.last_dispatch,
      row.attempts,
    );
}

/** Test-only: list all rows, newest-first. */
export function _listInflightTurnsForTest(): InflightTurnRow[] {
  const h = openInflightLedger();
  if (!h) return [];
  return h.db
    .prepare(`SELECT * FROM inflight_turn ORDER BY opened_at DESC`)
    .all() as unknown as InflightTurnRow[];
}
