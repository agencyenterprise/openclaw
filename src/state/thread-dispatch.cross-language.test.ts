import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitThreadDispatch, dispatchHash, settleThreadDispatch, withThreadDispatch } from "./thread-dispatch.js";

const root = process.env.THREAD_DISPATCH_PYTHON_CONTROL;
if (!root || !path.isAbsolute(root)) throw new Error("Explicit isolated Python control path required");
const scope = "slack/C0AHSKBNDB6/1788816064.061969";
const sessionKey = "agent:main:slack:channel:C0AHSKBNDB6:thread:1788816064.061969";
const dirs: string[] = [];
const env = { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" };
const preamble = "import sys,json; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import thread_dispatch_control as f; p=Path(sys.argv[2]); s=sys.argv[3]; ";
function python(database: string, code: string): any {
  const out = execFileSync("/usr/bin/python3", ["-B", "-c", preamble + code, root!, database, scope], { env, timeout: 10000, encoding: "utf8" });
  return out.trim() ? JSON.parse(out) : undefined;
}
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-cross-")); dirs.push(dir);
  const databasePath = path.join(dir, "claims.sqlite");
  python(databasePath, "f.bootstrap(p); f.install_scope(p,s,1)");
  return { dir, config: { databasePath, scopes: { [scope]: 1 }, sessionScopes: {} },
    claim: { claimId: "native:operation-1", scopeKey: scope, epoch: 1, fingerprint: "a".repeat(64), kind: "native" } };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("actual Python and TypeScript shared SQLite contract", () => {
  it("Python initializes, TS admits, Python sees durable identity and settles", () => {
    const { config, claim } = fixture();
    admitThreadDispatch(config, claim);
    const state = python(config.databasePath, "print(json.dumps(f.inspect(p,s,1)))");
    expect(state.claims[0]).toMatchObject({ claim_id: claim.claimId, state: "STARTING", fingerprint: claim.fingerprint });
    python(config.databasePath, "c=f.inspect(p,s,1)['claims'][0]; print(json.dumps(f.advance(p,c,'TERMINAL','b'*64)))");
    expect(() => admitThreadDispatch(config, claim)).toThrow();
  });
  it("Python admission can settle through TS while draining; changed receipt refuses", () => {
    const { config, claim } = fixture();
    python(config.databasePath, "f.admit(p,s,1,'native:operation-1','a'*64,'native'); f.drain(p,s,1)");
    settleThreadDispatch(config, claim, "b".repeat(64));
    settleThreadDispatch(config, claim, "b".repeat(64));
    expect(() => settleThreadDispatch(config, claim, "c".repeat(64))).toThrow();
    const state = python(config.databasePath, "print(json.dumps(f.inspect(p,s,1)))");
    expect(state.state).toBe("DRAINING"); expect(state.claims[0].state).toBe("TERMINAL");
  });
  it("drain blocks a second callback while an admitted local effect completes", async () => {
    const { config, dir } = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const marker = path.join(dir, "effect.marker");
    let entered = false;
    const pending = withThreadDispatch({ config, sessionKey, operationId: "native:first", kind: "native", identity: { id: "first" },
      run: async () => { entered = true; writeFileSync(marker, "exactly once", { flag: "wx" }); await barrier; return "done"; },
      terminalReceipt: (result) => dispatchHash({ result }) });
    expect(entered).toBe(true);
    const drained = python(config.databasePath, "print(json.dumps(f.drain(p,s,1)))");
    expect(drained.unresolved_claims).toHaveLength(1);
    await expect(withThreadDispatch({ config, sessionKey, operationId: "native:second", kind: "native", identity: { id: "second" },
      run: async () => { throw new Error("second effect must not run"); }, terminalReceipt: () => undefined })).rejects.toThrow();
    release(); await expect(pending).resolves.toBe("done");
    expect(readFileSync(marker, "utf8")).toBe("exactly once");
    const after = python(config.databasePath, "print(json.dumps(f.drain(p,s,1)))");
    expect(after.unresolved_claims).toHaveLength(0); expect(after.retirement_authorized).toBe(false);
  });
  it("Python crash after admission remains unresolved to TS and cannot replay", () => {
    const { config, claim } = fixture();
    const child = spawnSync("/usr/bin/python3", ["-B", "-c", preamble + "import os; f.admit(p,s,1,'native:operation-1','a'*64,'native'); os._exit(17)", root!, config.databasePath, scope], { env, timeout: 10000 });
    expect(child.status).toBe(17); expect(() => admitThreadDispatch(config, claim)).toThrow();
    settleThreadDispatch(config, claim);
    const state = python(config.databasePath, "print(json.dumps(f.drain(p,s,1)))");
    expect(state.unresolved_claims[0].state).toBe("UNKNOWN");
  });
  it("TS rejects extra trigger that would delete the claim before callback", async () => {
    const { config } = fixture();
    python(config.databasePath, "import sqlite3; c=sqlite3.connect(p); c.execute('CREATE TRIGGER erase AFTER INSERT ON thread_dispatch_claims BEGIN DELETE FROM thread_dispatch_claims; END'); c.commit(); c.close()");
    let called = false;
    await expect(withThreadDispatch({ config, sessionKey, operationId: "native:bad", kind: "native", identity: {}, run: async () => { called = true; }, terminalReceipt: () => undefined })).rejects.toThrow();
    expect(called).toBe(false);
  });
});


describe("V2 cross-language ownership", () => {
  it("different native IDs race to exactly one admitted effect", async () => {
    const { config, claim, dir } = fixture();
    const code = preamble + "print('READY',flush=True); input();\ntry:\n f.admit(p,s,1,'native:python','c'*64,'native'); Path(sys.argv[4]).write_text('python'); print('ADMITTED',flush=True)\nexcept f.NativeBusy:\n print('BUSY',flush=True)";
    const child = spawn("/usr/bin/python3", ["-B", "-c", code, root!, config.databasePath, scope, path.join(dir, "python.marker")], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    child.stdout.on("data", (part) => { output += part; if (output.includes("READY")) resolveReady(); });
    child.stderr.on("data", (part) => { stderr += part; });
    const finished = new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      await Promise.race([ready, finished.then(() => { throw new Error("Python exited before ready: " + stderr); })]);
      child.stdin.end("go\n");
      let tsAdmitted = false;
      try { admitThreadDispatch(config, claim); tsAdmitted = true; writeFileSync(path.join(dir,"ts.marker"), "typescript", {flag:"wx"}); }
      catch (error) { expect((error as {code?:string}).code).toBe("NATIVE_BUSY"); }
      expect(await finished).toBe(0);
      expect(output.includes("ADMITTED")).toBe(!tsAdmitted);
      expect(output.includes("BUSY")).toBe(tsAdmitted);
      expect(python(config.databasePath, "print(json.dumps(f.inspect(p,s,1)))").claims).toHaveLength(1);
    } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill("SIGKILL"); }
  });
  it("Python terminal permits TS successor but blocks a late TS child", () => {
    const { config, claim } = fixture();
    admitThreadDispatch(config, claim);
    const firstChild = { ...claim, claimId: "child:early", kind:"process_child" };
    admitThreadDispatch(config, firstChild, claim);
    settleThreadDispatch(config, firstChild);
    python(config.databasePath, "c=next(c for c in f.inspect(p,s,1)['claims'] if c['kind']=='native'); f.advance(p,c,'TERMINAL','b'*64)");
    admitThreadDispatch(config, {...claim, claimId:"native:successor"});
    expect(() => admitThreadDispatch(config, {...firstChild, claimId:"child:late"}, claim)).toThrow();
    const after = python(config.databasePath, "print(json.dumps(f.drain(p,s,1)))");
    expect(after.unresolved_claims.map((c: {kind:string}) => c.kind).sort()).toEqual(["native", "process_child"]);
    expect(after.retirement_authorized).toBe(false);
  });
});
