const durability = vi.hoisted(() => ({ calls: 0, failAt: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      durability.calls++;
      if (durability.calls === durability.failAt) throw new Error("fixture fsync failed");
      return actual.fsyncSync(fd);
    },
  };
});
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { bindNativeOwnerDeadline } from "./native-owner-recovery.js";
import {
  admitThreadDispatch,
  settleThreadDispatch,
  inspectNativeDispatchOwners,
  dispatchHash,
} from "./thread-dispatch.js";
const fenceSql =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "owner-recovery-"));
  dirs.push(root);
  const databasePath = path.join(root, "dispatch.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(fenceSql);
  chmodSync(databasePath, 0o600);
  const scope = "slack/C123/1788816064.061969";
  const other = "slack/C124/1788816064.061969";
  for (const s of [scope, other])
    db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(s);
  const config = { databasePath, scopes: { [scope]: 1, [other]: 1 }, sessionScopes: {} };
  return { root, db, scope, other, config };
}
const claim = (id: string, scopeKey: string) => ({
  claimId: id,
  scopeKey,
  epoch: 1,
  kind: "native",
  fingerprint: dispatchHash({ id }),
});
it.each([1, 2])(
  "actual dead process recovers failed native into authorized epoch %s preserving child and other scope",
  async (epoch) => {
    const f = fixture();
    const old = claim("native:dead-owner", f.scope);
    const sibling = claim("native:healthy-other", f.other);
    admitThreadDispatch(f.config, sibling);
    const module = new URL("./thread-dispatch.ts", import.meta.url).href;
    const script = path.join(f.root, "owner.mts");
    writeFileSync(
      script,
      `import {admitThreadDispatch,settleThreadDispatch} from ${JSON.stringify(module)}; const c=${JSON.stringify(f.config)}, n=${JSON.stringify(old)}; admitThreadDispatch(c,n);const child={...n,claimId:n.claimId+':child:0',kind:'process_child'};admitThreadDispatch(c,child,n);settleThreadDispatch(c,child);settleThreadDispatch(c,n);process.stdout.write('READY');setInterval(()=>{},1000);`,
    );
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    try {
      await Promise.race([
        once(child.stdout!, "data"),
        once(child, "exit").then(() => {
          throw new Error("child exited: " + stderr);
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("child setup timeout")), 15000),
        ),
      ]);
      expect(
        inspectNativeDispatchOwners(f.config).rows.find((r) => r.claimId === old.claimId)?.liveness,
      ).toBe("LIVE");
      expect(() => admitThreadDispatch(f.config, claim("native:busy", f.scope))).toThrow(
        "NATIVE_BUSY",
      );
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
      expect(
        inspectNativeDispatchOwners(f.config).rows.find((r) => r.claimId === old.claimId)?.liveness,
      ).toBe("DEAD");
      f.db.prepare("UPDATE thread_fences SET epoch=? WHERE scope_key=?").run(epoch, f.scope);
      f.config.scopes[f.scope] = epoch;
      admitThreadDispatch(f.config, { ...claim("native:new-source", f.scope), epoch });
      expect(
        f.db.prepare("SELECT state FROM thread_dispatch_claims WHERE claim_id=?").get(old.claimId)
          ?.state,
      ).toBe("TERMINAL");
      expect(
        f.db
          .prepare("SELECT state FROM thread_dispatch_claims WHERE claim_id=?")
          .get(old.claimId + ":child:0")?.state,
      ).toBe("UNKNOWN");
      expect(
        f.db
          .prepare("SELECT state FROM thread_dispatch_claims WHERE claim_id=?")
          .get(sibling.claimId)?.state,
      ).toBe("STARTING");
      expect(() => admitThreadDispatch(f.config, old)).toThrow("THREAD_DISPATCH_REFUSED");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      f.db.close();
    }
  },
);
it("live failed owner is held regardless of age and receives immutable runtime deadline", () => {
  const f = fixture();
  const c = claim("native:live", f.scope);
  admitThreadDispatch(f.config, c);
  settleThreadDispatch(f.config, c);
  bindNativeOwnerDeadline(f.config.databasePath, c, 900000);
  const first = inspectNativeDispatchOwners(f.config).rows[0];
  expect(first?.liveness).toBe("LIVE");
  expect(first?.owner?.deadlineAtMs).toBe((first?.owner?.admittedAtMs ?? 0) + 930000);
  bindNativeOwnerDeadline(f.config.databasePath, c, 1800000);
  expect(inspectNativeDispatchOwners(f.config).rows[0]?.owner?.deadlineAtMs).toBe(
    first?.owner?.deadlineAtMs,
  );
  expect(() => admitThreadDispatch(f.config, claim("native:new", f.scope))).toThrow("NATIVE_BUSY");
  f.db.close();
});
it("legacy missing receipt remains held", () => {
  const f = fixture();
  const c = claim("native:legacy", f.scope);
  f.db
    .prepare("INSERT INTO thread_dispatch_claims VALUES (?,?,?,?,?,'UNKNOWN',0,0,NULL)")
    .run(c.claimId, c.scopeKey, c.epoch, c.fingerprint, c.kind);
  expect(inspectNativeDispatchOwners(f.config).rows[0]?.liveness).toBe("UNVERIFIED");
  expect(() => admitThreadDispatch(f.config, claim("native:next", f.scope))).toThrow("NATIVE_BUSY");
  f.db.close();
});

it("numeric process identity is unverified rather than falsely dead", () => {
  const f = fixture();
  const c = claim("native:malformed", f.scope);
  admitThreadDispatch(f.config, c);
  settleThreadDispatch(f.config, c);
  const filename = f.config.databasePath + ".native-owners/" + dispatchHash(c.claimId) + ".json";
  const owner = JSON.parse(readFileSync(filename, "utf8"));
  owner.owner.startTicks = Number(owner.owner.startTicks);
  writeFileSync(filename, JSON.stringify(owner));
  expect(inspectNativeDispatchOwners(f.config).rows[0]?.liveness).toBe("UNVERIFIED");
  expect(() => admitThreadDispatch(f.config, claim("native:next", f.scope))).toThrow("NATIVE_BUSY");
  f.db.close();
});

it("retry after directory fsync failure flushes existing receipt before admitting", () => {
  const f = fixture();
  const c = claim("native:durable-retry", f.scope);
  durability.failAt = durability.calls + 3;
  expect(() => admitThreadDispatch(f.config, c)).toThrow("fixture fsync failed");
  expect(f.db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(0);
  const before = durability.calls;
  durability.failAt = 0;
  admitThreadDispatch(f.config, c);
  expect(durability.calls - before).toBeGreaterThanOrEqual(3);
  expect(inspectNativeDispatchOwners(f.config).rows[0]?.liveness).toBe("LIVE");
  f.db.close();
});
it("actual standalone inspector emits compatible readonly projection", () => {
  const f = fixture();
  const c = claim("native:inspect", f.scope);
  admitThreadDispatch(f.config, c);
  settleThreadDispatch(f.config, c);
  const configFile = path.join(f.root, "config.json");
  writeFileSync(configFile, JSON.stringify(f.config), { mode: 0o600 });
  const loader = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname;
  const cli = new URL("../../scripts/native-owner-inspect.ts", import.meta.url).pathname;
  const before = readFileSync(f.config.databasePath);
  const report = JSON.parse(
    execFileSync(process.execPath, ["--import", loader, cli, "--config", configFile, "--inspect"], {
      encoding: "utf8",
      timeout: 10000,
    }),
  );
  expect(report.schema).toBe("fractal-native-owner-inspection-v1");
  expect(report.rows[0]).toMatchObject({
    claimId: c.claimId,
    state: "UNKNOWN",
    liveness: "LIVE",
    updatedAtMs: expect.any(Number),
    owner: {
      pid: process.pid,
      startTicks: expect.any(String),
      machineId: expect.any(String),
      bootId: expect.any(String),
    },
  });
  expect(readFileSync(f.config.databasePath)).toEqual(before);
  f.db.close();
});
