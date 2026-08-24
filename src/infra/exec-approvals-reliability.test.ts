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
  const lockPath = lockPathForApprovals();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
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
