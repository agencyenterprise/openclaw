// Byte accounting for the SQLite session disk budget: an O(1) whole-database
// upper bound that gates the hot path, plus the exact per-session breakdown the
// budget sweep needs once eviction is actually possible.
import { sql } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SqliteSessionRowBytes } from "./session-accessor.sqlite-disk-budget.js";
import { normalizeSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

type SqliteHeaderPragma = "freelist_count" | "page_count" | "page_size";

function readSqliteHeaderPragma(
  database: OpenClawAgentDatabase,
  pragma: SqliteHeaderPragma,
): number {
  // sqlite-allow-raw: database header counters are connection state, not a
  // table Kysely can model. The pragma name is a closed union, never input.
  const row = database.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`SQLite PRAGMA ${pragma} returned no numeric value`);
  }
  return normalizeSqliteNumber(value);
}

/**
 * Bytes held by the database's live (non-freelist) pages.
 *
 * Three header reads, no table access: measured at 1.4 ms on the 2.28 GB
 * production agent database.
 */
export function readSqliteLiveDatabaseBytes(database: OpenClawAgentDatabase): number {
  const pageSize = readSqliteHeaderPragma(database, "page_size");
  const pageCount = readSqliteHeaderPragma(database, "page_count");
  const freelistCount = readSqliteHeaderPragma(database, "freelist_count");
  return Math.max(0, pageCount - freelistCount) * pageSize;
}

/**
 * Whether the session rows *could* exceed `maxDiskBytes`, decided without
 * touching a single table row.
 *
 * The disk budget used to answer this exactly, with four
 * `SUM(length(CAST(... AS BLOB)))` full-table scans on every maintenance pass.
 * On the production agent database (2.28 GB; `trajectory_runtime_events` alone
 * 1064 MB across 45,095 rows) those scans cost ~1.5 s each under load and, being
 * synchronous node:sqlite calls, blocked the whole Node event loop:
 * `eventLoopDelayMaxMs` peaked at 9210.7 ms with `eventLoopUtilization` 0.999,
 * expiring every prompt-path timer (3 s memory recall, 1 s log append, 5 s
 * plugin hook budget) on work that was itself fast. 92 stalls of 31-46 s over
 * three days, each preceded by a burst of four `slow SQLite transaction hold`
 * warnings - one per scan.
 *
 * `(page_count - freelist_count) * page_size` is a hard upper bound on those
 * sums, because every tracked JSON column lives inside the database's live
 * pages. A database at or under the budget therefore provably cannot be over it,
 * so the exact scan only runs when eviction is genuinely possible. On the same
 * database this gate measures 0.1 ms against the 758 ms the scans cost.
 *
 * `dbstat` is compiled into this node:sqlite build but is not an alternative: it
 * walks every page, measuring 1532 ms for the aggregate form and 600 ms for
 * `trajectory_runtime_events` alone - slower than the scans it would replace.
 */
export function mayExceedSqliteSessionDiskBudget(
  database: OpenClawAgentDatabase,
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxDiskBytes" | "highWaterBytes">,
): boolean {
  if (maintenance.maxDiskBytes == null || maintenance.highWaterBytes == null) {
    return false;
  }
  return readSqliteLiveDatabaseBytes(database) > maintenance.maxDiskBytes;
}

// `octet_length(x)` reports the same byte count as `length(CAST(x AS BLOB))`
// while reading the record-header serial type instead of every overflow page, so
// a multi-KB JSON row no longer has to be materialized to be measured. Every
// column summed below is `TEXT NOT NULL` in a STRICT table, so the two forms
// agree by construction - no NULL or storage-class divergence to reconcile, and
// the totals matched byte-for-byte across all four production tables.
// Measured on the production agent database: this pass costs 251 ms, against
// 953 ms for the CAST form that also pulled every `entry_json` into JS to
// measure it there. Needs SQLite >= 3.43; every Node release in package.json
// `engines` bundles SQLite >= 3.51.

function entryJsonBytes() {
  return (
    // kysely-allow-raw: SQLite byte accounting needs octet_length(), which
    // Kysely does not expose as a typed function helper.
    sql<number | bigint>`octet_length(entry_json)`.as("entry_json_bytes")
  );
}

function sumEventJsonBytes() {
  return (
    // kysely-allow-raw: SQLite byte accounting needs octet_length(), which
    // Kysely does not expose as a typed aggregate helper.
    sql<number | bigint>`COALESCE(SUM(octet_length(event_json)), 0)`.as("event_json_bytes")
  );
}

function sumReportJsonBytes() {
  return (
    // kysely-allow-raw: SQLite byte accounting needs octet_length(), which
    // Kysely does not expose as a typed aggregate helper.
    sql<number | bigint>`COALESCE(SUM(octet_length(report_json)), 0)`.as("report_json_bytes")
  );
}

/**
 * Exact per-session JSON byte totals for the disk-budget sweep.
 *
 * Off the routine path: only reached once `mayExceedSqliteSessionDiskBudget()`
 * cannot rule out an overflow, or from the explicit `sessions cleanup` preview.
 */
export function readSqliteSessionRowBytes(database: OpenClawAgentDatabase): SqliteSessionRowBytes {
  const db = getSessionKysely(database.db);
  const entryRows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key"]).select(entryJsonBytes()),
  ).rows;
  const transcriptRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["session_id"])
      .select(sumEventJsonBytes())
      .groupBy("session_id"),
  ).rows;
  const trajectoryRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("trajectory_runtime_events")
      .select(["session_id"])
      .select(sumEventJsonBytes())
      .groupBy("session_id"),
  ).rows;
  const reportRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_prompt_reports")
      .select(["session_id"])
      .select(sumReportJsonBytes())
      .groupBy("session_id"),
  ).rows;
  const entryBytesByKey = new Map<string, number>();
  for (const row of entryRows) {
    entryBytesByKey.set(row.session_key, normalizeSqliteNumber(row.entry_json_bytes ?? 0));
  }
  const transcriptBytesBySessionId = new Map<string, number>();
  for (const row of transcriptRows) {
    transcriptBytesBySessionId.set(
      row.session_id,
      normalizeSqliteNumber(row.event_json_bytes ?? 0),
    );
  }
  const trajectoryBytesBySessionId = new Map<string, number>();
  for (const row of trajectoryRows) {
    trajectoryBytesBySessionId.set(
      row.session_id,
      normalizeSqliteNumber(row.event_json_bytes ?? 0),
    );
  }
  const reportBytesBySessionId = new Map<string, number>();
  for (const row of reportRows) {
    reportBytesBySessionId.set(row.session_id, normalizeSqliteNumber(row.report_json_bytes ?? 0));
  }
  return {
    entryBytesByKey,
    reportBytesBySessionId,
    trajectoryBytesBySessionId,
    transcriptBytesBySessionId,
  };
}
