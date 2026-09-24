// Regression for the 2026-09-23 thread lock: a Slack auto-reply turn ran tools, the model
// stopped with empty final text ("incomplete turn detected"), the turn returned normally,
// and its logical claim settled UNKNOWN, so every later turn in the thread got NATIVE_BUSY.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  NativeDispatchBusyError,
  withLogicalChannelDispatch,
} from "../../state/thread-dispatch.js";
import { beginNativeCleanupAttempt } from "./native-cleanup-proof.js";
import { createEmbeddedAttemptSessionSettleTracker } from "./run/attempt-session-settle.js";
import { cleanupEmbeddedAttemptResources } from "./run/attempt.subscription-cleanup.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const runEmbeddedAgentViaCliBackendIfEligible = vi.hoisted(() => vi.fn());
vi.mock("./cli-backend-dispatch.js", () => ({ runEmbeddedAgentViaCliBackendIfEligible }));
vi.mock("./run/attempt.abort-settle-timeout.js", () => ({
  resolveEmbeddedAbortSettleTimeoutMs: () => 30,
}));

import { runEmbeddedAgent } from "./run.js";

const tempRoot = mkdtempSync(join(tmpdir(), "logical-ended-receipt-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => runEmbeddedAgentViaCliBackendIfEligible.mockReset());

const SESSION_KEY = "agent:main:slack:channel:c090sgvrm7z:thread:1790184517.868569";
const SCOPE = "slack/C090SGVRM7Z/1790184517.868569";
const fenceSql =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";

function prepareFence() {
  const root = mkdtempSync(join(tempRoot, "fence-"));
  const databasePath = join(root, "dispatch.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(fenceSql);
  chmodSync(databasePath, 0o600);
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(SCOPE);
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ databasePath, scopes: { [SCOPE]: 1 }, sessionScopes: {} }),
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", configPath);
  return db;
}

function runParams(runId: string) {
  return {
    sessionId: "incident-session",
    sessionKey: SESSION_KEY,
    agentId: "main",
    sessionTarget: {
      agentId: "main",
      sessionId: "incident-session",
      sessionKey: SESSION_KEY,
      storePath: join(tempRoot, "sessions.json"),
    },
    sessionFile: join(tempRoot, "session.jsonl"),
    workspaceDir: join(tempRoot, "workspace"),
    prompt: "incident prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
    timeoutMs: 5_000,
    runId,
    config: {},
    cliBackendDispatch: "subscription-auth" as const,
  };
}

/** The result surfaceIncompleteTurn returns: an error payload and meta.error, no abort. */
function incompleteTurnResult(): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "⚠️ Agent couldn't generate a response. Please try again.", isError: true }],
    meta: {
      durationMs: 1,
      aborted: false,
      replayInvalid: true,
      livenessState: "abandoned",
      error: {
        kind: "incomplete_turn",
        message: "Agent couldn't generate a response.",
        fallbackSafe: false,
        terminalPresentation: false,
      },
    },
  } as EmbeddedAgentRunResult;
}

async function verifiedAttemptCleanup(): Promise<boolean> {
  const tracker = createEmbeddedAttemptSessionSettleTracker({ abort: async () => {} });
  void tracker.trackPromptSettlePromise(() => Promise.resolve());
  await tracker.abortActiveSession();
  const outcome = await cleanupEmbeddedAttemptResources({
    runId: "fixture",
    sessionId: "fixture",
    aborted: false,
    sealedSettlePromise: tracker.sealForCleanup(),
    session: { agent: { waitForIdle: () => Promise.resolve() }, dispose: () => {} },
    sessionManager: {},
    sessionLock: { release: async () => {} },
    flushPendingToolResultsAfterIdle: async () => {},
  });
  return outcome.verified;
}

/** A run that closes its (two) cleanup attempts with the given verification, then returns. */
function mockRun(options: {
  verified?: boolean;
  result?: EmbeddedAgentRunResult;
  sends?: () => void;
}) {
  runEmbeddedAgentViaCliBackendIfEligible.mockImplementationOnce(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const finish = beginNativeCleanupAttempt();
      finish(options.verified === false ? false : await verifiedAttemptCleanup());
    }
    options.sends?.();
    return options.result ?? incompleteTurnResult();
  });
}

function slackTurn(sourceChar: string, run: () => Promise<unknown>) {
  return withLogicalChannelDispatch({
    sessionKey: SESSION_KEY,
    sourceTurnId: `channel-user:v1:${sourceChar.repeat(64)}`,
    prompt: `turn ${sourceChar}`,
    run: async () => {
      await run();
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  });
}

const logicalStates = (db: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>) =>
  db
    .prepare(
      "SELECT state FROM thread_dispatch_claims WHERE claim_id LIKE 'logical:%' ORDER BY rowid",
    )
    .all()
    .map((row) => row.state);

async function expectNextTurnAdmitted(db: ReturnType<typeof prepareFence>) {
  mockRun({
    result: {
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1, stopReason: "stop" },
    } as EmbeddedAgentRunResult,
  });
  await slackTurn("b", () => runEmbeddedAgent(runParams("next-turn")));
  expect(logicalStates(db)).toEqual(["TERMINAL", "TERMINAL"]);
}

it("incident: empty final text after tools settles TERMINAL; the next turn in the thread is admitted", async () => {
  const db = prepareFence();
  try {
    mockRun({});
    await slackTurn("a", () => runEmbeddedAgent(runParams("incident-run")));
    expect(logicalStates(db)).toEqual(["TERMINAL"]);
    await expectNextTurnAdmitted(db);
  } finally {
    db.close();
  }
});

it("waits for the turn's in-flight deliveries, then settles TERMINAL once all completed", async () => {
  const db = prepareFence();
  let release!: () => void;
  const slackAck = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: string[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      await slackAck;
      delivered.push(payload.text ?? "");
    },
  });
  try {
    mockRun({ sends: () => void dispatcher.sendToolResult({ text: "tool progress" }) });
    const turn = slackTurn("a", async () => {
      await runEmbeddedAgent(runParams("delivering-run"));
      dispatcher.sendFinalReply({ text: "error notice" });
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(logicalStates(db)).toEqual(["STARTING"]);
    release();
    await turn;
    expect(delivered).toEqual(["tool progress", "error notice"]);
    expect(logicalStates(db)).toEqual(["TERMINAL"]);
  } finally {
    db.close();
  }
});

it("a started delivery whose response was lost keeps the claim UNKNOWN", async () => {
  const db = prepareFence();
  const dispatcher = createReplyDispatcher({
    deliver: async () => {
      throw new Error("socket hang up after request written");
    },
  });
  try {
    mockRun({ sends: () => void dispatcher.sendToolResult({ text: "tool progress" }) });
    await slackTurn("a", () => runEmbeddedAgent(runParams("lost-response-run")));
    expect(logicalStates(db)).toEqual(["UNKNOWN"]);
    mockRun({});
    await expect(
      slackTurn("b", () => runEmbeddedAgent(runParams("blocked"))),
    ).rejects.toBeInstanceOf(NativeDispatchBusyError);
  } finally {
    db.close();
  }
});

it("a delivery cancelled before sending is a known outcome and settles TERMINAL", async () => {
  const db = prepareFence();
  const deliver = vi.fn(async () => {});
  const dispatcher = createReplyDispatcher({ deliver, beforeDeliver: () => null });
  try {
    mockRun({ sends: () => void dispatcher.sendFinalReply({ text: "suppressed" }) });
    await slackTurn("a", () => runEmbeddedAgent(runParams("cancelled-run")));
    expect(deliver).not.toHaveBeenCalled();
    expect(logicalStates(db)).toEqual(["TERMINAL"]);
  } finally {
    db.close();
  }
});

it("unverified native cleanup keeps the claim UNKNOWN", async () => {
  const db = prepareFence();
  try {
    mockRun({ verified: false });
    await slackTurn("a", () => runEmbeddedAgent(runParams("unverified-run")));
    expect(logicalStates(db)).toEqual(["UNKNOWN"]);
  } finally {
    db.close();
  }
});

it.each([
  { aborted: true },
  { stopReason: "timeout" },
  { stopReason: "restart" },
  { timeoutPhase: "tool" },
  { yielded: true },
  { pendingToolCalls: [{ id: "call", name: "tool", arguments: "{}" }] },
])("an interrupted or handed-off run keeps the claim UNKNOWN: %j", async (meta) => {
  const db = prepareFence();
  try {
    const base = incompleteTurnResult();
    mockRun({ result: { ...base, meta: { ...base.meta, ...meta } } as EmbeddedAgentRunResult });
    await slackTurn("a", () => runEmbeddedAgent(runParams("interrupted-run")));
    expect(logicalStates(db)).toEqual(["UNKNOWN"]);
  } finally {
    db.close();
  }
});

it("a run that threw, even if the caller swallowed it, keeps the claim UNKNOWN", async () => {
  const db = prepareFence();
  try {
    runEmbeddedAgentViaCliBackendIfEligible.mockImplementationOnce(async () => {
      beginNativeCleanupAttempt()(await verifiedAttemptCleanup());
      throw new Error("provider crashed");
    });
    await slackTurn("a", () => runEmbeddedAgent(runParams("crashed-run")).catch(() => undefined));
    expect(logicalStates(db)).toEqual(["UNKNOWN"]);
  } finally {
    db.close();
  }
});

it("a turn that ran no native attempt has no ended-run proof and stays UNKNOWN", async () => {
  const db = prepareFence();
  try {
    await slackTurn("a", async () => {});
    expect(logicalStates(db)).toEqual(["UNKNOWN"]);
  } finally {
    db.close();
  }
});
