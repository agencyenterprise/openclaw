import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import {
  admitThreadDispatch,
  resolveDispatchScope,
  dispatchHash,
  withLogicalReplyDispatch,
  admitDispatchChild,
  runLogicalDispatchAttempt,
  withHostReplyDispatch,
} from "../state/thread-dispatch.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";
vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([]),
  deliverOutboundPayloadsInternal: vi.fn().mockResolvedValue([]),
}));
const sql =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";
async function setup(busy: boolean, isolated = false) {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "whatsapp", isolatedSession: isolated },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const key = resolveMainSessionKey(cfg);
    await seedSessionStore(storePath, key, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: "+1555",
    });
    const databasePath = join(tmpDir, "dispatch.sqlite");
    const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
    db.exec(sql);
    chmodSync(databasePath, 0o600);
    const config = { databasePath, scopes: {}, sessionScopes: {}, automaticSessions: true };
    const scope = resolveDispatchScope(config, key)!;
    if (busy)
      admitThreadDispatch(config, {
        claimId: "native:existing",
        scopeKey: scope,
        epoch: 1,
        kind: "native",
        fingerprint: dispatchHash("existing"),
      });
    const file = join(tmpDir, "dispatch.json");
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", file);
    resetSystemEventsForTest();
    enqueueSystemEvent("pending synthetic result", { sessionKey: key });
    const before = peekSystemEventEntries(key);
    let sourceAbsent = false;
    replySpy.mockImplementation(async (ctx) => {
      sourceAbsent = !ctx.MessageSid;
      return withLogicalReplyDispatch({
        sessionKey: ctx.SessionKey,
        prompt: "fixture",
        run: async (observe) => {
          await runLogicalDispatchAttempt({
            sessionKey: ctx.SessionKey,
            run: async () => {
              const child = admitDispatchChild({
                kind: "process_child",
                identity: "fixture-child",
              });
              child?.();
              return undefined;
            },
          });
          observe(dispatchHash("actual fixture completed"));
          return { text: "HEARTBEAT_OK" };
        },
      });
    });
    try {
      const result = await runHeartbeatOnce({
        cfg,
        source: "exec-event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
      });
      const rows = db.prepare("SELECT kind,state FROM thread_dispatch_claims ORDER BY kind").all();
      if (busy) {
        expect(result.status).toBe("skipped");
        expect(replySpy).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(key)).toEqual(before);
        expect(rows).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ status: "ran" });
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(sourceAbsent).toBe(true);
        expect(rows).toEqual([
          { kind: "native", state: "TERMINAL" },
          { kind: "process_child", state: "UNKNOWN" },
        ]);
      }
    } finally {
      vi.unstubAllEnvs();
      resetSystemEventsForTest();
      db.close();
    }
  });
}
it("actual heartbeat refuses busy before reply and preserves original wake", () => setup(true));
it("actual main heartbeat joins private reply without fake channel source", () => setup(false));
it("actual isolated heartbeat binds same-scope private reply", () => setup(false, true));
