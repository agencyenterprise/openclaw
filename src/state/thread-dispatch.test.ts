import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  admitThreadDispatch,
  dispatchHash,
  resolveDispatchScope,
  settleThreadDispatch,
  withThreadDispatch,
  type DispatchConfig,
} from "./thread-dispatch.js";
const SQL =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";
const dirs: string[] = [];
const scope = "slack/C123/1788816064.061969";
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "thread-dispatch-"));
  dirs.push(dir);
  const databasePath = path.join(dir, "fence.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(SQL);
  chmodSync(databasePath, 0o600);
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
  const config: DispatchConfig = {
    databasePath,
    scopes: { [scope]: 1 },
    sessionScopes: { test: scope },
  };
  const claim = {
    claimId: "operation-1",
    scopeKey: scope,
    epoch: 1,
    fingerprint: dispatchHash({ a: 1 }),
    kind: "native",
  };
  return { dir, db, config, claim };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("durable thread dispatch", () => {
  it("rejects extra trigger, index drift and stale fence settlement", () => {
    const { db, config, claim } = fixture();
    db.exec(
      "CREATE TRIGGER erase AFTER INSERT ON thread_dispatch_claims BEGIN DELETE FROM thread_dispatch_claims; END",
    );
    expect(() => admitThreadDispatch(config, claim)).toThrow();
    db.exec("DROP TRIGGER erase");
    admitThreadDispatch(config, claim);
    db.exec("UPDATE thread_fences SET epoch=2");
    expect(() => settleThreadDispatch(config, claim, dispatchHash("done"))).toThrow();
    db.exec("UPDATE thread_fences SET epoch=1,state='RETIRED'");
    expect(() => settleThreadDispatch(config, claim, dispatchHash("done"))).toThrow();
    db.exec("DROP INDEX thread_dispatch_open_claims");
    expect(() => settleThreadDispatch(config, claim)).toThrow();
    db.close();
  });
  it("commits admission before actual bounded local marker and retains exact terminal receipt", async () => {
    const { dir, db, config } = fixture();
    const marker = path.join(dir, "effect");
    await withThreadDispatch({
      config,
      sessionKey: "test",
      operationId: "actual-marker",
      kind: "native",
      identity: { x: 1 },
      run: async () => {
        expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe(
          "STARTING",
        );
        writeFileSync(marker, "one");
        return "complete";
      },
      terminalReceipt: dispatchHash,
    });
    expect(readFileSync(marker, "utf8")).toBe("one");
    expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("TERMINAL");
    db.close();
  });
  it("drain first denies the effect; prior claim can settle while draining", async () => {
    const { db, config, claim } = fixture();
    admitThreadDispatch(config, claim);
    db.exec("UPDATE thread_fences SET state='DRAINING'");
    let effects = 0;
    await expect(
      withThreadDispatch({
        config,
        sessionKey: "test",
        operationId: "later",
        kind: "native",
        identity: {},
        run: async () => ++effects,
        terminalReceipt: dispatchHash,
      }),
    ).rejects.toThrow();
    expect(effects).toBe(0);
    settleThreadDispatch(config, claim, dispatchHash("done"));
    db.close();
  });
  it("never replays terminal claims, permits only identical settlement", () => {
    const { db, config, claim } = fixture();
    admitThreadDispatch(config, claim);
    settleThreadDispatch(config, claim, dispatchHash("done"));
    settleThreadDispatch(config, claim, dispatchHash("done"));
    expect(() => admitThreadDispatch(config, claim)).toThrow();
    expect(() => settleThreadDispatch(config, claim, dispatchHash("different"))).toThrow();
    db.close();
  });
  it("interruption stays unresolved; wrong fingerprint and stale epoch refuse", async () => {
    const { db, config, claim } = fixture();
    await expect(
      withThreadDispatch({
        config,
        sessionKey: "test",
        operationId: claim.claimId,
        kind: claim.kind,
        identity: { a: 1 },
        run: async () => {
          throw new Error("interrupted");
        },
        terminalReceipt: dispatchHash,
      }),
    ).rejects.toThrow("interrupted");
    expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("UNKNOWN");
    expect(() =>
      settleThreadDispatch(
        config,
        { ...claim, fingerprint: dispatchHash("other") },
        dispatchHash("done"),
      ),
    ).toThrow();
    expect(() => admitThreadDispatch(config, { ...claim, claimId: "stale", epoch: 2 })).toThrow();
    db.close();
  });
  it("unknown origins cannot bypass while explicit unrelated Slack origin is unchanged", () => {
    const { db, config } = fixture();
    expect(() => resolveDispatchScope(config, "agent:main:main")).toThrow();
    expect(
      resolveDispatchScope(config, "agent:other:slack:channel:C999:thread:1788816064.061969"),
    ).toBeUndefined();
    db.close();
  });
  it("missing file or configured row refuses before effect and never creates absent db", async () => {
    const { db, config } = fixture();
    db.exec("DELETE FROM thread_fences");
    let effects = 0;
    const invoke = () =>
      withThreadDispatch({
        config,
        sessionKey: "test",
        operationId: "x",
        kind: "native",
        identity: {},
        run: async () => ++effects,
        terminalReceipt: dispatchHash,
      });
    await expect(invoke()).rejects.toThrow();
    db.close();
    rmSync(config.databasePath);
    await expect(invoke()).rejects.toThrow();
    expect(effects).toBe(0);
    expect(() => readFileSync(config.databasePath)).toThrow();
  });
});

it("V2 excludes distinct native owners, preserves child liabilities after native-only completion", () => {
  const { db, config, claim } = fixture();
  admitThreadDispatch(config, claim);
  const next = { ...claim, claimId: "next-native" };
  try {
    admitThreadDispatch(config, next);
    throw new Error("not denied");
  } catch (error) {
    expect((error as { code?: string }).code).toBe("NATIVE_BUSY");
  }
  const child = { ...claim, claimId: "independent-child-identity", kind: "process_child" };
  expect(() => admitThreadDispatch(config, child)).toThrow();
  expect(() =>
    admitThreadDispatch(config, child, { ...claim, fingerprint: dispatchHash("wrong") }),
  ).toThrow();
  admitThreadDispatch(config, child, claim);
  settleThreadDispatch(config, child);
  settleThreadDispatch(config, claim, dispatchHash("native-only-terminal"));
  admitThreadDispatch(config, next);
  expect(
    db.prepare("SELECT state FROM thread_dispatch_claims WHERE claim_id=?").get(child.claimId)
      ?.state,
  ).toBe("UNKNOWN");
  expect(() => admitThreadDispatch(config, { ...child, claimId: "late-child" }, claim)).toThrow();
  expect(() => admitThreadDispatch(config, { ...next, claimId: "extra-native" }, next)).toThrow();
  expect(() => admitThreadDispatch(config, claim)).toThrow();
  db.close();
});

it.each(["claimId", "scopeKey", "fingerprint", "kind"])("rejects numeric %s before admission", (field) => {
  const { db, config, claim } = fixture();
  try {
    expect(() => admitThreadDispatch(config, { ...claim, [field]: 1 })).toThrow("THREAD_DISPATCH_REFUSED");
    expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(0);
  } finally { db.close(); }
});
