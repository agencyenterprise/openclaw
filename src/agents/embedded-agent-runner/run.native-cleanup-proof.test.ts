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

const fenceSql =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => runEmbeddedAgentViaCliBackendIfEligible.mockReset());
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

import {
  admitDispatchChild,
  withCronDispatchOwner,
  bindCronDispatchSession,
} from "../../state/thread-dispatch.js";
import {
  beginNativeCleanupAttempt,
  withNativeCleanupTracking,
  readNativeFailedCleanupReceipt,
} from "./native-cleanup-proof.js";
import { createEmbeddedAttemptSessionSettleTracker } from "./run/attempt-session-settle.js";
import { cleanupEmbeddedAttemptResources } from "./run/attempt.subscription-cleanup.js";
vi.mock("./run/attempt.abort-settle-timeout.js", () => ({
  resolveEmbeddedAbortSettleTimeoutMs: () => 30,
}));
const failedResult = () => ({
  ...dispatchResult,
  meta: { durationMs: 1, aborted: true, stopReason: "timeout", replayInvalid: true },
});
async function cleanupFixture(
  options: {
    pending?: boolean;
    idlePending?: boolean;
    disposeFailure?: boolean;
    forged?: boolean;
  } = {},
) {
  const tracker = createEmbeddedAttemptSessionSettleTracker({ abort: async () => {} });
  const prompt = options.pending ? new Promise<void>(() => {}) : Promise.resolve();
  void tracker.trackPromptSettlePromise(() => prompt);
  await tracker.abortActiveSession();
  return cleanupEmbeddedAttemptResources({
    runId: "fixture",
    sessionId: "fixture",
    aborted: true,
    sealedSettlePromise: options.forged ? Promise.resolve() : tracker.sealForCleanup(),
    session: {
      agent: {
        waitForIdle: () => (options.idlePending ? new Promise<void>(() => {}) : Promise.resolve()),
      },
      dispose: () => {
        if (options.disposeFailure) throw new Error("fixture disposal failed");
      },
    },
    sessionManager: {},
    sessionLock: { release: async () => {} },
    flushPendingToolResultsAfterIdle: async () => {},
  });
}
it("verified timeout terminalizes failed native only, rejects late child and old replay, admits new source", async () => {
  const { db } = prepareFence();
  let late!: () => Promise<void>;
  runEmbeddedAgentViaCliBackendIfEligible.mockClear();
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
    const finish = beginNativeCleanupAttempt();
    admitDispatchChild({ fixture: "external effect remains separately unresolved" })?.();
    const outcome = await cleanupFixture();
    expect(outcome.verified).toBe(true);
    finish(outcome.verified);
    // Capture inherited ALS via a real async continuation that is released after completion.
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = deferred.then(() =>
      expect(() => admitDispatchChild({ fixture: "late" })).toThrow(),
    );
    late = () => {
      release();
      return task;
    };
    return failedResult();
  });
  const result = await runEmbeddedAgent(laneRunParams());
  expect(result.meta.aborted).toBe(true);
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
  ).toBe("TERMINAL");
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='process_child'").get()?.state,
  ).toBe("UNKNOWN");
  await late();
  await expect(runEmbeddedAgent(laneRunParams())).rejects.toThrow();
  runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue(dispatchResult);
  await runEmbeddedAgent({ ...laneRunParams(), runId: "new-independent-source" });
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM thread_dispatch_claims WHERE kind='native' AND state='TERMINAL'",
      )
      .get()?.n,
  ).toBe(2);
  db.close();
});
it.each([{ pending: true }, { idlePending: true }, { disposeFailure: true }, { forged: true }])(
  "unverified cleanup remains UNKNOWN %j",
  async (options) => {
    const { db } = prepareFence();
    runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
      const finish = beginNativeCleanupAttempt();
      const outcome = await cleanupFixture(options);
      expect(outcome.verified).toBe(false);
      finish(outcome.verified);
      return failedResult();
    });
    await runEmbeddedAgent(laneRunParams());
    expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("UNKNOWN");
    db.close();
  },
);
it("forged public cleanup fields do not mint private proof", async () => {
  const { db } = prepareFence();
  runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue({
    ...failedResult(),
    cleanupVerified: true,
    meta: { ...failedResult().meta, cleanupVerified: true, terminalReceipt: "a".repeat(64) },
  });
  await runEmbeddedAgent(laneRunParams());
  expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("UNKNOWN");
  db.close();
});
it("sealed tracker refuses late prompt factory before effect", async () => {
  let effects = 0;
  const tracker = createEmbeddedAttemptSessionSettleTracker({
    abort: async () => {
      effects++;
    },
  });
  await tracker.sealForCleanup();
  expect(() =>
    tracker.trackPromptSettlePromise(() => {
      effects++;
      return Promise.resolve();
    }),
  ).toThrow(/CLOSED/);
  await tracker.abortActiveSession();
  expect(effects).toBe(0);
});
it("private proof rejects wrong run/generation identity and cloned result", async () => {
  const result = await withNativeCleanupTracking("identity-A", async () => {
    const finish = beginNativeCleanupAttempt();
    finish((await cleanupFixture()).verified);
    return failedResult();
  });
  expect(readNativeFailedCleanupReceipt(result, "identity-A")).toMatch(/^[a-f0-9]{64}$/);
  expect(readNativeFailedCleanupReceipt(result, "identity-B")).toBeUndefined();
  expect(readNativeFailedCleanupReceipt({ ...result }, "identity-A")).toBeUndefined();
});
it("all attempts must settle; a later good attempt cannot hide an unresolved one", async () => {
  const result = await withNativeCleanupTracking("identity-A", async () => {
    beginNativeCleanupAttempt()(false);
    beginNativeCleanupAttempt()(true);
    return failedResult();
  });
  expect(readNativeFailedCleanupReceipt(result, "identity-A")).toBeUndefined();
});
it("actual common runner carries verified failed cleanup through outer isolated cron status error", async () => {
  const { db } = prepareFence();
  const p = laneRunParams();
  const key =
    "agent:main:cron:11111111-1111-4111-8111-111111111111:run:22222222-2222-4222-8222-222222222222";
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
    const finish = beginNativeCleanupAttempt();
    admitDispatchChild({ fixture: "child" })?.();
    finish((await cleanupFixture()).verified);
    return failedResult();
  });
  await withCronDispatchOwner({
    sessionKey: p.sessionKey,
    operationId: "isolated-cron:fixture:1",
    identity: { fixture: "cron" },
    completed: () => false,
    run: async () => {
      bindCronDispatchSession(key);
      await runEmbeddedAgent({
        ...p,
        sessionKey: key,
        sessionTarget: { ...p.sessionTarget, sessionKey: key },
      });
      return { status: "error" };
    },
  });
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
  ).toBe("TERMINAL");
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='process_child'").get()?.state,
  ).toBe("UNKNOWN");
  db.close();
});

it("swallowed resource cleanup failure invalidates otherwise settled proof", async () => {
  const { invalidateNativeCleanupTracking } = await import("./native-cleanup-proof.js");
  const result = await withNativeCleanupTracking("invalidated", async () => {
    const finish = beginNativeCleanupAttempt();
    finish(true);
    invalidateNativeCleanupTracking();
    return { meta: { aborted: true } };
  });
  expect(readNativeFailedCleanupReceipt(result, "invalidated")).toBeUndefined();
});

it("actual cron timer timeout returns first, then verified late cleanup releases only failed owner", async () => {
  const { createCronServiceState } = await import("../../cron/service/state.js");
  const { executeJobCoreWithTimeout } = await import("../../cron/service/timer.js");
  const { root, db } = prepareFence();
  const p = laneRunParams();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ownerDone!: Promise<unknown>;
  let aborted: AbortSignal | undefined;
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementationOnce(async () => {
    const finish = beginNativeCleanupAttempt();
    admitDispatchChild({ fixture: "outer-timeout-child" })?.();
    await pending;
    finish((await cleanupFixture()).verified);
    return failedResult();
  });
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: join(root, "cron.json"),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    nowMs: Date.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    cleanupTimedOutAgentRun: async () => {},
    runIsolatedAgentJob: async ({ abortSignal, onExecutionStarted }) => {
      aborted = abortSignal;
      const task = withCronDispatchOwner({
        sessionKey: p.sessionKey,
        operationId: "isolated-cron:outer:1",
        identity: { fixture: "outer" },
        completed: () => false,
        run: async () => {
          bindCronDispatchSession("agent:main:cron:outer:run:one");
          onExecutionStarted?.();
          await runEmbeddedAgent({ ...p, sessionKey: "agent:main:cron:outer:run:one" });
          return { status: "error" as const, error: "timeout" };
        },
      });
      ownerDone = task;
      return task;
    },
  });
  const now = Date.now();
  const result = await executeJobCoreWithTimeout(state, {
    id: "outer",
    name: "outer",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "fixture", timeoutSeconds: 1 },
    delivery: { mode: "none" },
    state: { runningAtMs: now },
  });
  expect(result.status).toBe("error");
  expect(aborted?.reason).toMatchObject({ name: "TimeoutError" });
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
  ).not.toBe("TERMINAL");
  release();
  await ownerDone;
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
  ).toBe("TERMINAL");
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind!='native'").get()?.state,
  ).toBe("UNKNOWN");
  db.close();
});

it("actual runner preserves thrown error and accepts only private fully settled failure", async () => {
  const { db } = prepareFence();
  const original = new Error("fixture timeout");
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementationOnce(async () => {
    const finish = beginNativeCleanupAttempt();
    finish((await cleanupFixture()).verified);
    throw original;
  });
  await expect(runEmbeddedAgent(laneRunParams())).rejects.toBe(original);
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
  ).toBe("TERMINAL");
  db.close();
});

it("default-off runner does not activate cleanup tracking", async () => {
  vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", undefined);
  const { hasNativeCleanupTracking } = await import("./native-cleanup-proof.js");
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementationOnce(async () => {
    expect(hasNativeCleanupTracking()).toBe(false);
    return dispatchResult;
  });
  await runEmbeddedAgent(laneRunParams());
});

it("pending subscription callback chain cannot mint cleanup proof", async () => {
  const { trackNativeCleanupDependency } = await import("./native-cleanup-proof.js");
  const result = await withNativeCleanupTracking("pending-events", async () => {
    const finish = beginNativeCleanupAttempt();
    finish(true);
    trackNativeCleanupDependency(new Promise(() => {}));
    return failedResult();
  });
  expect(readNativeFailedCleanupReceipt(result, "pending-events")).toBeUndefined();
});

it("reused result cannot inherit a previous verified invocation stamp", async () => {
  const same = failedResult();
  for (const verified of [true, false]) {
    await withNativeCleanupTracking("same-result", async () => {
      beginNativeCleanupAttempt()(verified);
      return same;
    });
    expect(Boolean(readNativeFailedCleanupReceipt(same, "same-result"))).toBe(verified);
  }
});
it("reused Error cannot inherit a previous verified invocation stamp", async () => {
  const { readNativeThrownCleanupReceipt } = await import("./native-cleanup-proof.js");
  const same = new Error("reused error");
  for (const verified of [true, false]) {
    await expect(
      withNativeCleanupTracking("same-error", async () => {
        beginNativeCleanupAttempt()(verified);
        throw same;
      }),
    ).rejects.toBe(same);
    expect(Boolean(readNativeThrownCleanupReceipt(same, "same-error"))).toBe(verified);
  }
});

it("overlapping cleanup identity refuses before second callback", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withNativeCleanupTracking("overlap", async () => {
    const finish = beginNativeCleanupAttempt();
    await pending;
    finish(true);
    return failedResult();
  });
  const second = vi.fn(async () => failedResult());
  await expect(withNativeCleanupTracking("overlap", second)).rejects.toThrow(
    "NATIVE_CLEANUP_IDENTITY_ACTIVE",
  );
  expect(second).not.toHaveBeenCalled();
  const distinct = vi.fn(async () => failedResult());
  await withNativeCleanupTracking("distinct-identity", distinct);
  expect(distinct).toHaveBeenCalledOnce();
  release();
  await first;
});
