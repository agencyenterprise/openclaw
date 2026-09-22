// Regression: a turn queued behind another thread's turn on the shared global
// lane must run under its own dispatch owner, never a finished turn's closed one.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { setCommandLaneConcurrency } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const runEmbeddedAgentViaCliBackendIfEligible = vi.hoisted(() => vi.fn());
vi.mock("./cli-backend-dispatch.js", () => ({ runEmbeddedAgentViaCliBackendIfEligible }));

import { beginNativeCleanupAttempt } from "./native-cleanup-proof.js";
import { runEmbeddedAgent } from "./run.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

const fenceSql =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";

const tempRoot = mkdtempSync(join(tmpdir(), "lane-queue-owner-"));
const globalLane = "fence-queue-owner-test";
const threads = {
  a: { sessionKey: "agent:main:lane-owner-thread-a", scope: "slack/C123/1788816064.061969" },
  b: { sessionKey: "agent:main:lane-owner-thread-b", scope: "slack/C123/1788816065.061969" },
  c: { sessionKey: "agent:main:lane-owner-thread-c", scope: "slack/C123/1788816066.061969" },
  d: { sessionKey: "agent:main:lane-owner-thread-d", scope: "slack/C123/1788816067.061969" },
} as const;
type Thread = keyof typeof threads;

const completedResult = {
  payloads: [{ text: "done" }],
  meta: { durationMs: 1, stopReason: "stop", agentMeta: { usage: {} } },
} as unknown as EmbeddedAgentRunResult;

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));
beforeEach(() => {
  resetCommandQueueStateForTest();
  runEmbeddedAgentViaCliBackendIfEligible.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetCommandQueueStateForTest();
});

function prepareFence() {
  const root = mkdtempSync(join(tempRoot, "fence-"));
  const databasePath = join(root, "dispatch.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(fenceSql);
  chmodSync(databasePath, 0o600);
  for (const { scope } of Object.values(threads)) {
    db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
  }
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      databasePath,
      scopes: Object.fromEntries(Object.values(threads).map(({ scope }) => [scope, 1])),
      sessionScopes: Object.fromEntries(
        Object.values(threads).map(({ sessionKey, scope }) => [sessionKey, scope]),
      ),
    }),
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", configPath);
  const nativeClaimState = (runId: string) =>
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE claim_id=?").get(`native:${runId}`)
      ?.state;
  return { db, nativeClaimState };
}

function turn(thread: Thread, runId: string, extra: { abortSignal?: AbortSignal } = {}) {
  const { sessionKey } = threads[thread];
  return runEmbeddedAgent({
    sessionId: `${thread}-session`,
    sessionKey,
    agentId: "main",
    sessionTarget: {
      agentId: "main",
      sessionId: `${thread}-session`,
      sessionKey,
      storePath: join(tempRoot, "sessions.json"),
    },
    sessionFile: join(tempRoot, `${thread}.jsonl`),
    workspaceDir: join(tempRoot, "workspace"),
    prompt: `prompt ${runId}`,
    provider: "claude-cli",
    model: "claude-opus-4-8",
    timeoutMs: 5_000,
    runId,
    config: {},
    lane: globalLane,
    cliBackendDispatch: "subscription-auth" as const,
    ...extra,
  });
}

function blockTurnsUntilReleased() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async (params: { runId: string }) => {
    if (params.runId === "a-first") {
      await gate;
    }
    // Startup work before the attempt, as in production (model resolution etc.).
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    beginNativeCleanupAttempt()(true);
    return completedResult;
  });
  return release;
}

it("a turn dequeued by another thread's completion runs under its own open owner", async () => {
  const { db, nativeClaimState } = prepareFence();
  const release = blockTurnsUntilReleased();
  const first = turn("a", "a-first");
  const queued = turn("b", "b-queued");
  await vi.waitFor(() => expect(nativeClaimState("b-queued")).toBe("STARTING"));
  release();
  await expect(first).resolves.toBe(completedResult);
  await expect(queued).resolves.toBe(completedResult);
  expect(nativeClaimState("b-queued")).toBe("TERMINAL");
  await expect(turn("b", "b-next")).resolves.toBe(completedResult);
  expect(nativeClaimState("b-next")).toBe("TERMINAL");
  db.close();
});

it("a turn aborted while queued keeps its claim UNKNOWN (fence unchanged)", async () => {
  const { db, nativeClaimState } = prepareFence();
  const release = blockTurnsUntilReleased();
  const abort = new AbortController();
  const first = turn("a", "a-first");
  const queued = turn("b", "b-aborted", { abortSignal: abort.signal });
  await vi.waitFor(() => expect(nativeClaimState("b-aborted")).toBe("STARTING"));
  const queuedOutcome = expect(queued).rejects.toThrow("caller went away");
  abort.abort(new Error("caller went away"));
  release();
  await expect(first).resolves.toBe(completedResult);
  await queuedOutcome;
  expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(1);
  expect(nativeClaimState("b-aborted")).toBe("UNKNOWN");
  await expect(turn("b", "b-next")).rejects.toThrow("NATIVE_BUSY");
  db.close();
});

it("with all three global slots busy, the queued turn enters the real attempt under its own owner", async () => {
  const { db, nativeClaimState } = prepareFence();
  setCommandLaneConcurrency(globalLane, 3);
  let releaseActive!: () => void;
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const attemptErrors: string[] = [];
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async (params: { runId: string }) => {
    if (params.runId !== "d-queued") {
      await activeGate;
      return completedResult;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    // Real attempt entry (attempt.ts beginNativeCleanupAttempt) with unusable
    // params: it must fail on setup, never on a foreign closed owner.
    await runEmbeddedAttempt({} as never).catch((error: unknown) => {
      attemptErrors.push(String(error));
    });
    beginNativeCleanupAttempt()(true);
    return completedResult;
  });
  const active = [turn("a", "a-active"), turn("b", "b-active"), turn("c", "c-active")];
  await vi.waitFor(() => expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(3));
  const queued = turn("d", "d-queued");
  await vi.waitFor(() => expect(nativeClaimState("d-queued")).toBe("STARTING"));
  expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(3);
  releaseActive();
  await expect(Promise.all(active)).resolves.toHaveLength(3);
  await expect(queued).resolves.toBe(completedResult);
  expect(attemptErrors).toHaveLength(1);
  expect(attemptErrors[0]).not.toContain("NATIVE_CLEANUP_OWNER_CLOSED");
  expect(nativeClaimState("d-queued")).toBe("TERMINAL");
  await expect(turn("d", "d-next")).resolves.toBe(completedResult);
  db.close();
});

it("a turn that failed after effects began stays UNKNOWN and keeps its thread fenced", async () => {
  const { db, nativeClaimState } = prepareFence();
  runEmbeddedAgentViaCliBackendIfEligible.mockRejectedValueOnce(new Error("effect unverified"));
  await expect(turn("b", "b-failed")).rejects.toThrow("effect unverified");
  expect(nativeClaimState("b-failed")).toBe("UNKNOWN");
  await expect(turn("b", "b-next")).rejects.toThrow("NATIVE_BUSY");
  expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(1);
  db.close();
});
