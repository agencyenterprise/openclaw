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

import { admitDispatchChild } from "../../state/thread-dispatch.js";
import { resolveReplayInvalidFlag } from "./run/incomplete-turn.js";
it("actual runner terminalizes completed side-effect turn without permitting replay or clearing child", async () => {
 const { root, db } = prepareFence();
 const marker = join(root,"side-effect");
 const replayInvalid = resolveReplayInvalidFlag({attempt:{replayMetadata:{hadPotentialSideEffects:true,replaySafe:false}}});
 expect(replayInvalid).toBe(true);
 runEmbeddedAgentViaCliBackendIfEligible.mockClear();
 runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
  const finish = admitDispatchChild({fixture:"actual local marker"});
  execFileSync(process.execPath,["-e","require('node:fs').appendFileSync(process.argv[1],'once')",marker],{timeout:2000});
  finish?.();
  return {...dispatchResult,meta:{...dispatchResult.meta,replayInvalid}};
 });
 await runEmbeddedAgent(laneRunParams());
 expect(db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state).toBe("TERMINAL");
 expect(db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='process_child'").get()?.state).toBe("UNKNOWN");
 await expect(runEmbeddedAgent(laneRunParams())).rejects.toThrow();
 expect(readFileSync(marker,"utf8")).toBe("once");
 expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(1);
 runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue(dispatchResult);
 await runEmbeddedAgent({...laneRunParams(),runId:"successor-original-new-turn"});
 expect(db.prepare("SELECT count(*) n FROM thread_dispatch_claims WHERE kind='native' AND state='TERMINAL'").get()?.n).toBe(2);
 db.close();
});
it.each([
 {aborted:true,stopReason:"stop"},
 {error:{kind:"fixture",message:"failed"},stopReason:"stop"},
 {yielded:true,stopReason:"end_turn"},
 {pendingToolCalls:[{id:"fixture",name:"tool",arguments:"{}"}],stopReason:"stop"},
 {stopReason:"timeout"},
 {stopReason:"length"},
])("keeps interrupted or incomplete result UNKNOWN: %j",async (meta)=>{
 const { db }=prepareFence();
 runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue({...dispatchResult,meta:{durationMs:1,replayInvalid:true,...meta}});
 await runEmbeddedAgent(laneRunParams());
 expect(db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state).toBe("UNKNOWN");
 db.close();
});
