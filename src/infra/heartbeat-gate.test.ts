// Covers the pre-turn heartbeat gate: skip on exit 3 plus a skip verdict, run on anything else.
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HEARTBEAT_GATE_TIMEOUT_MS,
  evaluateHeartbeatGate,
  HEARTBEAT_GATE_SKIP_EXIT_CODE,
  type HeartbeatGateCommandResult,
  type HeartbeatGateCommandRunner,
} from "./heartbeat-gate.js";

const gateInfoSpy = vi.hoisted(() => vi.fn());
const gateErrorSpy = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      info: gateInfoSpy,
      error: gateErrorSpy,
    }),
  };
});

type GateRunnerParams = Parameters<HeartbeatGateCommandRunner>[0];

/** The verdict line scripts/heartbeat_gate.py prints as its last stdout line. */
function verdictLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ gate: "heartbeat", version: 1, ...fields });
}

const SKIP_STDOUT = `heartbeat gate: no work (actionable=0 money=0 jobs=0)\n${verdictLine({
  verdict: "skip",
  actionable: 0,
  money: 0,
  jobs: 0,
})}\n`;

function createGateRunner(result: Partial<HeartbeatGateCommandResult>) {
  const calls: GateRunnerParams[] = [];
  const runCommand: HeartbeatGateCommandRunner = async (params) => {
    calls.push(params);
    return { code: 0, stdout: "", timedOut: false, ...result };
  };
  return { calls, runCommand };
}

/** Run the gate against a stub whose only variable is what it wrote on exit 3. */
async function evaluateSkipExitWithStdout(stdout: string) {
  const { runCommand } = createGateRunner({ code: HEARTBEAT_GATE_SKIP_EXIT_CODE, stdout });
  return evaluateHeartbeatGate({
    gate: { command: "python3", args: ["scripts/heartbeat_gate.py"] },
    runCommand,
  });
}

beforeEach(() => {
  gateInfoSpy.mockReset();
  gateErrorSpy.mockReset();
});

describe("evaluateHeartbeatGate", () => {
  it("runs the turn and spawns nothing when no gate is configured", async () => {
    const { calls, runCommand } = createGateRunner({ code: HEARTBEAT_GATE_SKIP_EXIT_CODE });

    const decision = await evaluateHeartbeatGate({ runCommand });

    expect(decision).toEqual({ action: "run" });
    expect(calls).toEqual([]);
  });

  it("skips the turn and logs one line when the gate exits 3 with a skip verdict", async () => {
    const decision = await evaluateSkipExitWithStdout(SKIP_STDOUT);

    expect(decision).toEqual({ action: "skip" });
    expect(gateInfoSpy).toHaveBeenCalledTimes(1);
    expect(gateInfoSpy.mock.calls[0]?.[0]).toBe(
      "heartbeat skipped: gate found no work: heartbeat gate: no work (actionable=0 money=0 jobs=0)",
    );
    expect(gateErrorSpy).not.toHaveBeenCalled();
  });

  it("runs the turn when the gate exits 3 without any verdict line", async () => {
    const decision = await evaluateSkipExitWithStdout("heartbeat gate: no work\nnot json at all\n");

    expect(decision).toEqual({ action: "run" });
    expect(gateErrorSpy).toHaveBeenCalledTimes(1);
    expect(gateErrorSpy.mock.calls[0]?.[0]).toContain("exited 3 without a skip verdict line");
    expect(gateInfoSpy).not.toHaveBeenCalled();
  });

  it("runs the turn when the gate exits 3 but prints nothing at all", async () => {
    const decision = await evaluateSkipExitWithStdout("");

    expect(decision).toEqual({ action: "run" });
    expect(gateErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("runs the turn when the gate exits 3 while its verdict says run", async () => {
    const decision = await evaluateSkipExitWithStdout(
      `heartbeat gate: work (actionable=1 money=0 jobs=0)\n${verdictLine({ verdict: "run" })}\n`,
    );

    expect(decision).toEqual({ action: "run" });
    expect(gateErrorSpy).toHaveBeenCalledTimes(1);
    expect(gateErrorSpy.mock.calls[0]?.[1]).toMatchObject({ verdict: "run" });
  });

  it("runs the turn when the exit-3 verdict comes from a different gate or contract version", async () => {
    const otherGate = await evaluateSkipExitWithStdout(
      `${JSON.stringify({ gate: "something-else", version: 1, verdict: "skip" })}\n`,
    );
    const otherVersion = await evaluateSkipExitWithStdout(
      `${JSON.stringify({ gate: "heartbeat", version: 2, verdict: "skip" })}\n`,
    );

    expect(otherGate).toEqual({ action: "run" });
    expect(otherVersion).toEqual({ action: "run" });
    expect(gateErrorSpy).toHaveBeenCalledTimes(2);
  });

  it("runs the turn when the gate exits 0", async () => {
    const { runCommand } = createGateRunner({
      code: 0,
      stdout: `heartbeat gate: work (actionable=2 money=0 jobs=0)\n${verdictLine({
        verdict: "run",
      })}\n`,
    });

    const decision = await evaluateHeartbeatGate({
      gate: { command: "python3", args: ["scripts/heartbeat_gate.py"] },
      runCommand,
    });

    expect(decision).toEqual({ action: "run" });
    expect(gateErrorSpy).not.toHaveBeenCalled();
  });

  it("passes command, args, cwd and the configured timeout to the runner", async () => {
    const { calls, runCommand } = createGateRunner({ code: 0 });

    await evaluateHeartbeatGate({
      gate: {
        command: "python3",
        args: ["scripts/heartbeat_gate.py"],
        cwd: "/gate/cwd",
        timeoutMs: 1234,
      },
      cwd: "/workspace",
      runCommand,
    });

    expect(calls).toEqual([
      {
        command: "python3",
        args: ["scripts/heartbeat_gate.py"],
        cwd: "/gate/cwd",
        timeoutMs: 1234,
      },
    ]);
  });

  it("falls back to the workspace dir and the default timeout", async () => {
    const { calls, runCommand } = createGateRunner({ code: 0 });

    await evaluateHeartbeatGate({
      gate: { command: "python3" },
      cwd: "/workspace",
      runCommand,
    });

    expect(calls[0]).toEqual({
      command: "python3",
      args: [],
      cwd: "/workspace",
      timeoutMs: DEFAULT_HEARTBEAT_GATE_TIMEOUT_MS,
    });
  });

  it("leaves the gate script's own timeout room to report before this one kills it", () => {
    // scripts/heartbeat_gate.py: DEFAULT_TIMEOUT_S = 90. The Python side pins its
    // half of the same contract; both must move together.
    const gateScriptDefaultTimeoutMs = 90 * 1000;

    expect(DEFAULT_HEARTBEAT_GATE_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_HEARTBEAT_GATE_TIMEOUT_MS).toBeGreaterThan(gateScriptDefaultTimeoutMs);
  });

  it("runs the turn and logs an error when the gate exits with an unexpected code", async () => {
    const { runCommand } = createGateRunner({ code: 1, stdout: "heartbeat gate: sweep crashed\n" });

    const decision = await evaluateHeartbeatGate({
      gate: { command: "python3" },
      runCommand,
    });

    expect(decision).toEqual({ action: "run" });
    expect(gateErrorSpy).toHaveBeenCalledTimes(1);
    expect(gateErrorSpy.mock.calls[0]?.[0]).toBe(
      "heartbeat gate exited with an unexpected code, running the turn anyway: heartbeat gate: sweep crashed",
    );
    expect(gateErrorSpy.mock.calls[0]?.[1]).toMatchObject({ exitCode: 1 });
  });

  it("runs the turn and logs an error when the gate times out", async () => {
    const { runCommand } = createGateRunner({ code: null, timedOut: true });

    const decision = await evaluateHeartbeatGate({
      gate: { command: "python3", timeoutMs: 50 },
      runCommand,
    });

    expect(decision).toEqual({ action: "run" });
    expect(gateErrorSpy).toHaveBeenCalledTimes(1);
    expect(gateErrorSpy.mock.calls[0]?.[0]).toBe(
      "heartbeat gate timed out, running the turn anyway",
    );
  });

  it("runs the turn and logs an error when the gate cannot be spawned", async () => {
    const runCommand: HeartbeatGateCommandRunner = async () => {
      throw new Error("spawn ENOENT");
    };

    const decision = await evaluateHeartbeatGate({
      gate: { command: "definitely-not-a-command" },
      runCommand,
    });

    expect(decision).toEqual({ action: "run" });
    expect(gateErrorSpy).toHaveBeenCalledTimes(1);
    expect(gateErrorSpy.mock.calls[0]?.[0]).toContain("heartbeat gate could not run");
  });

  it("skips on a real subprocess that exits 3 with a skip verdict", async () => {
    const decision = await evaluateHeartbeatGate({
      gate: {
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(SKIP_STDOUT)}); process.exit(3);`],
        timeoutMs: 30_000,
      },
    });

    expect(decision).toEqual({ action: "skip" });
    expect(gateInfoSpy.mock.calls[0]?.[0]).toBe(
      "heartbeat skipped: gate found no work: heartbeat gate: no work (actionable=0 money=0 jobs=0)",
    );
  });

  it("runs the turn on a real subprocess that exits 3 with no verdict line", async () => {
    const decision = await evaluateHeartbeatGate({
      gate: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('no work\\n'); process.exit(3);"],
        timeoutMs: 30_000,
      },
    });

    expect(decision).toEqual({ action: "run" });
    expect(gateErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("runs the turn on a real subprocess that exits 0", async () => {
    const decision = await evaluateHeartbeatGate({
      gate: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('work\\n');"],
        timeoutMs: 30_000,
      },
    });

    expect(decision).toEqual({ action: "run" });
    expect(gateErrorSpy).not.toHaveBeenCalled();
  });
});
