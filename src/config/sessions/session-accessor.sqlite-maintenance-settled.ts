// Settled-maintenance memo: remembers, per open SQLite database, that a full
// maintenance pass removed nothing, plus the cheap facts that must stay put for
// another pass to remove nothing too. Session writes consult it before loading
// and parsing every session entry.
//
// The pass triggers count rows and bytes maintenance may never delete:
// protected conversation rows count toward the entry high-water mark and the
// prune-window probe, and non-session tables count toward the database page
// bound of the disk budget. A store whose excess is all protected therefore
// kept every trigger true forever, and each session write re-ran the full entry
// parse plus the exact byte scans only to remove nothing: 0.6-0.8 s of blocked
// event loop per write on the production agent database (1803 entries against
// maxEntries 500, 1644 of them protected rows past the prune window, 2.9 GB of
// pages against a 2 GiB budget holding 1.9 GiB of session bytes).
//
// The memo is time-bounded, not a proof. What its triggers cannot observe waits
// for the recheck interval: a row losing static protection, rows leaving
// active-work preservation while the store is pinned over its disk budget,
// protected rows being deleted, and session bytes growing into free space
// inside pages the database already holds.
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { readSqliteLiveDatabaseBytes } from "./session-accessor.sqlite-byte-usage.js";
import {
  resolveSessionEntryMaintenanceHighWater,
  resolveSessionEntryPruneAtMs,
  shouldPreserveMaintenanceEntry,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

/** Longest a settled verdict is trusted while none of its triggers moves. */
export const SETTLED_SQLITE_SESSION_MAINTENANCE_RECHECK_MS = 5 * 60 * 1000;

type SettledSqliteSessionMaintenance = {
  configKey: string;
  settledAtMs: number;
  /** Earliest prune-window expiry among rows maintenance may remove. */
  pruneAtMs: number;
  /** Rows already past the prune window that static protection keeps. */
  protectedStaleKeys: ReadonlySet<string>;
  /** Entry count at which the cap would evict a removable row. */
  entryCountTrigger: number;
  /** Live database bytes beyond which session bytes may exceed the budget. */
  liveBytesTrigger: number;
};

type SettledMaintenanceConfig = Pick<
  ResolvedSessionMaintenanceConfig,
  | "highWaterBytes"
  | "maxDiskBytes"
  | "maxEntries"
  | "mode"
  | "modelRunPruneAfterMs"
  | "pruneAfterMs"
>;

/** What a write observes cheaply before deciding whether a full pass is needed. */
export type SqliteSessionMaintenanceObservation = {
  entryCount: number;
  /** Keys of rows whose `updated_at` is past the prune window, from the index. */
  staleKeys: readonly string[];
};

// Keyed by the open handle so a closed, replaced or restored database file
// never inherits a verdict, and a dropped handle frees its entry.
const settledByDatabase = new WeakMap<OpenClawAgentDatabase, SettledSqliteSessionMaintenance>();

function settledMaintenanceConfigKey(maintenance: SettledMaintenanceConfig): string {
  return JSON.stringify([
    maintenance.mode,
    maintenance.pruneAfterMs,
    maintenance.modelRunPruneAfterMs,
    maintenance.maxEntries,
    maintenance.maxDiskBytes,
    maintenance.highWaterBytes,
  ]);
}

function isStaticallyPreserved(key: string, entry: SessionEntry | undefined): boolean {
  // Unparseable rows never reach the in-memory store, so no step can remove them.
  return entry === undefined || shouldPreserveMaintenanceEntry({ key, entry });
}

/** Over budget after the sweep with nothing removed: every candidate is preserved. */
function isPinnedOverDiskBudget(diskBudget: SessionDiskBudgetSweepResult | null): boolean {
  return diskBudget?.overBudget === true && diskBudget.totalBytesAfter > diskBudget.highWaterBytes;
}

function resolveLiveBytesTrigger(
  database: OpenClawAgentDatabase,
  maintenance: SettledMaintenanceConfig,
  diskBudget: SessionDiskBudgetSweepResult | null,
): number {
  if (maintenance.maxDiskBytes == null || maintenance.highWaterBytes == null) {
    return Number.POSITIVE_INFINITY;
  }
  if (!diskBudget) {
    // The exact sweep did not run: the page bound itself stays the trigger.
    return maintenance.maxDiskBytes;
  }
  if (isPinnedOverDiskBudget(diskBudget)) {
    // Byte growth alone cannot make a preserved row removable; new rows trip
    // the entry trigger instead.
    return Number.POSITIVE_INFINITY;
  }
  // Over budget only through orphan prompt reports, the sweep already measured
  // without them (finalization deletes them).
  const measuredBytes = diskBudget.overBudget
    ? diskBudget.totalBytesAfter
    : diskBudget.totalBytesBefore;
  // Session bytes live inside the live pages, so they cannot pass the budget
  // before the pages grow by the measured headroom.
  return readSqliteLiveDatabaseBytes(database) + (maintenance.maxDiskBytes - measuredBytes);
}

/**
 * Records a non-forced pass that removed nothing, once its transaction commits:
 * a rolled-back write must not leave a verdict about state that never landed.
 *
 * Rows preserved only by active work count as removable here, so releasing one
 * makes the entry and prune triggers fire early, never late.
 */
export function recordSettledSqliteSessionMaintenance(
  database: OpenClawAgentDatabase,
  maintenance: SettledMaintenanceConfig,
  pass: SqliteSessionMaintenanceObservation & {
    diskBudget: SessionDiskBudgetSweepResult | null;
    store: Record<string, SessionEntry>;
  },
): void {
  let removableCount = 0;
  let pruneAtMs = Number.POSITIVE_INFINITY;
  for (const [key, entry] of Object.entries(pass.store)) {
    if (isStaticallyPreserved(key, entry)) {
      continue;
    }
    removableCount += 1;
    const entryPruneAtMs = resolveSessionEntryPruneAtMs({
      key,
      entry,
      pruneAfterMs: maintenance.pruneAfterMs,
      modelRunPruneAfterMs: maintenance.modelRunPruneAfterMs,
    });
    if (entryPruneAtMs !== undefined) {
      pruneAtMs = Math.min(pruneAtMs, entryPruneAtMs);
    }
  }
  // The cap runs once the total reaches high water and evicts once removable
  // rows exceed maxEntries; the protected count is held at this pass's value.
  const capEntryCountTrigger = Math.max(
    resolveSessionEntryMaintenanceHighWater(maintenance.maxEntries),
    pass.entryCount - removableCount + maintenance.maxEntries + 1,
  );
  const settled: SettledSqliteSessionMaintenance = {
    configKey: settledMaintenanceConfigKey(maintenance),
    settledAtMs: Date.now(),
    pruneAtMs,
    protectedStaleKeys: new Set(
      pass.staleKeys.filter((key) => isStaticallyPreserved(key, pass.store[key])),
    ),
    entryCountTrigger: isPinnedOverDiskBudget(pass.diskBudget)
      ? Math.min(capEntryCountTrigger, pass.entryCount + 1)
      : capEntryCountTrigger,
    liveBytesTrigger: resolveLiveBytesTrigger(database, maintenance, pass.diskBudget),
  };
  const install = () => {
    settledByDatabase.set(database, settled);
  };
  if (!deferOpenClawAgentPostCommitPublication(database, install)) {
    install();
  }
}

/** Drops the memo so the next write re-evaluates the store from scratch. */
export function forgetSettledSqliteSessionMaintenance(database: OpenClawAgentDatabase): void {
  settledByDatabase.delete(database);
}

/**
 * Whether the last settled pass still shows a new pass would remove nothing.
 * Costs a set lookup per stale key plus, with a disk budget, three header pragmas.
 */
export function isSqliteSessionMaintenanceSettled(
  database: OpenClawAgentDatabase,
  maintenance: SettledMaintenanceConfig,
  observed: SqliteSessionMaintenanceObservation,
): boolean {
  const settled = settledByDatabase.get(database);
  if (!settled) {
    return false;
  }
  const nowMs = Date.now();
  const stillSettled =
    settled.configKey === settledMaintenanceConfigKey(maintenance) &&
    nowMs >= settled.settledAtMs &&
    nowMs < settled.settledAtMs + SETTLED_SQLITE_SESSION_MAINTENANCE_RECHECK_MS &&
    nowMs < settled.pruneAtMs &&
    observed.entryCount < settled.entryCountTrigger &&
    observed.staleKeys.every((key) => settled.protectedStaleKeys.has(key)) &&
    (settled.liveBytesTrigger === Number.POSITIVE_INFINITY ||
      readSqliteLiveDatabaseBytes(database) <= settled.liveBytesTrigger);
  if (!stillSettled) {
    settledByDatabase.delete(database);
  }
  return stillSettled;
}
