// Covers the reliability behavior of the exec approvals store: lock
// contention must surface as a retryable condition on the exec path, stale
// locks from dead owners must self-heal, and hot-path reads and metadata
// refreshes must not thrash the sidecar lock.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  ExecApprovalsBusyError,
  type ExecApprovalsFile,
  loadExecApprovals,
  loadExecApprovalsForExec,
  loadExecApprovalsForExecWithRetry,
  recordAllowlistMatchesUse,
  resolveExecApprovalsPath,
  saveExecApprovals,
} from "./exec-approvals.js";

const testEnvSnapshot = captureEnv(["OPENCLAW_HOME", "OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR"]);
const tempDirs: string[] = [];

function makeApprovalsFile(): ExecApprovalsFile {
  return {
    version: 1,
    defaults: { security: "full", ask: "off" },
    agents: {
      main: {
        security: "full",
        ask: "off",
        allowlist: [{ id: "test-entry", pattern: "/usr/bin/uptime" }],
      },
    },
  } as ExecApprovalsFile;
}

beforeEach(() => {
  const home = makeTempDir();
  tempDirs.push(home);
  process.env.OPENCLAW_HOME = home;
  delete process.env.OPENCLAW_PROFILE;
  delete process.env.OPENCLAW_STATE_DIR;
});

afterEach(() => {
  testEnvSnapshot.restore();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function lockPathForApprovals(): string {
  return `${resolveExecApprovalsPath()}.lock`;
}

function writeLockOwnedBy(payload: Record<string, unknown>): void {
  writeRawLock(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeRawLock(raw: string): void {
  const lockPath = lockPathForApprovals();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath, raw, { mode: 0o600 });
}

/** Backdate the sidecar past the owner-less grace window. */
function ageLockBySeconds(seconds: number): void {
  const lockPath = lockPathForApprovals();
  const when = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(lockPath, when, when);
}

function listStateDirEntries(): string[] {
  return fs.readdirSync(path.dirname(lockPathForApprovals()));
}

describe("exec approvals reliability", () => {
  it("raises a retryable busy error on the exec path when a live owner holds the lock", () => {
    saveExecApprovals(makeApprovalsFile());
    // The current process is provably alive, so this lock is busy, not stale.
    writeLockOwnedBy({ pid: process.pid, createdAt: new Date().toISOString(), nonce: "held" });
    expect(() => loadExecApprovalsForExec()).toThrow(ExecApprovalsBusyError);
    fs.rmSync(lockPathForApprovals(), { force: true });
  });

  it("still fails closed (not busy) for the generic loader under the same contention", () => {
    saveExecApprovals(makeApprovalsFile());
    writeLockOwnedBy({ pid: process.pid, createdAt: new Date().toISOString(), nonce: "held" });
    const file = loadExecApprovals();
    expect(file.defaults?.security).toBe("deny");
    fs.rmSync(lockPathForApprovals(), { force: true });
  });

  it("breaks a stale lock from a provably dead owner and reads normally", () => {
    saveExecApprovals(makeApprovalsFile());
    // A pid far above anything running plus an impossible starttime: the
    // recorded owner provably no longer exists.
    writeLockOwnedBy({
      pid: 3999999,
      starttime: 1,
      createdAt: new Date(0).toISOString(),
      nonce: "dead-owner",
    });
    const file = loadExecApprovalsForExec();
    expect(file.agents?.main?.allowlist?.[0]?.pattern).toBe("/usr/bin/uptime");
    expect(fs.existsSync(lockPathForApprovals())).toBe(false);
  });

  it("reclaims an owner-less lock left behind by a writer that died mid-create", () => {
    saveExecApprovals(makeApprovalsFile());
    // Exactly what a gateway killed between creating the sidecar and writing
    // its payload leaves behind: a zero-byte lock naming nobody.
    writeRawLock("");
    ageLockBySeconds(30);
    const file = loadExecApprovalsForExec();
    expect(file.agents?.main?.allowlist?.[0]?.pattern).toBe("/usr/bin/uptime");
    expect(fs.existsSync(lockPathForApprovals())).toBe(false);
  });

  it("reclaims an aged lock whose payload is unparseable", () => {
    saveExecApprovals(makeApprovalsFile());
    writeRawLock("{ truncated");
    ageLockBySeconds(30);
    expect(loadExecApprovalsForExec().agents?.main?.allowlist?.[0]?.pattern).toBe(
      "/usr/bin/uptime",
    );
    expect(fs.existsSync(lockPathForApprovals())).toBe(false);
  });

  it("reclaims a lock whose recorded pid is dead and carries no start time", () => {
    saveExecApprovals(makeApprovalsFile());
    writeLockOwnedBy({ pid: 3999999, createdAt: new Date().toISOString(), nonce: "dead-no-start" });
    expect(loadExecApprovalsForExec().agents?.main?.allowlist?.[0]?.pattern).toBe(
      "/usr/bin/uptime",
    );
    expect(fs.existsSync(lockPathForApprovals())).toBe(false);
  });

  it("waits on a freshly created owner-less lock instead of stealing it", () => {
    saveExecApprovals(makeApprovalsFile());
    // Inside the grace window this is indistinguishable from a live writer that
    // has not published its payload yet, so it must not be reclaimed.
    writeRawLock("");
    expect(() => loadExecApprovalsForExec()).toThrow(ExecApprovalsBusyError);
    expect(fs.existsSync(lockPathForApprovals())).toBe(true);
    fs.rmSync(lockPathForApprovals(), { force: true });
  });

  it("never clobbers a held lock and leaves no temp sidecar behind", () => {
    saveExecApprovals(makeApprovalsFile());
    const held = `${JSON.stringify({ pid: process.pid, nonce: "held" }, null, 2)}\n`;
    writeRawLock(held);
    expect(() => loadExecApprovalsForExec()).toThrow(ExecApprovalsBusyError);
    expect(fs.readFileSync(lockPathForApprovals(), "utf8")).toBe(held);
    fs.rmSync(lockPathForApprovals(), { force: true });
    expect(listStateDirEntries().filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("retries through contention that clears and returns the store", async () => {
    saveExecApprovals(makeApprovalsFile());
    // pid 1 is alive and is not this process, so the lock is contended, not stale.
    writeLockOwnedBy({ pid: 1, createdAt: new Date().toISOString(), nonce: "foreign" });
    // The non-retrying loader gives up on exactly this state; the retrying one
    // is what keeps contention from reaching the agent as a command failure.
    expect(() => loadExecApprovalsForExec()).toThrow(ExecApprovalsBusyError);
    const release = setTimeout(() => {
      fs.rmSync(lockPathForApprovals(), { force: true });
    }, 60);
    try {
      const file = await loadExecApprovalsForExecWithRetry({ retryDelaysMs: [0, 25, 50, 100] });
      expect(file.agents?.main?.allowlist?.[0]?.pattern).toBe("/usr/bin/uptime");
    } finally {
      clearTimeout(release);
      fs.rmSync(lockPathForApprovals(), { force: true });
    }
  });

  it("surfaces an exhausted budget as a stuck lock that must not be retried", async () => {
    saveExecApprovals(makeApprovalsFile());
    writeLockOwnedBy({ pid: 1, createdAt: new Date().toISOString(), nonce: "foreign" });
    const error = await loadExecApprovalsForExecWithRetry({ retryDelaysMs: [0, 10, 10] }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ExecApprovalsBusyError);
    const message = (error as Error).message;
    expect(message).toContain("Retrying cannot clear it");
    expect(message).toContain("3 attempts");
    expect(message).not.toContain("retry the command");
    fs.rmSync(lockPathForApprovals(), { force: true });
  });

  it("serves repeat reads from the stat-validated cache and sees atomic rewrites", () => {
    saveExecApprovals(makeApprovalsFile());
    const first = loadExecApprovalsForExec();
    const second = loadExecApprovalsForExec();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    const changed = makeApprovalsFile();
    changed.agents!.main!.allowlist = [{ id: "test-entry-2", pattern: "/usr/bin/id" }];
    saveExecApprovals(changed);
    expect(loadExecApprovalsForExec().agents?.main?.allowlist?.[0]?.pattern).toBe("/usr/bin/id");
  });

  it("debounces lastUsedAt refreshes so repeat execs do not rewrite the store", () => {
    saveExecApprovals(makeApprovalsFile());
    const approvals = loadExecApprovals();
    const entry = approvals.agents!.main!.allowlist![0]!;
    recordAllowlistMatchesUse({
      approvals,
      agentId: "main",
      matches: [entry],
      command: "uptime",
    });
    const stampedAt = fs.statSync(resolveExecApprovalsPath()).mtimeMs;
    const stamped = loadExecApprovals().agents!.main!.allowlist![0]!;
    recordAllowlistMatchesUse({
      approvals: loadExecApprovals(),
      agentId: "main",
      matches: [stamped],
      command: "uptime again",
    });
    expect(fs.statSync(resolveExecApprovalsPath()).mtimeMs).toBe(stampedAt);
  });
});
