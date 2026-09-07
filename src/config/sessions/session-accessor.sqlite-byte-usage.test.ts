// Disk-budget byte accounting tests: the maintenance path must decide without a
// full-table byte scan, while still reporting and evicting on exact figures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  mayExceedSqliteSessionDiskBudget,
  readSqliteLiveDatabaseBytes,
  readSqliteSessionRowBytes,
} from "./session-accessor.sqlite-byte-usage.js";
import { applySqliteSessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

const BYTE_SCAN_SQL = /octet_length|length\s*\(\s*cast/i;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function maintenanceConfig(
  overrides: Partial<ResolvedSessionMaintenanceConfig> = {},
): ResolvedSessionMaintenanceConfig {
  return {
    mode: "enforce",
    pruneAfterMs: TEN_YEARS_MS,
    maxEntries: 1000,
    modelRunPruneAfterMs: TEN_YEARS_MS,
    resetArchiveRetentionMs: null,
    maxDiskBytes: 1024 * 1024 * 1024,
    highWaterBytes: 512 * 1024 * 1024,
    ...overrides,
  };
}

/** Seeds one session with an entry row plus transcript, trajectory and report bytes. */
function seedSession(
  database: OpenClawAgentDatabase,
  params: { sessionKey: string; sessionId: string; payloadBytes: number },
): void {
  const payload = JSON.stringify({ text: "x".repeat(params.payloadBytes) });
  const entryJson = JSON.stringify({ sessionId: params.sessionId, updatedAt: Date.now() });
  database.db
    .prepare(
      `INSERT INTO sessions (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(params.sessionId, params.sessionKey, 1, Date.now());
  database.db
    .prepare(
      `INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(params.sessionKey, params.sessionId, entryJson, Date.now());
  database.db
    .prepare(
      `INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(params.sessionId, 1, payload, Date.now());
  database.db
    .prepare(
      `INSERT INTO trajectory_runtime_events (session_id, seq, event_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(params.sessionId, 1, payload, Date.now());
  database.db
    .prepare(
      `INSERT INTO session_prompt_reports (session_id, session_key, report_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(params.sessionId, params.sessionKey, payload, Date.now());
}

/** Records every SQL string prepared against the database until restored. */
function recordPreparedSql(database: OpenClawAgentDatabase): {
  statements: string[];
  restore: () => void;
} {
  const statements: string[] = [];
  const prepare = database.db.prepare.bind(database.db);
  const spy = vi.spyOn(database.db, "prepare").mockImplementation((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  });
  return { statements, restore: () => spy.mockRestore() };
}

/** Byte totals as the pre-fix implementation measured them, for equivalence checks. */
function readLegacyRowBytes(database: OpenClawAgentDatabase): {
  entryBytesByKey: Map<string, number>;
  reportBytesBySessionId: Map<string, number>;
  trajectoryBytesBySessionId: Map<string, number>;
  transcriptBytesBySessionId: Map<string, number>;
} {
  const byKey = (sql: string, key: string): Map<string, number> => {
    const rows = database.db.prepare(sql).all() as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [String(row[key]), Number(row.bytes)]));
  };
  return {
    entryBytesByKey: byKey(
      `SELECT session_key, length(CAST(entry_json AS BLOB)) AS bytes FROM session_entries`,
      "session_key",
    ),
    reportBytesBySessionId: byKey(
      `SELECT session_id, COALESCE(SUM(length(CAST(report_json AS BLOB))), 0) AS bytes
       FROM session_prompt_reports GROUP BY session_id`,
      "session_id",
    ),
    trajectoryBytesBySessionId: byKey(
      `SELECT session_id, COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) AS bytes
       FROM trajectory_runtime_events GROUP BY session_id`,
      "session_id",
    ),
    transcriptBytesBySessionId: byKey(
      `SELECT session_id, COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) AS bytes
       FROM transcript_events GROUP BY session_id`,
      "session_id",
    ),
  };
}

describe("SQLite session disk-budget byte accounting", () => {
  let database: OpenClawAgentDatabase;
  let archiveDirectory: string;

  beforeEach(() => {
    const stateDir = tempDirs.make("openclaw-session-byte-usage-");
    archiveDirectory = tempDirs.make("openclaw-session-byte-archive-");
    database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    for (const index of [1, 2, 3]) {
      seedSession(database, {
        sessionKey: `agent:main:byte-usage-${index}`,
        sessionId: `byte-usage-session-${index}`,
        payloadBytes: 4096,
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("reads live database bytes from header pragmas alone", () => {
    const recorded = recordPreparedSql(database);
    const liveBytes = readSqliteLiveDatabaseBytes(database);
    recorded.restore();

    expect(recorded.statements).toEqual([
      "PRAGMA page_size",
      "PRAGMA page_count",
      "PRAGMA freelist_count",
    ]);
    expect(liveBytes).toBeGreaterThan(0);

    const rowBytes = readSqliteSessionRowBytes(database);
    const trackedBytes = [
      ...rowBytes.entryBytesByKey.values(),
      ...rowBytes.transcriptBytesBySessionId.values(),
      ...rowBytes.trajectoryBytesBySessionId.values(),
      ...rowBytes.reportBytesBySessionId.values(),
    ].reduce((sum, bytes) => sum + bytes, 0);
    // The pragma figure is only useful as a gate because it bounds the payload.
    expect(trackedBytes).toBeGreaterThan(0);
    expect(liveBytes).toBeGreaterThanOrEqual(trackedBytes);
  });

  it("gates the disk budget without touching table rows", () => {
    const recorded = recordPreparedSql(database);
    const roomy = mayExceedSqliteSessionDiskBudget(database, maintenanceConfig());
    const tight = mayExceedSqliteSessionDiskBudget(
      database,
      maintenanceConfig({ maxDiskBytes: 1024, highWaterBytes: 512 }),
    );
    const disabled = mayExceedSqliteSessionDiskBudget(
      database,
      maintenanceConfig({ maxDiskBytes: null, highWaterBytes: null }),
    );
    recorded.restore();

    expect(roomy).toBe(false);
    expect(tight).toBe(true);
    expect(disabled).toBe(false);
    expect(recorded.statements.every((sql) => sql.startsWith("PRAGMA "))).toBe(true);
  });

  it("reports the same per-session bytes as the CAST-based scan it replaced", () => {
    expect(readSqliteSessionRowBytes(database)).toEqual(readLegacyRowBytes(database));
  });

  it("runs maintenance without a full-table byte scan when the database fits the budget", () => {
    const recorded = recordPreparedSql(database);
    const plan = applySqliteSessionEntryMaintenance(database, {
      activeSessionKey: "agent:main:byte-usage-1",
      archiveDirectory,
      forceMaintenance: true,
      maintenanceConfig: maintenanceConfig(),
    });
    recorded.restore();

    expect(recorded.statements.filter((sql) => BYTE_SCAN_SQL.test(sql))).toEqual([]);
    expect(plan.entryRemovals).toEqual([]);
  });

  it("still evicts oldest entries once the database exceeds the budget", () => {
    const plan = applySqliteSessionEntryMaintenance(database, {
      activeSessionKey: "agent:main:byte-usage-1",
      archiveDirectory,
      forceMaintenance: true,
      maintenanceConfig: maintenanceConfig({ maxDiskBytes: 1024, highWaterBytes: 512 }),
    });

    expect(plan.entryRemovals.map((removal) => removal.sessionKey).toSorted()).toEqual([
      "agent:main:byte-usage-2",
      "agent:main:byte-usage-3",
    ]);
  });
});
