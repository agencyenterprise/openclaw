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

// The seeded rows predate the prune window and outnumber maxEntries, so every
// write runs a maintenance pass that treats each unprotected cron row as an
// eviction candidate.
const MAINTENANCE: ResolvedSessionMaintenanceConfig = {
  mode: "enforce",
  pruneAfterMs: ONE_YEAR_MS,
  maxEntries: 1,
  modelRunPruneAfterMs: ONE_YEAR_MS,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null,
  highWaterBytes: null,
};

describe("SQLite session maintenance active work", () => {
  let stateDir: string;
  let configuredStorePath: string;

  const writeEntry = async (params: {
    sessionKey: string;
    entry: SessionEntry;
    storePath: string;
    agentId?: string;
    runMaintenance?: boolean;
  }) =>
    await patchSessionEntry(
      {
        agentId: params.agentId ?? AGENT_ID,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      () => params.entry,
      {
        fallbackEntry: params.entry,
        replaceEntry: true,
        ...(params.runMaintenance === true
          ? { maintenanceConfig: MAINTENANCE }
          : { skipMaintenance: true }),
      },
    );

  const readEntry = (sessionKey: string, storePath: string) =>
    loadExactSessionEntry({ agentId: AGENT_ID, sessionKey, storePath })?.entry;

  const seedProtectedPressureRows = async (storePath: string) => {
    for (let index = 0; index < 6; index += 1) {
      await writeEntry({
        sessionKey: `agent:main:slack:channel:c-${index}`,
        entry: { sessionId: `protected-session-${index}`, updatedAt: 1_000 + index },
        storePath,
      });
    }
  };

  const seedCronRunRows = async (storePath: string) => {
    await writeEntry({
      sessionKey: CRON_SESSION_KEY,
      entry: { sessionId: RUN_SESSION_ID, updatedAt: 2_000 },
      storePath,
    });
    await writeEntry({
      sessionKey: CRON_RUN_SESSION_KEY,
      entry: {
        sessionId: RUN_SESSION_ID,
        updatedAt: 2_000,
        cronRunContinuation: { lifecycleRevision: "revision-1", phase: "running" },
      },
      storePath,
    });
  };

  const writeStableCronRowUnderPressure = async (storePath: string) =>
    await writeEntry({
      sessionKey: CRON_SESSION_KEY,
      entry: { sessionId: RUN_SESSION_ID, updatedAt: 3_000 },
      storePath,
      runMaintenance: true,
    });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-maintenance-active-work-"));
    configuredStorePath = path.join(stateDir, "agents", AGENT_ID, "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(configuredStorePath), { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("keeps an admitted cron run row while another key is written under entry pressure", async () => {
    await seedProtectedPressureRows(configuredStorePath);
    await seedCronRunRows(configuredStorePath);
    const lease = await beginSessionWorkAdmission({
      scope: configuredStorePath,
      identities: [CRON_SESSION_KEY, CRON_RUN_SESSION_KEY, RUN_SESSION_ID],
      assertAllowed: () => {},
    });

    try {
      await writeStableCronRowUnderPressure(configuredStorePath);
    } finally {
      lease.release();
    }

    expect(readEntry(CRON_RUN_SESSION_KEY, configuredStorePath)?.cronRunContinuation).toMatchObject({
      lifecycleRevision: "revision-1",
      phase: "running",
    });
  });

  it("evicts the same row once no turn owns it", async () => {
    await seedProtectedPressureRows(configuredStorePath);
    await seedCronRunRows(configuredStorePath);

    await writeStableCronRowUnderPressure(configuredStorePath);

    expect(readEntry(CRON_RUN_SESSION_KEY, configuredStorePath)).toBeUndefined();
    expect(readEntry(CRON_SESSION_KEY, configuredStorePath)).toBeDefined();
  });

  it("protects the store the write targets, not the store the config resolves to", async () => {
    // Callers pass an explicit store path (cron does), and it need not be the
    // path the current config resolves for the agent. Protection must follow the
    // database the accessor opened.
    const explicitStorePath = path.join(stateDir, "explicit-store", "sessions.sqlite");
    fs.mkdirSync(path.dirname(explicitStorePath), { recursive: true });
    await seedProtectedPressureRows(explicitStorePath);
    await seedCronRunRows(explicitStorePath);
    const lease = await beginSessionWorkAdmission({
      scope: explicitStorePath,
      identities: [CRON_SESSION_KEY, CRON_RUN_SESSION_KEY, RUN_SESSION_ID],
      assertAllowed: () => {},
    });

    try {
      await writeStableCronRowUnderPressure(explicitStorePath);
    } finally {
      lease.release();
    }

    expect(readEntry(CRON_RUN_SESSION_KEY, explicitStorePath)?.cronRunContinuation).toMatchObject({
      phase: "running",
    });
  });

  it("matches an admission scope that names the database instead of the session store", async () => {
    // The same database is addressed by more than one store path. Scopes are
    // compared by the database they resolve to, not by string equality.
    const databasePath = path.join(stateDir, "agents", AGENT_ID, "agent", "openclaw-agent.sqlite");
    await seedProtectedPressureRows(configuredStorePath);
    await seedCronRunRows(configuredStorePath);
    const lease = await beginSessionWorkAdmission({
      scope: databasePath,
      identities: [CRON_SESSION_KEY, CRON_RUN_SESSION_KEY, RUN_SESSION_ID],
      assertAllowed: () => {},
    });

    try {
      await writeStableCronRowUnderPressure(configuredStorePath);
    } finally {
      lease.release();
    }

    expect(readEntry(CRON_RUN_SESSION_KEY, configuredStorePath)?.cronRunContinuation).toMatchObject({
      phase: "running",
    });
  });

  it("cannot hold rows for a second agent, so one database has one owning agent", async () => {
    // The invariant behind matching admissions by database file: an agent
    // database refuses any agent but its own, so rows from several agents can
    // never share one file and be missed by a per-database preserve set.
    const sharedStorePath = path.join(stateDir, "shared-store", "sessions.sqlite");
    fs.mkdirSync(path.dirname(sharedStorePath), { recursive: true });
    await writeEntry({
      sessionKey: CRON_SESSION_KEY,
      entry: { sessionId: RUN_SESSION_ID, updatedAt: 2_000 },
      storePath: sharedStorePath,
    });

    await expect(
      writeEntry({
        agentId: "beta",
        sessionKey: "agent:beta:slack:channel:c-0",
        entry: { sessionId: "beta-session", updatedAt: 2_000 },
        storePath: sharedStorePath,
      }),
    ).rejects.toThrow(/agent main/);
  });
});
