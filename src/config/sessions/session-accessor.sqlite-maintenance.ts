import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionDiskBudgetSweepResult } from "./disk-budget.js";
import {
  materializeSqliteSessionStateDeletePlans,
  type SqliteSessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import {
  mayExceedSqliteSessionDiskBudget,
  readSqliteSessionRowBytes,
} from "./session-accessor.sqlite-byte-usage.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import { enforceSqliteSessionDiskBudget } from "./session-accessor.sqlite-disk-budget.js";
import { readSqliteSessionEntryCount } from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionEntryRemovals } from "./session-accessor.sqlite-identity.js";
import {
  collectProjectedReferencedSqliteSessionIds,
  collectSqliteSessionStateIdsForEntry,
  deleteMaterializedSqliteSessionStatePlans,
  deletePlannedSqliteLifecycleArtifactEntries,
  planSqliteSessionStateDeleteIfUnreferenced,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type { SqliteSessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  forgetSettledSqliteSessionMaintenance,
  isSqliteSessionMaintenanceSettled,
  recordSettledSqliteSessionMaintenance,
} from "./session-accessor.sqlite-maintenance-settled.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import {
  collectSessionMaintenancePreserveKeys,
  collectSessionMaintenancePreserveKeysForStoreScopes,
} from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

// Entry pruning and disk-budget owner. Produces plans inside writes; finalizes archives afterward.

function emptySqliteSessionEntryMaintenancePlan(): SqliteSessionEntryMaintenancePlan {
  return { entryRemovals: [], promptReportOrphanSweep: false, stateDeletePlans: [] };
}

function collectSqliteSessionMaintenanceBaseKeys(
  store: Record<string, SessionEntry>,
  activeSessionKey: string,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  let currentKey = normalizeStoreSessionKey(activeSessionKey);
  while (currentKey && !seen.has(currentKey)) {
    seen.add(currentKey);
    keys.push(currentKey);
    currentKey = normalizeStoreSessionKey(store[currentKey]?.parentSessionKey ?? "");
  }
  return keys;
}

function enforceSqliteSessionDiskBudgetInStore(params: {
  database: OpenClawAgentDatabase;
  store: Record<string, SessionEntry>;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxDiskBytes" | "highWaterBytes">;
  preserveKeys?: ReadonlySet<string>;
  onRemoveEntry?: (removed: { key: string; entry: SessionEntry }) => void;
}): SessionDiskBudgetSweepResult | null {
  if (params.maintenance.maxDiskBytes == null || params.maintenance.highWaterBytes == null) {
    // Bail before readSqliteSessionRowBytes(): with the budget off,
    // enforceSqliteSessionDiskBudget() discards the row bytes anyway, and as an
    // eagerly evaluated argument they were being scanned for nothing.
    return null;
  }
  return enforceSqliteSessionDiskBudget({
    collectStateIds: collectSqliteSessionStateIdsForEntry,
    maintenance: params.maintenance,
    onRemoveEntry: params.onRemoveEntry,
    preserveKeys: params.preserveKeys,
    rowBytes: readSqliteSessionRowBytes(params.database),
    store: params.store,
  });
}

/**
 * Reports what a disk-budget sweep would evict, without mutating rows.
 *
 * Deliberately keeps the exact per-session byte pass: this is the operator-run
 * `sessions cleanup` preview, which must show real totals, and it never runs on
 * a session write or a maintenance tick.
 */
export function previewSqliteSessionDiskBudget(params: {
  agentId?: string;
  activeSessionKey?: string;
  store: Record<string, SessionEntry>;
  storePath: string;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxDiskBytes" | "highWaterBytes">;
  preserveKeys?: ReadonlySet<string>;
}): { diskBudget: SessionDiskBudgetSweepResult | null; removedKeys: Set<string> } {
  const removedKeys = new Set<string>();
  if (params.maintenance.maxDiskBytes == null || params.maintenance.highWaterBytes == null) {
    return { diskBudget: null, removedKeys };
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const baseKeys = collectSqliteSessionMaintenanceBaseKeys(
    params.store,
    params.activeSessionKey ?? "",
  );
  const preserveKeys =
    baseKeys.length > 0 || params.preserveKeys
      ? new Set([...(params.preserveKeys ?? []), ...baseKeys])
      : undefined;
  const diskBudget = enforceSqliteSessionDiskBudgetInStore({
    database,
    store: params.store,
    maintenance: params.maintenance,
    preserveKeys,
    onRemoveEntry: ({ key }) => {
      removedKeys.add(key);
    },
  });
  return { diskBudget, removedKeys };
}

// Index-only read of `idx_agent_session_entries_updated_at`; no entry JSON.
function readStaleSqliteSessionEntryKeys(
  database: OpenClawAgentDatabase,
  pruneAfterMs: number,
): string[] {
  const cutoffMs = Date.now() - pruneAfterMs;
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select("session_key")
      .where("updated_at", "<", cutoffMs)
      .orderBy("updated_at", "asc"),
  ).rows.map((row) => row.session_key);
}

/**
 * Matches the session store scopes whose work admissions own rows in one SQLite
 * database.
 *
 * Admissions are registered under the session store path their runtime resolved
 * (see the `beginSessionWorkAdmission` callers), and several store paths can
 * address one database file: every agent sharing an explicit `*.sqlite` store,
 * an explicit path a caller passed instead of the configured one, and a config
 * value that has since been reloaded. Maintenance therefore protects admissions
 * by the database file it is actually maintaining - the path the accessor
 * opened - instead of re-resolving one path from the current config and the
 * agent id guessed from the written key.
 */
function createSqliteMaintenanceStoreScopeMatcher(
  database: OpenClawAgentDatabase,
): (storeScope: string) => boolean {
  const maintainedPath = database.path;
  const decidedScopes = new Map<string, boolean>();
  return (storeScope: string): boolean => {
    const decided = decidedScopes.get(storeScope);
    if (decided !== undefined) {
      return decided;
    }
    // A custom store path only names its per-agent database once the agent id is
    // known, so an unqualified miss is retried against the maintained agent.
    const matches =
      resolveSqliteTargetFromSessionStorePath(storeScope).path === maintainedPath ||
      resolveSqliteTargetFromSessionStorePath(storeScope, { agentId: database.agentId }).path ===
        maintainedPath;
    decidedScopes.set(storeScope, matches);
    return matches;
  };
}

export function applySqliteSessionEntryMaintenance(
  database: OpenClawAgentDatabase,
  params: {
    activeSessionKey: string;
    archiveDirectory: string;
    forceMaintenance?: boolean;
    maintenanceConfig?: ResolvedSessionMaintenanceConfig;
    skipMaintenance?: boolean;
  },
): SqliteSessionEntryMaintenancePlan {
  if (params.skipMaintenance) {
    return emptySqliteSessionEntryMaintenancePlan();
  }
  const maintenance = params.maintenanceConfig ?? resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    forgetSettledSqliteSessionMaintenance(database);
    return emptySqliteSessionEntryMaintenancePlan();
  }

  const entryCount = readSqliteSessionEntryCount(database);
  const staleKeys = readStaleSqliteSessionEntryKeys(database, maintenance.pruneAfterMs);
  if (params.forceMaintenance === true) {
    forgetSettledSqliteSessionMaintenance(database);
  } else if (isSqliteSessionMaintenanceSettled(database, maintenance, { entryCount, staleKeys })) {
    return emptySqliteSessionEntryMaintenancePlan();
  }
  const preserveCandidateKeys = collectSessionMaintenancePreserveKeys([params.activeSessionKey]);
  const hasStaleCandidate = staleKeys.some(
    (key) => !preserveCandidateKeys?.has(normalizeStoreSessionKey(key)),
  );
  // O(1) header read, never a table scan: see mayExceedSqliteSessionDiskBudget().
  // A database whose live pages already fit the budget cannot hold session JSON
  // that does not, so the exact per-session byte pass below stays off this path.
  const mayExceedDiskBudget = mayExceedSqliteSessionDiskBudget(database, maintenance);
  const shouldLoadStore =
    params.forceMaintenance === true ||
    entryCount > maintenance.maxEntries ||
    hasStaleCandidate ||
    mayExceedDiskBudget ||
    shouldRunModelRunPrune({
      maintenance,
      entryCount,
      force: params.forceMaintenance,
    }) ||
    shouldRunSessionEntryMaintenance({
      entryCount,
      maxEntries: maintenance.maxEntries,
      force: params.forceMaintenance,
    });
  if (!shouldLoadStore) {
    return emptySqliteSessionEntryMaintenancePlan();
  }

  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }

  const removedKeys = new Set<string>();
  const removedEntriesByKey = new Map<string, SessionEntry>();
  const removedSessionIds = new Set<string>();
  const rememberRemovedEntry = (removed: { key: string; entry: SessionEntry }) => {
    removedKeys.add(removed.key);
    removedEntriesByKey.set(removed.key, cloneSessionEntry(removed.entry));
    for (const sessionId of collectSqliteSessionStateIdsForEntry(removed.entry)) {
      removedSessionIds.add(sessionId);
    }
  };
  // Rows owned by an in-flight turn are never eviction candidates, however far
  // over retention the store is: dropping one destroys live runtime state, and
  // a cron run continuation row that disappears mid-run can no longer be sealed.
  const preserveKeys =
    collectSessionMaintenancePreserveKeysForStoreScopes({
      baseKeys: collectSqliteSessionMaintenanceBaseKeys(store, params.activeSessionKey),
      matchesStoreScope: createSqliteMaintenanceStoreScopeMatcher(database),
      store,
    }) ?? new Set<string>();
  if (
    shouldRunModelRunPrune({
      maintenance,
      entryCount: Object.keys(store).length,
      force: params.forceMaintenance,
    })
  ) {
    pruneStaleModelRunEntries(store, maintenance.modelRunPruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
    });
  }
  if (
    params.forceMaintenance === true ||
    hasStaleCandidate ||
    Object.keys(store).length > maintenance.maxEntries
  ) {
    pruneStaleEntries(store, maintenance.pruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
    });
  }
  if (
    shouldRunSessionEntryMaintenance({
      entryCount: Object.keys(store).length,
      maxEntries: maintenance.maxEntries,
      force: params.forceMaintenance,
    })
  ) {
    capEntryCount(store, maintenance.maxEntries, {
      log: false,
      onCapped: rememberRemovedEntry,
      preserveKeys,
    });
  }
  const diskBudget = mayExceedDiskBudget
    ? enforceSqliteSessionDiskBudgetInStore({
        database,
        store,
        maintenance,
        preserveKeys,
        onRemoveEntry: rememberRemovedEntry,
      })
    : null;

  if (removedKeys.size === 0) {
    if (params.forceMaintenance !== true) {
      recordSettledSqliteSessionMaintenance(database, maintenance, {
        diskBudget,
        entryCount,
        staleKeys,
        store,
      });
    }
    return { entryRemovals: [], promptReportOrphanSweep: true, stateDeletePlans: [] };
  }

  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: removedKeys,
    projectedStore: store,
  });
  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: true,
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return {
    entryRemovals: [...removedKeys].map((sessionKey) => ({
      expectedEntry: removedEntriesByKey.get(sessionKey),
      sessionKey,
    })),
    promptReportOrphanSweep: true,
    stateDeletePlans: deletePlans,
  };
}

function deleteUnreferencedSessionPromptReportRows(database: OpenClawAgentDatabase): void {
  // kysely-allow-raw: report GC is a committed-state anti-join keyed by session_id;
  // session_key is historical metadata and must not decide liveness.
  database.db
    .prepare(
      `DELETE FROM session_prompt_reports
       WHERE NOT EXISTS (
         SELECT 1 FROM session_entries
         WHERE session_entries.session_id = session_prompt_reports.session_id
       )`,
    )
    .run();
}

export function finalizeSqliteSessionEntryMaintenancePlansBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SqliteSessionEntryMaintenancePlan[],
): SessionLifecycleArchivedTranscript[] {
  const entryRemovals = plans.flatMap((plan) => plan.entryRemovals);
  const stateDeletePlans = plans.flatMap((plan) => plan.stateDeletePlans);
  const shouldSweepPromptReportOrphans = plans.some((plan) => plan.promptReportOrphanSweep);
  if (
    entryRemovals.length === 0 &&
    stateDeletePlans.length === 0 &&
    !shouldSweepPromptReportOrphans
  ) {
    return [];
  }
  try {
    const materializedPlans = materializeSqliteSessionStateDeletePlans(stateDeletePlans);
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    runOpenClawAgentWriteTransaction((database) => {
      deletePlannedSqliteLifecycleArtifactEntries(database, entryRemovals);
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(database, materializedPlans);
    }, toDatabaseOptions(scope));
    if (shouldSweepPromptReportOrphans) {
      try {
        runOpenClawAgentWriteTransaction((database) => {
          deleteUnreferencedSessionPromptReportRows(database);
        }, toDatabaseOptions(scope));
      } catch (error) {
        getChildLogger({ subsystem: "session-sqlite" }).warn(
          "SQLite session prompt report cleanup failed",
          {
            agentId: scope.agentId,
            error,
            path: scope.path,
          },
        );
      }
    }
    emitCommittedSessionEntryRemovals(entryRemovals);
    return archivedTranscripts;
  } catch (error) {
    getChildLogger({ subsystem: "session-sqlite" }).warn(
      "SQLite session maintenance cleanup failed",
      {
        agentId: scope.agentId,
        error,
        path: scope.path,
        sessionIds: uniqueStrings(stateDeletePlans.map((plan) => plan.sessionId)),
      },
    );
    return [];
  }
}

// Revalidates transcript bytes before row deletion so a concurrent append is
// not dropped by an archive prepared from older content.
