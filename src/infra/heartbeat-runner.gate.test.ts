// Covers the pre-turn gate wired into the heartbeat runner preflight.
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { HEARTBEAT_SKIP_GATE_NO_WORK } from "./heartbeat-gate.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([]),
  deliverOutboundPayloadsInternal: vi.fn().mockResolvedValue([]),
}));

function gateCommandArgs(exitCode: number, summary: string): string[] {
  return [
    "-e",
    `process.stdout.write(${JSON.stringify(`${summary}\n`)}); process.exit(${exitCode});`,
  ];
}

async function runHeartbeatWithGate(params: { exitCode: number; summary: string }) {
  return withTempHeartbeatSandbox(
    async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              gate: {
                command: process.execPath,
                args: gateCommandArgs(params.exitCode, params.summary),
                timeoutMs: 30_000,
              },
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, resolveMainSessionKey(cfg), {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+1555",
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0, nowMs: () => 0 },
      });
      return { result, replyCallCount: replySpy.mock.calls.length };
    },
    { prefix: "openclaw-hb-gate-" },
  );
}

describe("runHeartbeatOnce – pre-turn gate", () => {
  it("skips the model turn when the gate exits 3", async () => {
    const { result, replyCallCount } = await runHeartbeatWithGate({
      exitCode: 3,
      summary: "heartbeat gate: no work (actionable=0 money=0)",
    });

    expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_GATE_NO_WORK });
    expect(replyCallCount).toBe(0);
  });

  it("runs the model turn when the gate exits 0", async () => {
    const { result, replyCallCount } = await runHeartbeatWithGate({
      exitCode: 0,
      summary: "heartbeat gate: work (actionable=2 money=0)",
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
  });

  it("runs the model turn when the gate fails, so a broken gate cannot silence the agent", async () => {
    const { result, replyCallCount } = await runHeartbeatWithGate({
      exitCode: 1,
      summary: "heartbeat gate: sweep crashed",
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
  });
});
