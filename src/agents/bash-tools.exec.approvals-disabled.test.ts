/**
 * tools.exec.approvalsDisabled end-to-end tests.
 * Runs real commands through the exec tool and asserts that the opt-out makes
 * the approvals store untouched - no lock, no read, no authorization commit -
 * while leaving the store fully in charge when the opt-out is absent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

const TRACKED_FS_METHODS = [
  "openSync",
  "readFileSync",
  "writeFileSync",
  "statSync",
  "lstatSync",
  "rmSync",
  "renameSync",
  "mkdirSync",
  "chmodSync",
  "linkSync",
] as const;

/**
 * Record every filesystem call whose target names the approvals store or its
 * lock sidecar. "Zero store operations" has to be observed, not assumed: a
 * policy that merely resolves to the same answer would still take the lock.
 */
function trackApprovalsStoreAccess(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const spies = TRACKED_FS_METHODS.map((method) => {
    const original = fs[method] as (...args: unknown[]) => unknown;
    return vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
      const target = String(args[0] ?? "");
      if (target.includes("exec-approvals")) {
        calls.push(`${method} ${path.basename(target)}`);
      }
      return original.apply(fs, args);
    }) as never);
  });
  return {
    calls,
    restore: () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

function config(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("tools.exec.approvalsDisabled", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempRoot: string;
  let tracker: ReturnType<typeof trackApprovalsStoreAccess> | undefined;

  function writeApprovalsFixture(file: Record<string, unknown>): void {
    const stateDir = path.join(tempRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "exec-approvals.json"), `${JSON.stringify(file)}\n`);
  }

  function writeDenyingStore(): void {
    writeApprovalsFixture({
      version: 1,
      defaults: { security: "deny", ask: "off" },
      agents: {},
    });
  }

  function writePermissiveStore(): void {
    writeApprovalsFixture({
      version: 1,
      defaults: { security: "full", ask: "off", askFallback: "full" },
      agents: {},
    });
  }

  function readText(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content[0]?.text ?? "";
  }

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "SHELL",
    ]);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approvals-disabled-"));
    setTestEnvValue("HOME", tempRoot);
    setTestEnvValue("USERPROFILE", tempRoot);
    setTestEnvValue("OPENCLAW_HOME", tempRoot);
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
    deleteTestEnvValue("HOMEDRIVE");
    deleteTestEnvValue("HOMEPATH");
    resetProcessRegistryForTests();
    vi.mocked(callGatewayTool).mockReset();
  });

  afterEach(() => {
    tracker?.restore();
    tracker = undefined;
    envSnapshot.restore();
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("runs a real command without one approvals-store operation when disabled", async () => {
    // A store that denies everything. If anything consulted it the command
    // could not run, so success alone proves it was never read.
    writeDenyingStore();
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      config: config({ tools: { exec: { approvalsDisabled: true } } }),
    });

    tracker = trackApprovalsStoreAccess();
    const result = await tool.execute("call-disabled", { command: "echo approvals-bypassed" });

    expect(readText(result)).toContain("approvals-bypassed");
    expect(readText(result)).not.toMatch(/exec denied/i);
    expect(tracker.calls).toEqual([]);
  });

  it("honors a per-agent opt-out at agents.list[].tools.exec", async () => {
    writeDenyingStore();
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      agentId: "worker",
      config: config({
        agents: { list: [{ id: "worker", tools: { exec: { approvalsDisabled: true } } }] },
      }),
    });

    tracker = trackApprovalsStoreAccess();
    const result = await tool.execute("call-agent-disabled", { command: "echo agent-bypassed" });

    expect(readText(result)).toContain("agent-bypassed");
    expect(tracker.calls).toEqual([]);
  });

  it("leaves the store in charge for an agent that did not opt out", async () => {
    writeDenyingStore();
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      agentId: "other",
      config: config({
        agents: { list: [{ id: "worker", tools: { exec: { approvalsDisabled: true } } }] },
      }),
    });

    await expect(
      tool.execute("call-other-agent", { command: "echo should-not-run" }),
    ).rejects.toThrow(/security=deny|exec denied/i);
  });

  it("consults the store and obeys its denial when the opt-out is absent", async () => {
    writeDenyingStore();
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      config: config({ tools: { exec: {} } }),
    });

    tracker = trackApprovalsStoreAccess();
    await expect(tool.execute("call-enabled", { command: "echo should-not-run" })).rejects.toThrow(
      /security=deny|exec denied/i,
    );
    expect(tracker.calls.length).toBeGreaterThan(0);
  });

  it("takes the lock and runs the authorization commit when the opt-out is absent", async () => {
    writePermissiveStore();
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      config: config({ tools: { exec: {} } }),
    });

    tracker = trackApprovalsStoreAccess();
    const result = await tool.execute("call-committed", { command: "echo store-consulted" });

    expect(readText(result)).toContain("store-consulted");
    // The commit path takes the exclusive sidecar; the bypass never does.
    expect(tracker.calls.some((call) => call.includes("exec-approvals.json.lock"))).toBe(true);
  });
});
