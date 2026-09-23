// Settled maintenance: a write whose maintenance pass could remove nothing must
// not re-parse every entry or re-scan session bytes, while capping, pruning and
// the disk budget still fire as soon as they could remove something.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { readSqliteLiveDatabaseBytes } from "./session-accessor.sqlite-byte-usage.js";
import { deleteMaterializedSqliteSessionStatePlans } from "./session-accessor.sqlite-lifecycle-state.js";
import { SETTLED_SQLITE_SESSION_MAINTENANCE_RECHECK_MS } from "./session-accessor.sqlite-maintenance-settled.js";
import { applySqliteSessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

const ENTRY_JSON_READ_SQL = /^select\b[\s\S]*"entry_json"[\s\S]*from "session_entries"/i;
const BYTE_SCAN_SQL = /octet_length|length\s*\(\s*cast/i;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 8, 22, 12, 0, 0);
const ACTIVE_SESSION_KEY = "agent:main:slack:channel:c-0";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function maintenanceConfig(
  overrides: Partial<ResolvedSessionMaintenanceConfig> = {},
): ResolvedSessionMaintenanceConfig {
  return {
    mode: "enforce",
    pruneAfterMs: TEN_YEARS_MS,
    // Strict high water (3): the cap runs once three removable rows exist.
    maxEntries: 2,
    modelRunPruneAfterMs: TEN_YEARS_MS,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
    ...overrides,
  };
}

function seedEntry(
  database: OpenClawAgentDatabase,
  params: { sessionKey: string; sessionId: string; updatedAt: number; transcriptBytes?: number },
): void {
  database.db
    .prepare(
      `INSERT INTO sessions (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(params.sessionId, params.sessionKey, 1, params.updatedAt);
  database.db
    .prepare(
      `INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      params.sessionKey,
      params.sessionId,
      JSON.stringify({ sessionId: params.sessionId, updatedAt: params.updatedAt }),
      params.updatedAt,
    );
  if (params.transcriptBytes !== undefined) {
    database.db
      .prepare(
        `INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(
        params.sessionId,
        1,
        JSON.stringify({ text: "x".repeat(params.transcriptBytes) }),
        params.updatedAt,
      );
  }
}

/** Six protected channel rows keep the total entry count above every high-water mark. */
function seedProtectedRows(database: OpenClawAgentDatabase): void {
  for (let index = 0; index < 6; index += 1) {
    seedEntry(database, {
      sessionKey: `agent:main:slack:channel:c-${index}`,
      sessionId: `protected-session-${index}`,
      updatedAt: START_MS,
    });
  }
}

function seedCronRow(database: OpenClawAgentDatabase, index: number, updatedAt: number): string {
  const sessionKey = `agent:main:cron:job-${index}`;
  seedEntry(database, { sessionKey, sessionId: `cron-session-${index}`, updatedAt });
  return sessionKey;
}

/** Records every SQL string prepared against the database while `run` executes. */
function recordPreparedSql<T>(database: OpenClawAgentDatabase, run: () => T) {
  const statements: string[] = [];
  const prepare = database.db.prepare.bind(database.db);
  const spy = vi.spyOn(database.db, "prepare").mockImplementation((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  });
  try {
    return { result: run(), statements };
  } finally {
    spy.mockRestore();
  }
}

function entryJsonReads(statements: readonly string[]): string[] {
  return statements.filter((sql) => ENTRY_JSON_READ_SQL.test(sql));
}

describe("SQLite session maintenance settled verdict", () => {
  let database: OpenClawAgentDatabase;
  let archiveDirectory: string;
  let stateDir: string;

  const openDatabase = () =>
    openOpenClawAgentDatabase({
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });

  const runMaintenance = (
    overrides: Partial<ResolvedSessionMaintenanceConfig> = {},
    options: { forceMaintenance?: boolean } = {},
  ) =>
    recordPreparedSql(database, () =>
      applySqliteSessionEntryMaintenance(database, {
        activeSessionKey: ACTIVE_SESSION_KEY,
        archiveDirectory,
        maintenanceConfig: maintenanceConfig(overrides),
        ...options,
      }),
    );

  const removedKeys = (run: ReturnType<typeof runMaintenance>) =>
    run.result.entryRemovals.map((removal) => removal.sessionKey).toSorted();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START_MS);
    stateDir = tempDirs.make("openclaw-session-settled-maintenance-");
    archiveDirectory = tempDirs.make("openclaw-session-settled-archive-");
    database = openDatabase();
    seedProtectedRows(database);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("parses entries once per pass when nothing is removed", () => {
    seedCronRow(database, 1, START_MS);
    seedCronRow(database, 2, START_MS);

    const pass = runMaintenance();

    expect(removedKeys(pass)).toEqual([]);
    // The store load only: no post-removal reference scan when nothing was removed.
    expect(entryJsonReads(pass.statements)).toHaveLength(1);
  });

  it("does not reload the store on later writes once a pass removed nothing", () => {
    seedCronRow(database, 1, START_MS);
    seedCronRow(database, 2, START_MS);
    runMaintenance();

    vi.setSystemTime(START_MS + 1_000);
    const second = runMaintenance();
    const third = runMaintenance();

    expect(removedKeys(second)).toEqual([]);
    expect(entryJsonReads(second.statements)).toEqual([]);
    expect(entryJsonReads(third.statements)).toEqual([]);
  });

  it("caps again once removable rows reach the high-water mark", () => {
    seedCronRow(database, 1, START_MS);
    seedCronRow(database, 2, START_MS);
    runMaintenance();

    const oldest = seedCronRow(database, 3, START_MS - 1_000);

    expect(removedKeys(runMaintenance())).toEqual([oldest]);
  });

  it("caps as soon as removable rows exceed maxEntries once the total is past high water", () => {
    // Batched cap: maxEntries 50, high water 75. Protected rows push the total
    // past high water, so one removable row over maxEntries is already evicted.
    for (let index = 6; index < 26; index += 1) {
      seedEntry(database, {
        sessionKey: `agent:main:slack:channel:c-${index}`,
        sessionId: `protected-session-${index}`,
        updatedAt: START_MS,
      });
    }
    for (let index = 1; index <= 50; index += 1) {
      seedCronRow(database, index, START_MS);
    }
    expect(removedKeys(runMaintenance({ maxEntries: 50 }))).toEqual([]);

    const oldest = seedCronRow(database, 51, START_MS - 1_000);

    expect(removedKeys(runMaintenance({ maxEntries: 50 }))).toEqual([oldest]);
  });

  it("prunes a row that arrives already past the prune window", () => {
    const pruneAfterMs = 60_000;
    seedCronRow(database, 1, START_MS);
    runMaintenance({ pruneAfterMs });

    const backdated = seedCronRow(database, 2, START_MS - 2 * pruneAfterMs);

    expect(removedKeys(runMaintenance({ pruneAfterMs }))).toEqual([backdated]);
  });

  it("prunes once a removable row ages past the prune window, and not before", () => {
    const pruneAfterMs = 60_000;
    const cron = seedCronRow(database, 1, START_MS);
    runMaintenance({ pruneAfterMs });

    vi.setSystemTime(START_MS + pruneAfterMs - 1);
    const beforeExpiry = runMaintenance({ pruneAfterMs });
    vi.setSystemTime(START_MS + pruneAfterMs + 1);
    const afterExpiry = runMaintenance({ pruneAfterMs });

    expect(entryJsonReads(beforeExpiry.statements)).toEqual([]);
    expect(removedKeys(afterExpiry)).toEqual([cron]);
  });

  it("re-evaluates after the recheck interval even when no trigger moved", () => {
    seedCronRow(database, 1, START_MS);
    runMaintenance();

    vi.setSystemTime(START_MS + SETTLED_SQLITE_SESSION_MAINTENANCE_RECHECK_MS - 1);
    const beforeRecheck = runMaintenance();
    vi.setSystemTime(START_MS + SETTLED_SQLITE_SESSION_MAINTENANCE_RECHECK_MS);
    const atRecheck = runMaintenance();

    expect(entryJsonReads(beforeRecheck.statements)).toEqual([]);
    expect(entryJsonReads(atRecheck.statements).length).toBeGreaterThan(0);
  });

  it("re-evaluates when the maintenance config changes", () => {
    seedCronRow(database, 1, START_MS - 1_000);
    seedCronRow(database, 2, START_MS);
    runMaintenance();

    const tighter = runMaintenance({ maxEntries: 1 });

    expect(entryJsonReads(tighter.statements).length).toBeGreaterThan(0);
  });

  it("forgets the verdict when maintenance runs in warn mode", () => {
    seedCronRow(database, 1, START_MS);
    runMaintenance();

    runMaintenance({ mode: "warn" });
    const enforced = runMaintenance();

    expect(entryJsonReads(enforced.statements).length).toBeGreaterThan(0);
  });

  it("does not carry a verdict over to a reopened database", () => {
    seedCronRow(database, 1, START_MS);
    runMaintenance();

    closeOpenClawAgentDatabasesForTest();
    database = openDatabase();

    expect(entryJsonReads(runMaintenance().statements).length).toBeGreaterThan(0);
  });

  it("installs no verdict when the write transaction rolls back", () => {
    seedCronRow(database, 1, START_MS);

    expect(() =>
      runOpenClawAgentWriteTransaction(
        (writeDatabase) => {
          applySqliteSessionEntryMaintenance(writeDatabase, {
            activeSessionKey: ACTIVE_SESSION_KEY,
            archiveDirectory,
            maintenanceConfig: maintenanceConfig(),
          });
          throw new Error("write failed after maintenance");
        },
        { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
      ),
    ).toThrow("write failed after maintenance");

    expect(entryJsonReads(runMaintenance().statements).length).toBeGreaterThan(0);
  });

  it("installs the verdict once the write transaction commits", () => {
    seedCronRow(database, 1, START_MS);
    runOpenClawAgentWriteTransaction(
      (writeDatabase) => {
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: ACTIVE_SESSION_KEY,
          archiveDirectory,
          maintenanceConfig: maintenanceConfig(),
        });
      },
      { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
    );

    expect(entryJsonReads(runMaintenance().statements)).toEqual([]);
  });

  it("lets forced maintenance ignore a settled verdict", () => {
    seedCronRow(database, 1, START_MS);
    runMaintenance();

    const forced = runMaintenance({}, { forceMaintenance: true });

    expect(entryJsonReads(forced.statements).length).toBeGreaterThan(0);
  });

  describe("disk budget", () => {
    // Pages over the budget, session bytes far under it: the page gate alone
    // cannot rule out an overflow, so only the exact sweep can.
    const budgetBelowLivePages = () => {
      const maxDiskBytes = readSqliteLiveDatabaseBytes(database) - 1;
      return { maxDiskBytes, highWaterBytes: Math.floor(maxDiskBytes / 2), maxEntries: 1000 };
    };

    it("skips the exact byte scan once a sweep found session bytes within budget", () => {
      seedCronRow(database, 1, START_MS);
      const budget = budgetBelowLivePages();

      const first = runMaintenance(budget);
      const second = runMaintenance(budget);

      expect(first.statements.filter((sql) => BYTE_SCAN_SQL.test(sql)).length).toBeGreaterThan(0);
      expect(removedKeys(first)).toEqual([]);
      expect(second.statements.filter((sql) => BYTE_SCAN_SQL.test(sql))).toEqual([]);
      expect(entryJsonReads(second.statements)).toEqual([]);
    });

    it("still evicts once session bytes grow past the measured headroom", () => {
      seedCronRow(database, 1, START_MS);
      const budget = budgetBelowLivePages();
      runMaintenance(budget);

      seedEntry(database, {
        sessionKey: "agent:main:cron:job-large",
        sessionId: "cron-session-large",
        updatedAt: START_MS - 1_000,
        transcriptBytes: budget.maxDiskBytes,
      });

      expect(removedKeys(runMaintenance(budget))).toContain("agent:main:cron:job-large");
    });

    it("keeps watching session bytes after a sweep over budget only through orphan reports", () => {
      const cron = seedCronRow(database, 1, START_MS);
      const budget = budgetBelowLivePages();
      database.db
        .prepare(
          `INSERT INTO sessions (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        )
        .run("orphan-session", "agent:main:gone", 1, START_MS);
      database.db
        .prepare(
          `INSERT INTO session_prompt_reports (session_id, session_key, report_json, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          "orphan-session",
          "agent:main:gone",
          JSON.stringify({ text: "x".repeat(budget.maxDiskBytes) }),
          START_MS,
        );
      expect(removedKeys(runMaintenance(budget))).toEqual([]);

      // Grow an existing session, so the entry count cannot reopen the pass.
      database.db
        .prepare(
          `INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(
          "cron-session-1",
          1,
          JSON.stringify({ text: "x".repeat(budget.maxDiskBytes) }),
          START_MS,
        );

      expect(removedKeys(runMaintenance(budget))).toEqual([cron]);
    });
  });
});

describe("SQLite session state delete plans", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("reads no session entries when there is nothing to delete", () => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-empty-delete-plans-"),
      },
    });
    seedProtectedRows(database);

    const run = recordPreparedSql(database, () =>
      deleteMaterializedSqliteSessionStatePlans(database, []),
    );

    expect(run.result).toEqual([]);
    expect(run.statements).toEqual([]);
  });
});
