// Session maintenance must never evict a row that an in-flight turn still owns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { loadExactSessionEntry, patchSessionEntry } from "./session-accessor.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

// Keep the resolved store path off any real openclaw.json on the machine.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const AGENT_ID = "main";
const RUN_SESSION_ID = "run-session-id";
const CRON_SESSION_KEY = "agent:main:cron:job-1";
const CRON_RUN_SESSION_KEY = `${CRON_SESSION_KEY}:run:${RUN_SESSION_ID}`;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// maxEntries below the number of protected rows leaves a removable budget of
// zero, which is what makes every unprotected row an eviction candidate.
const MAINTENANCE: ResolvedSessionMaintenanceConfig = {
  mode: "enforce",
  pruneAfterMs: ONE_YEAR_MS,
  maxEntries: 4,
  modelRunPruneAfterMs: ONE_YEAR_MS,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null,
  highWaterBytes: null,
};

describe("SQLite session maintenance active work", () => {
  let stateDir: string;
  let storePath: string;

  const writeEntry = async (
    sessionKey: string,
    entry: SessionEntry,
    options: { runMaintenance?: boolean } = {},
  ) =>
    await patchSessionEntry({ agentId: AGENT_ID, sessionKey, storePath }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      ...(options.runMaintenance === true
        ? { maintenanceConfig: MAINTENANCE }
        : { skipMaintenance: true }),
    });

  const readEntry = (sessionKey: string) =>
    loadExactSessionEntry({ agentId: AGENT_ID, sessionKey, storePath })?.entry;

  const seedProtectedPressureRows = async () => {
    for (let index = 0; index < 6; index += 1) {
      await writeEntry(`agent:main:slack:channel:c-${index}`, {
        sessionId: `protected-session-${index}`,
        updatedAt: 1_000 + index,
      });
    }
  };

  const seedCronRunRows = async () => {
    await writeEntry(CRON_SESSION_KEY, { sessionId: RUN_SESSION_ID, updatedAt: 2_000 });
    await writeEntry(CRON_RUN_SESSION_KEY, {
      sessionId: RUN_SESSION_ID,
      updatedAt: 2_000,
      cronRunContinuation: { lifecycleRevision: "revision-1", phase: "running" },
    });
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-maintenance-active-work-"));
    storePath = path.join(stateDir, "agents", AGENT_ID, "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("keeps an admitted cron run row while another key is written under entry pressure", async () => {
    await seedProtectedPressureRows();
    await seedCronRunRows();
    const lease = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [CRON_SESSION_KEY, CRON_RUN_SESSION_KEY, RUN_SESSION_ID],
      assertAllowed: () => {},
    });

    try {
      await writeEntry(
        CRON_SESSION_KEY,
        { sessionId: RUN_SESSION_ID, updatedAt: 3_000 },
        { runMaintenance: true },
      );
    } finally {
      lease.release();
    }

    expect(readEntry(CRON_RUN_SESSION_KEY)?.cronRunContinuation).toMatchObject({
      lifecycleRevision: "revision-1",
      phase: "running",
    });
  });

  it("evicts the same row once no turn owns it", async () => {
    await seedProtectedPressureRows();
    await seedCronRunRows();

    await writeEntry(
      CRON_SESSION_KEY,
      { sessionId: RUN_SESSION_ID, updatedAt: 3_000 },
      { runMaintenance: true },
    );

    expect(readEntry(CRON_RUN_SESSION_KEY)).toBeUndefined();
    expect(readEntry(CRON_SESSION_KEY)).toBeDefined();
  });
});
