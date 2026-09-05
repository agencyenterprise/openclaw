// Covers the pre-turn gate wired into the heartbeat runner preflight.
import fs from "node:fs";
import path from "node:path";
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

/** The verdict line scripts/heartbeat_gate.py prints as its last stdout line. */
function verdictLine(verdict: "skip" | "run"): string {
  return JSON.stringify({
    gate: "heartbeat",
    version: 1,
    verdict,
    actionable: 0,
    money: 0,
    jobs: 0,
  });
}

/**
 * A gate command that leaves `markerPath` behind, so a test can prove the gate
 * was never spawned rather than only that its answer was ignored.
 */
function gateCommandArgs(params: {
  markerPath: string;
  exitCode: number;
  stdout: string;
}): string[] {
  const body =
    `require("node:fs").writeFileSync(${JSON.stringify(params.markerPath)}, "ran");` +
    `process.stdout.write(${JSON.stringify(params.stdout)});` +
    `process.exit(${params.exitCode});`;
  return ["-e", body];
}

type HeartbeatRunOverrides = Pick<
  Parameters<typeof runHeartbeatOnce>[0],
  "source" | "reason" | "runScope"
>;

async function runHeartbeatWithGate(params: {
  exitCode: number;
  stdout: string;
  overrides?: HeartbeatRunOverrides;
}) {
  return withTempHeartbeatSandbox(
    async ({ tmpDir, storePath, replySpy }) => {
      const markerPath = path.join(tmpDir, "gate-ran");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              gate: {
                command: process.execPath,
                args: gateCommandArgs({
                  markerPath,
                  exitCode: params.exitCode,
                  stdout: params.stdout,
                }),
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
        ...params.overrides,
        deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0, nowMs: () => 0 },
      });
      return {
        result,
        replyCallCount: replySpy.mock.calls.length,
        gateRan: fs.existsSync(markerPath),
      };
    },
    { prefix: "openclaw-hb-gate-" },
  );
}

/** A gate that would skip the tick if it were consulted at all. */
async function runHeartbeatWithSkippingGate(overrides: HeartbeatRunOverrides) {
  return runHeartbeatWithGate({
    exitCode: 3,
    stdout: `heartbeat gate: no work (actionable=0 money=0 jobs=0)\n${verdictLine("skip")}\n`,
    overrides,
  });
}

describe("runHeartbeatOnce – pre-turn gate", () => {
  it("skips the model turn when the gate exits 3 with a skip verdict", async () => {
    const { result, replyCallCount, gateRan } = await runHeartbeatWithSkippingGate({});

    expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_GATE_NO_WORK });
    expect(replyCallCount).toBe(0);
    expect(gateRan).toBe(true);
  });

  it("runs the model turn when the gate exits 0", async () => {
    const { result, replyCallCount } = await runHeartbeatWithGate({
      exitCode: 0,
      stdout: `heartbeat gate: work (actionable=2 money=0 jobs=0)\n${verdictLine("run")}\n`,
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
  });

  it("runs the model turn when the gate fails, so a broken gate cannot silence the agent", async () => {
    const { result, replyCallCount } = await runHeartbeatWithGate({
      exitCode: 1,
      stdout: "heartbeat gate: sweep crashed\n",
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
  });

  it("runs the model turn when the gate exits 3 without the verdict line", async () => {
    const { result, replyCallCount } = await runHeartbeatWithGate({
      exitCode: 3,
      stdout: "heartbeat gate: no work\n",
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
  });
});

describe("runHeartbeatOnce – triggers that bypass the pre-turn gate", () => {
  // Each of these was asked for explicitly, so the gate -- which only sees Slack
  // threads and the job registry -- never gets to veto it. The marker file proves
  // the executable was not spawned at all, which a skip reason alone would not.
  const bypassingTriggers: Array<{ name: string; overrides: HeartbeatRunOverrides }> = [
    { name: "a hook wake", overrides: { source: "hook" } },
    { name: "a session-state wake", overrides: { source: "session-state" } },
    { name: 'a run whose reason is "wake"', overrides: { reason: "wake" } },
    { name: "a cron wake", overrides: { source: "cron" } },
    { name: "an exec-event wake", overrides: { source: "exec-event" } },
    { name: "a commitment-only run", overrides: { runScope: "commitment-only" } },
  ];

  for (const trigger of bypassingTriggers) {
    it(`never spawns the gate for ${trigger.name}`, async () => {
      const { result, gateRan } = await runHeartbeatWithSkippingGate(trigger.overrides);

      expect(gateRan).toBe(false);
      expect(result.status === "skipped" ? result.reason : undefined).not.toBe(
        HEARTBEAT_SKIP_GATE_NO_WORK,
      );
    });
  }
});
