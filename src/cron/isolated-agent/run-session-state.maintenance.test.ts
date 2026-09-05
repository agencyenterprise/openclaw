// An isolated cron run must still own its hidden run row when it seals.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Fewer allowed entries than protected rows: the removable budget is zero, so
// every unprotected row is an eviction candidate on each session write.
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

  const seedProtectedPressureRows = async () => {
    for (let index = 0; index < 6; index += 1) {
      const entry: SessionEntry = {
        sessionId: `protected-session-${index}`,
        updatedAt: 1_000 + index,
      };
      await patchSessionEntry(
        { agentId: AGENT_ID, sessionKey: `agent:main:slack:channel:c-${index}`, storePath },
        () => entry,
        { fallbackEntry: entry, replaceEntry: true, skipMaintenance: true },
      );
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
    const cronSession = {
      storePath,
      store: {},
      sessionEntry: {
        sessionId: RUN_SESSION_ID,
        lifecycleRevision: LIFECYCLE_REVISION,
        updatedAt: 2_000,
        systemSent: true,
      },
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

    await continuation.initialize();
    await seedProtectedPressureRows();
    const lease = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [CRON_SESSION_KEY, CRON_RUN_SESSION_KEY, RUN_SESSION_ID],
      assertAllowed: () => {},
    });

    try {
      // The order finalizeCronRun uses: stable row first, then seal the run row.
      await persistSessionEntry();
      await expect(continuation.seal({ basePersisted: true })).resolves.toBeUndefined();
    } finally {
      lease.release();
    }

    const sealed = loadExactSessionEntry({
      agentId: AGENT_ID,
      sessionKey: CRON_RUN_SESSION_KEY,
      storePath,
    })?.entry;
    expect(sealed?.cronRunContinuation).toMatchObject({
      lifecycleRevision: LIFECYCLE_REVISION,
      phase: "ready",
      basePersisted: true,
    });
  });
});
