import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { resolveCronDispatchOrigin } from "./cron-dispatch-origin.js";
import { createCronExitWatchers } from "./cron-exit-watchers.js";
const jobId = "12345678-1234-4123-8123-123456789abc";
const selected = "agent:main:slack:channel:c123:thread:100.000001";
const scope = "slack/C123/100.000001";
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function job(target: CronJob["sessionTarget"], sessionKey?: string): CronJob {
  return {
    id: jobId,
    name: "fixture",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "on-exit", command: "exit 0" },
    sessionTarget: target,
    sessionKey,
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "fixture" },
    state: {},
  };
}
it("resolves saved source before main/isolated fallback and refuses unidentified current", () => {
  expect(resolveCronDispatchOrigin(job("main"), "worker", {})).toBe("agent:worker:main");
  expect(resolveCronDispatchOrigin(job("isolated"), "worker", {})).toBe(
    `agent:worker:cron:${jobId}`,
  );
  for (const target of ["main", "isolated", "current"] as const)
    expect(resolveCronDispatchOrigin(job(target, selected), "main", {})).toBe(selected);
  expect(
    resolveCronDispatchOrigin(job(`session:${selected}`, "agent:other:main"), "main", {}),
  ).toBe(selected);
  expect(() => resolveCronDispatchOrigin(job("current"), "main", {})).toThrow("ORIGIN_MISSING");
});
it.each(["main", "isolated"] as const)(
  "actual startup watcher %s runs with exact unrelated context",
  async (target) => {
    const dir = mkdtempSync(join(tmpdir(), "cron-context-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        databasePath: join(dir, "unused.sqlite"),
        scopes: { [scope]: 1 },
        sessionScopes: {},
        unscopedSessionKeys: ["agent:main:main"],
        unscopedCronSessionKeys: [`agent:main:cron:${jobId}`],
      }),
      { mode: 0o600 },
    );
    vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", config);
    const fire = vi.fn(),
      persist = vi.fn(),
      warn = vi.fn();
    const supervisor = createProcessSupervisor();
    const watcher = createCronExitWatchers({
      getProcessSupervisor: () => supervisor,
      resolveDispatchOrigin: (j) => resolveCronDispatchOrigin(j, "main", {}),
      persistCompletion: persist,
      fireOnExit: fire,
      logger: { info: vi.fn(), warn },
      shell: { command: "/bin/sh", argsFor: (c) => ["-c", c] },
    });
    try {
      watcher.reconcile([job(target)]);
      await vi.waitFor(() => expect(fire).toHaveBeenCalledOnce(), { timeout: 3000 });
      expect(persist).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      watcher.cancelAll();
    }
  },
);
it("selected watcher keeps a child claim, releases native before successor, and refuses replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-selected-"));
  dirs.push(dir);
  const databasePath = join(dir, "fence.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(SQL);
  chmodSync(databasePath, 0o600);
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
  const config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ databasePath, scopes: { [scope]: 1 }, sessionScopes: {} }),
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", config);
  const supervisor = createProcessSupervisor();
  const warn = vi.fn();
  const fire = vi.fn(() => {
    expect(
      db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
    ).toBe("TERMINAL");
    expect(
      db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='process_child'").get()
        ?.state,
    ).toBe("UNKNOWN");
  });
  const watcher = createCronExitWatchers({
    getProcessSupervisor: () => supervisor,
    resolveDispatchOrigin: (j) => resolveCronDispatchOrigin(j, "main", {}),
    persistCompletion: vi.fn(),
    fireOnExit: fire,
    logger: { info: vi.fn(), warn },
    shell: { command: "/bin/sh", argsFor: (c) => ["-c", c] },
  });
  try {
    const j = job("current", selected);
    watcher.reconcile([j]);
    await vi.waitFor(() => expect(fire).toHaveBeenCalledOnce(), { timeout: 3000 });
    watcher.cancelAll();
    watcher.reconcile([j]);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 3000 });
    expect(fire).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(2);
  } finally {
    watcher.cancelAll();
    db.close();
  }
});

const SQL =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";
