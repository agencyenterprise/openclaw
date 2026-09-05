// An isolated cron run must still own its hidden run row when it seals.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadExactSessionEntry,
  patchSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { ResolvedSessionMaintenanceConfig } from "../../config/sessions/store-maintenance.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  createCronRunContinuationSession,
  createPersistCronSessionEntry,
  projectCronOwnershipFields,
  resolveCronLifecycleRevisionIdentity,
  type MutableCronSession,
} from "./run-session-state.js";

// Keep the resolved store path off any real openclaw.json on the machine.
vi.mock("../../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const AGENT_ID = "main";
const LIFECYCLE_REVISION = "lifecycle-revision-1";
const RUN_SESSION_ID = "cron-run-session-id";
const CRON_SESSION_KEY = "agent:main:cron:status-board";
const CRON_RUN_SESSION_KEY = `${CRON_SESSION_KEY}:run:${RUN_SESSION_ID}`;
// Same synthetic shape as the hidden run row, owned by nothing: the control
// that proves the maintenance pass under test really evicted on these writes.
const EVICTABLE_RUN_SESSION_KEY = "agent:main:cron:retired-job:run:retired-session";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Every seeded row predates the prune window and the store stays over
// maxEntries, so each session write runs a maintenance pass that treats every
// unprotected row as an eviction candidate.
const MAINTENANCE: ResolvedSessionMaintenanceConfig = {
  mode: "enforce",
  pruneAfterMs: ONE_YEAR_MS,
  maxEntries: 4,
  modelRunPruneAfterMs: ONE_YEAR_MS,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null,
  highWaterBytes: null,
};

describe("cron run continuation seal under session entry pressure", () => {
  let stateDir: string;
  let storePath: string;

  const persistCronSessionRow = async (params: {
    fallbackEntry: SessionEntry;
    sessionKey: string;
    storePath: string;
    update: (currentEntry: SessionEntry | undefined) => SessionEntry;
  }) => {
    await patchSessionEntry(
      { agentId: AGENT_ID, sessionKey: params.sessionKey, storePath: params.storePath },
      (_entry, context) => params.update(context.existingEntry),
      { fallbackEntry: params.fallbackEntry, replaceEntry: true, maintenanceConfig: MAINTENANCE },
    );
  };

  const seedRow = async (sessionKey: string, entry: SessionEntry) => {
    await patchSessionEntry({ agentId: AGENT_ID, sessionKey, storePath }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  };

  const readEntry = (sessionKey: string) =>
    loadExactSessionEntry({ agentId: AGENT_ID, sessionKey, storePath })?.entry;

  // Channel rows are protected by key shape, so they never leave; they exist to
  // drive the entry count past maxEntries. The evictable run row is the control.
  const seedPressureRows = async () => {
    for (let index = 0; index < 6; index += 1) {
      await seedRow(`agent:main:slack:channel:c-${index}`, {
        sessionId: `pressure-session-${index}`,
        updatedAt: 1_000 + index,
      });
    }
    await seedRow(EVICTABLE_RUN_SESSION_KEY, {
      sessionId: "retired-session",
      updatedAt: 1_500,
      cronRunContinuation: { lifecycleRevision: "retired-revision", phase: "running" },
    });
  };

  const seedStableCronRow = async () => {
    await seedRow(CRON_SESSION_KEY, {
      sessionId: RUN_SESSION_ID,
      lifecycleRevision: LIFECYCLE_REVISION,
      updatedAt: 2_000,
      systemSent: true,
    });
    const persisted = readEntry(CRON_SESSION_KEY);
    if (!persisted) {
      throw new Error("failed to seed the stable cron session row");
    }
    return persisted;
  };

  // Mirrors the ownership guard the run admission installs in run.ts: re-read
  // the stable row and reject the claim when its ownership fields moved.
  const assertCronSessionOwnership = (initialSessionEntry: SessionEntry | undefined) => () => {
    const currentEntry = readEntry(CRON_SESSION_KEY);
    const changed = initialSessionEntry
      ? !currentEntry ||
        !isDeepStrictEqual(
          projectCronOwnershipFields(currentEntry),
          projectCronOwnershipFields(initialSessionEntry),
        )
      : Boolean(currentEntry);
    if (changed) {
      throw new Error(`Session "${CRON_SESSION_KEY}" changed while starting work. Retry.`);
    }
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-seal-"));
    storePath = path.join(stateDir, "agents", AGENT_ID, "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("seals the run row after the stable cron row is persisted", async () => {
    await seedPressureRows();
    const initialSessionEntry = await seedStableCronRow();
    const cronSession = {
      storePath,
      store: { [CRON_SESSION_KEY]: structuredClone(initialSessionEntry) },
      initialSessionEntry: structuredClone(initialSessionEntry),
      sessionEntry: { ...structuredClone(initialSessionEntry), updatedAt: 2_500 },
      lifecycleRevision: LIFECYCLE_REVISION,
    } as unknown as MutableCronSession;
    const persistSessionEntry = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: CRON_SESSION_KEY,
      persistSessionEntry: persistCronSessionRow,
    });
    const continuation = createCronRunContinuationSession({
      cronSession,
      runSessionKey: CRON_RUN_SESSION_KEY,
      persistSessionEntry: persistCronSessionRow,
    });

    // The order runCronIsolatedAgentTurn uses: open the admission over the
    // whole run identity set, mark the stable row pre-run, create the hidden
    // run row, execute inside the admission, then finalize stable row first
    // and seal the run row, then take the guarded second seal.
    const lease = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [
        CRON_SESSION_KEY,
        cronSession.initialSessionEntry?.sessionId,
        cronSession.sessionEntry.sessionId,
        resolveCronLifecycleRevisionIdentity(cronSession.lifecycleRevision),
        CRON_RUN_SESSION_KEY,
      ],
      assertAllowed: assertCronSessionOwnership(initialSessionEntry),
    });

    try {
      await persistSessionEntry();
      await continuation.initialize();
      await lease.run(async () => {
        await continuation.sync();
      });
      await persistSessionEntry();
      await expect(continuation.seal({ basePersisted: true })).resolves.toBeUndefined();
      await expect(continuation.seal()).resolves.toBeUndefined();
    } finally {
      lease.release();
    }

    // Maintenance really did evict on these writes; the run row survived it.
    expect(readEntry(EVICTABLE_RUN_SESSION_KEY)).toBeUndefined();
    const sealed = readEntry(CRON_RUN_SESSION_KEY);
    expect(sealed).toBeDefined();
    expect(sealed?.cronRunContinuation).toMatchObject({
      lifecycleRevision: LIFECYCLE_REVISION,
      phase: "ready",
      basePersisted: true,
    });
  });

  it("keeps a run row admitted only through its backing session id", async () => {
    await seedPressureRows();
    const initialSessionEntry = await seedStableCronRow();
    await seedRow(CRON_RUN_SESSION_KEY, {
      sessionId: RUN_SESSION_ID,
      lifecycleRevision: LIFECYCLE_REVISION,
      updatedAt: 2_000,
      cronRunContinuation: { lifecycleRevision: LIFECYCLE_REVISION, phase: "running" },
    });

    // The delivery transcript mirror admits the stable key, the backing session
    // id and the lifecycle revision, and deliberately not the hidden run key.
    // The run row is protected only because entry.sessionId is admitted.
    const lease = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [
        CRON_SESSION_KEY,
        RUN_SESSION_ID,
        resolveCronLifecycleRevisionIdentity(LIFECYCLE_REVISION),
      ],
      assertAllowed: () => {
        const latest = readEntry(CRON_SESSION_KEY);
        if (
          latest?.sessionId !== RUN_SESSION_ID ||
          latest.lifecycleRevision !== LIFECYCLE_REVISION
        ) {
          throw new Error(`Session "${CRON_SESSION_KEY}" changed before transcript mirror.`);
        }
      },
    });

    try {
      await persistCronSessionRow({
        fallbackEntry: initialSessionEntry,
        sessionKey: CRON_SESSION_KEY,
        storePath,
        update: () => ({ ...initialSessionEntry, updatedAt: 3_000 }),
      });
    } finally {
      lease.release();
    }

    expect(readEntry(EVICTABLE_RUN_SESSION_KEY)).toBeUndefined();
    expect(readEntry(CRON_RUN_SESSION_KEY)?.cronRunContinuation).toMatchObject({
      lifecycleRevision: LIFECYCLE_REVISION,
      phase: "running",
    });
  });
});
