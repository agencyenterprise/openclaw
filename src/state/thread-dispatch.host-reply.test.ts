import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi, afterEach } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  withHostReplyDispatch,
  withLogicalReplyDispatch,
  withLogicalChannelDispatch,
  runLogicalDispatchAttempt,
  dispatchHash,
} from "./thread-dispatch.js";
const sql =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "host-owner-"));
  roots.push(root);
  const databasePath = join(root, "dispatch.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(sql);
  chmodSync(databasePath, 0o600);
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ databasePath, scopes: {}, sessionScopes: {}, automaticSessions: true }),
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", config);
  return db;
}
const key = "agent:main:main";
it("host dispatch rejects session mismatch and late continuation", async () => {
  const db = setup();
  let late: (() => Promise<unknown>) | undefined;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let pending: Promise<unknown> | undefined;
  await withHostReplyDispatch({
    sessionKey: key,
    operationId: "heartbeat:1",
    identity: { host: true },
    timeoutMs: 1000,
    run: async () => {
      expect(() =>
        withLogicalChannelDispatch({
          sessionKey: "agent:main:other",
          prompt: "x",
          run: async () => 0,
        }),
      ).toThrow("THREAD_DISPATCH_REFUSED");
      pending = gate.then(() =>
        runLogicalDispatchAttempt({
          sessionKey: key,
          run: async () => {
            throw new Error("late effect ran");
          },
        }),
      );
      return withLogicalReplyDispatch({
        sessionKey: key,
        prompt: "x",
        run: async (done) => {
          done(dispatchHash("done"));
          return 1;
        },
      });
    },
  });
  release();
  await expect(pending).rejects.toThrow("THREAD_DISPATCH_REFUSED");
  expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("TERMINAL");
  db.close();
});
it("no public source omission bypasses protected logical reply", async () => {
  const db = setup();
  let ran = false;
  await expect(
    withLogicalReplyDispatch({
      sessionKey: key,
      prompt: "x",
      run: async () => {
        ran = true;
      },
    }),
  ).rejects.toThrow("THREAD_DISPATCH_REFUSED");
  expect(ran).toBe(false);
  db.close();
});
it("host final observer is required and thrown work remains UNKNOWN", async () => {
  const db = setup();
  await withHostReplyDispatch({
    sessionKey: key,
    operationId: "heartbeat:2",
    identity: {},
    timeoutMs: 1000,
    run: () => withLogicalReplyDispatch({ sessionKey: key, prompt: "x", run: async () => 1 }),
  });
  expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("UNKNOWN");
  db.close();
});
it("settled explicit pre-reply skip terminalizes without fake message", async () => {
  const db = setup();
  await withHostReplyDispatch({
    sessionKey: key,
    operationId: "heartbeat:3",
    identity: {},
    timeoutMs: 1000,
    completedWithoutReply: (r) => r === "skipped",
    run: async () => "skipped",
  });
  expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("TERMINAL");
  db.close();
});
it.each([false, true])(
  "actual wake timer sheds inherited owner context; live parent=%s still obeys DB",
  async (live) => {
    const db = setup();
    const { requestHeartbeat, setHeartbeatWakeHandler } =
      await import("../infra/heartbeat-wake.js");
    let finish!: (v: string) => void;
    const handled = new Promise<string>((r) => (finish = r));
    const dispose = setHeartbeatWakeHandler(async () => {
      try {
        await withHostReplyDispatch({
          sessionKey: key,
          operationId: "heartbeat:timer",
          identity: {},
          timeoutMs: 1000,
          run: () =>
            withLogicalReplyDispatch({
              sessionKey: key,
              prompt: "timer",
              run: async (done) => {
                done(dispatchHash("timer done"));
                return 1;
              },
            }),
        });
        finish("ran");
        return { status: "ran", durationMs: 1 };
      } catch (error) {
        finish((error as Error).message);
        return { status: "failed", reason: "fixture refusal" };
      }
    });
    try {
      await withHostReplyDispatch({
        sessionKey: key,
        operationId: "heartbeat:requester",
        identity: {},
        timeoutMs: 1000,
        completedWithoutReply: () => true,
        run: async () => {
          requestHeartbeat({ source: "manual", intent: "manual", sessionKey: key, coalesceMs: 5 });
          if (live) expect(await handled).toBe("NATIVE_BUSY");
          return "skipped";
        },
      });
      if (!live) expect(await handled).toBe("ran");
      const rows = db.prepare("SELECT state FROM thread_dispatch_claims").all();
      expect(rows).toHaveLength(live ? 1 : 2);
      expect(rows.every((r) => r.state === "TERMINAL")).toBe(true);
    } finally {
      dispose();
      db.close();
    }
  },
  10000,
);

it("same admitted host operation cannot become a new claim by changing identity", async () => {
  const db = setup();
  const invoke = (identity: unknown) =>
    withHostReplyDispatch({
      sessionKey: key,
      operationId: "gateway-chat:stable",
      identity,
      timeoutMs: 1000,
      completedWithoutReply: () => true,
      run: async () => "skipped",
    });
  await invoke({ prompt: "original" });
  await expect(invoke({ prompt: "changed" })).rejects.toThrow("THREAD_DISPATCH_REFUSED");
  expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(1);
  db.close();
});
