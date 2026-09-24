import { execFileSync } from "node:child_process";
// Proves opted-in CLI-backend dispatch executes inside embedded lane
// admission: the dispatch decision and the CLI run must happen within the
// enqueued global-lane task, not before it, so dispatched runs obey the same
// lifecycle, placement, and concurrency gates as native embedded runs.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { CommandQueueEnqueueFn } from "../../process/command-queue.types.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const runEmbeddedAgentViaCliBackendIfEligible = vi.hoisted(() => vi.fn());
vi.mock("./cli-backend-dispatch.js", () => ({
  runEmbeddedAgentViaCliBackendIfEligible,
}));

import { runEmbeddedAgent } from "./run.js";

const tempRoot = mkdtempSync(join(tmpdir(), "cli-dispatch-lane-"));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const dispatchResult: EmbeddedAgentRunResult = {
  payloads: [{ text: "dispatched" }],
  meta: {
    durationMs: 1,
    stopReason: "stop",
    agentMeta: { usage: {} },
  },
} as unknown as EmbeddedAgentRunResult;

function laneRunParams() {
  return {
    sessionId: "recall-lane-session",
    sessionKey: "agent:main:recall-lane-test",
    agentId: "main",
    sessionTarget: {
      agentId: "main",
      sessionId: "recall-lane-session",
      sessionKey: "agent:main:recall-lane-test",
      storePath: join(tempRoot, "sessions.json"),
    },
    sessionFile: join(tempRoot, "session.jsonl"),
    workspaceDir: join(tempRoot, "workspace"),
    prompt: "recall prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
    timeoutMs: 5_000,
    runId: "run-cli-dispatch-lane-test",
    config: {},
    cliBackendDispatch: "subscription-auth" as const,
  };
}

describe("runEmbeddedAgent CLI dispatch lane admission", () => {
  beforeEach(() => {
    runEmbeddedAgentViaCliBackendIfEligible.mockReset();
  });

  it("resolves and executes CLI dispatch inside the global-lane task", async () => {
    const order: string[] = [];
    runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
      order.push("dispatch-run");
      return dispatchResult;
    });
    // The custom enqueue hook stands in for both the session and the global
    // lane, so a compliant run enters it twice before dispatching.
    const enqueue: CommandQueueEnqueueFn = async (task) => {
      order.push("global-lane-enter");
      const result = await task();
      order.push("global-lane-exit");
      return result;
    };

    const result = await runEmbeddedAgent({ ...laneRunParams(), enqueue });

    expect(result.payloads?.[0]?.text).toBe("dispatched");
    // Both lane admissions (session, then global) must fully wrap the
    // dispatch decision and execution.
    expect(order).toEqual([
      "global-lane-enter",
      "global-lane-enter",
      "dispatch-run",
      "global-lane-exit",
      "global-lane-exit",
    ]);
    expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(1);
  });
});

const fenceSql =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";
afterEach(() => vi.unstubAllEnvs());
function prepareFence(state = "OPEN") {
  const root = mkdtempSync(join(tempRoot, "fence-"));
  const databasePath = join(root, "dispatch.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(fenceSql);
  chmodSync(databasePath, 0o600);
  const scope = "slack/C123/1788816064.061969";
  db.prepare("INSERT INTO thread_fences VALUES (?,1,?,0)").run(scope, state);
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      databasePath,
      scopes: { [scope]: 1 },
      sessionScopes: { "agent:main:recall-lane-test": scope },
    }),
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", configPath);
  return { root, db };
}
describe("actual embedded runner durable admission", () => {
  it("drain refuses before CLI/model execution", async () => {
    const { db } = prepareFence("DRAINING");
    runEmbeddedAgentViaCliBackendIfEligible.mockClear();
    await expect(runEmbeddedAgent(laneRunParams())).rejects.toThrow("THREAD_DISPATCH_REFUSED");
    expect(runEmbeddedAgentViaCliBackendIfEligible).not.toHaveBeenCalled();
    db.close();
  });
  it("commits claim before actual local subprocess marker and refuses same run replay", async () => {
    const { root, db } = prepareFence();
    const marker = join(root, "marker");
    runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
      expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("STARTING");
      execFileSync(
        process.execPath,
        ["-e", "require('node:fs').writeFileSync(process.argv[1],'one')", marker],
        { timeout: 2000 },
      );
      return dispatchResult;
    });
    await runEmbeddedAgent(laneRunParams());
    expect(readFileSync(marker, "utf8")).toBe("one");
    expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("TERMINAL");
    await expect(runEmbeddedAgent(laneRunParams())).rejects.toThrow();
    db.close();
  });
  it("interrupted CLI result leaves UNKNOWN rather than native-terminal proof", async () => {
    const { db } = prepareFence();
    runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue({
      ...dispatchResult,
      meta: { durationMs: 1, aborted: true },
    });
    await runEmbeddedAgent(laneRunParams());
    expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("UNKNOWN");
    db.close();
  });
});

it("V2 real native entrypoint returns busy before second dispatch then admits after observed terminal", async () => {
  const { db } = prepareFence();
  let release!: () => void;
  let entered!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
    entered();
    await gate;
    return dispatchResult;
  });
  const first = runEmbeddedAgent(laneRunParams());
  await active;
  await expect(
    runEmbeddedAgent({ ...laneRunParams(), runId: "second-native" }),
  ).rejects.toMatchObject({ code: "NATIVE_BUSY" });
  release();
  await first;
  runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue(dispatchResult);
  await runEmbeddedAgent({ ...laneRunParams(), runId: "second-native" });
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM thread_dispatch_claims WHERE state='TERMINAL' AND kind='native'",
      )
      .get()?.n,
  ).toBe(2);
  db.close();
});

it("V3 keeps one logical owner across actual embedded fallback attempts with the same run ID", async () => {
  const { db } = prepareFence();
  const { withLogicalReplyDispatch, dispatchHash, admitDispatchChild } = await import("../../state/thread-dispatch.js");
  const { runWithModelFallback } = await import("../model-fallback.js");
  const { FailoverError } = await import("../failover-error.js");
  const { makeModelFallbackCfg } = await import("../test-helpers/model-fallback-config-fixture.js");
  const { beginNativeCleanupAttempt } = await import("./native-cleanup-proof.js");
  let calls = 0;
  let lateChild: (() => void) | undefined;
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
    calls++;
    expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims WHERE kind='native'").get()?.n).toBe(1);
    if (calls === 1) throw new FailoverError("fixture rate limited before effect", { reason: "rate_limit", provider: "openai", model: "gpt-4.1-mini" });
    // Stands in for the native embedded attempt, which verifies its own cleanup.
    beginNativeCleanupAttempt()(true);
    return dispatchResult;
  });
  try {
    await withLogicalReplyDispatch({
      sessionKey: laneRunParams().sessionKey,
      sourceTurnId: `channel-user:v1:${"a".repeat(64)}`,
      prompt: "same original instruction",
      run: async (complete) => {
        const { AsyncResource } = await import("node:async_hooks");
        lateChild = AsyncResource.bind(() => { admitDispatchChild({ late: true }); });
        const result = await runWithModelFallback({
          cfg: makeModelFallbackCfg(), provider: "openai", model: "gpt-4.1-mini",
          run: () => runEmbeddedAgent(laneRunParams()),
        });
        complete(dispatchHash("observed logical terminal"));
        return result;
      },
    });
    expect(calls).toBe(2);
    expect(db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state).toBe("TERMINAL");
    expect(() => lateChild?.()).toThrow("THREAD_DISPATCH_REFUSED");
  } finally { db.close(); }
});

it("V3 inherited native owner cannot bypass drain when host opt-in environment disappears", async () => {
  const { db } = prepareFence();
  const { withLogicalReplyDispatch } = await import("../../state/thread-dispatch.js");
  runEmbeddedAgentViaCliBackendIfEligible.mockClear();
  try {
    await expect(withLogicalReplyDispatch({
      sessionKey: laneRunParams().sessionKey,
      sourceTurnId: `channel-user:v1:${"d".repeat(64)}`,
      prompt: "original source",
      run: async () => {
        delete process.env.OPENCLAW_THREAD_DISPATCH_CONFIG;
        db.exec("UPDATE thread_fences SET state='DRAINING'");
        return runEmbeddedAgent(laneRunParams());
      },
    })).rejects.toThrow("THREAD_DISPATCH_REFUSED");
    expect(runEmbeddedAgentViaCliBackendIfEligible).not.toHaveBeenCalled();
    expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("UNKNOWN");
  } finally { db.close(); }
});
