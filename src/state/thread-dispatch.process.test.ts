import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { dispatchHash, withThreadDispatch } from "./thread-dispatch.js";
const sql =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-process-"));
  dirs.push(dir);
  const databasePath = path.join(dir, "fence.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(sql);
  chmodSync(databasePath, 0o600);
  const scope = "slack/C123/1788816064.061969";
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
  return {
    dir,
    db,
    config: { databasePath, scopes: { [scope]: 1 }, sessionScopes: { test: scope } },
  };
}
it("actual background process retains child claim after parent returns and leader exit remains UNKNOWN", async () => {
  const { db, config } = fixture();
  const supervisor = createProcessSupervisor();
  const handle = await withThreadDispatch({
    config,
    sessionKey: "test",
    operationId: "parent",
    kind: "native",
    identity: {},
    run: async () =>
      supervisor.spawn({
        sessionId: "test",
        backendId: "test",
        mode: "child",
        argv: [process.execPath, "-e", "setTimeout(()=>process.exit(0),150)"],
        timeoutMs: 2000,
      }),
    terminalReceipt: () => undefined,
  });
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='process_child'").get()?.state,
  ).toBe("STARTING");
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
  ).toBe("UNKNOWN");
  const exit = await handle.wait();
  await Promise.resolve();
  expect(exit.exitCode).toBe(0);
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='process_child'").get()?.state,
  ).toBe("UNKNOWN");
  db.close();
});
it("drain denies new spawn before replacement cancellation or marker effect", async () => {
  const { db, config, dir } = fixture();
  const supervisor = createProcessSupervisor();
  const marker = path.join(dir, "denied");
  await withThreadDispatch({
    config,
    sessionKey: "test",
    operationId: "parent",
    kind: "native",
    identity: {},
    run: async () => {
      const first = await supervisor.spawn({
        sessionId: "test",
        backendId: "test",
        scopeKey: "replace",
        mode: "child",
        argv: [process.execPath, "-e", "setTimeout(()=>process.exit(0),150)"],
        timeoutMs: 2000,
      });
      db.exec("UPDATE thread_fences SET state='DRAINING'");
      await expect(
        supervisor.spawn({
          sessionId: "test",
          backendId: "test",
          scopeKey: "replace",
          replaceExistingScope: true,
          mode: "child",
          argv: [
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync(process.argv[1],'bad')",
            marker,
          ],
          timeoutMs: 2000,
        }),
      ).rejects.toThrow();
      expect((await first.wait()).exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
    },
    terminalReceipt: () => undefined,
  });
  db.close();
});
it("explicit unrelated Slack scope keeps existing process behavior without claims", async () => {
  const { db, config } = fixture();
  const supervisor = createProcessSupervisor();
  await withThreadDispatch({
    config,
    sessionKey: "agent:other:slack:channel:C999:thread:1788816064.061969",
    operationId: "unrelated",
    kind: "native",
    identity: {},
    run: async () => {
      const child = await supervisor.spawn({
        sessionId: "unrelated",
        backendId: "test",
        mode: "child",
        argv: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 2000,
      });
      expect((await child.wait()).exitCode).toBe(0);
    },
    terminalReceipt: () => undefined,
  });
  expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(0);
  db.close();
});

it.each(["TERMINAL", "UNKNOWN"])(
  "V2 late AsyncLocalStorage child is denied after parent %s",
  async (parentState) => {
    const { db, config, dir } = fixture();
    const supervisor = createProcessSupervisor();
    const marker = path.join(dir, "late-marker");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late!: ReturnType<typeof supervisor.spawn>;
    await withThreadDispatch({
      config,
      sessionKey: "test",
      operationId: "old-parent",
      kind: "native",
      identity: {},
      run: async () => {
        late = (async () => {
          await gate;
          return supervisor.spawn({
            sessionId: "test",
            backendId: "test",
            mode: "child",
            argv: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync(process.argv[1],'bad')",
              marker,
            ],
            timeoutMs: 2000,
          });
        })();
        void late.catch(() => {});
      },
      terminalReceipt: () =>
        parentState === "TERMINAL" ? dispatchHash("native-only-done") : undefined,
    });
    if (parentState === "TERMINAL") {
      await withThreadDispatch({
        config,
        sessionKey: "test",
        operationId: "new-parent",
        kind: "native",
        identity: {},
        run: async () => {
          release();
          await expect(late).rejects.toThrow();
        },
        terminalReceipt: () => dispatchHash("new-done"),
      });
    } else {
      release();
      await expect(late).rejects.toThrow();
    }
    expect(existsSync(marker)).toBe(false);
    expect(
      db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims WHERE kind='process_child'").get()
        ?.n,
    ).toBe(0);
    db.close();
  },
);
