// Runs the configured pre-turn heartbeat gate so scheduled wakes only pay for a model turn when there is work.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { HeartbeatGateConfig } from "../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandBuffered } from "../process/exec.js";
import { formatErrorMessage } from "./errors.js";

const log = createSubsystemLogger("gateway/heartbeat");

/** Skip reason recorded when the gate command reports that there is nothing to do. */
export const HEARTBEAT_SKIP_GATE_NO_WORK = "gate-no-work";
/** Exit code the gate command uses to say "no work, skip this heartbeat". */
export const HEARTBEAT_GATE_SKIP_EXIT_CODE = 3;

const DEFAULT_HEARTBEAT_GATE_TIMEOUT_MS = 60_000;
const HEARTBEAT_GATE_SUMMARY_MAX_CHARS = 200;
const HEARTBEAT_GATE_MAX_OUTPUT_BYTES = 64 * 1024;

/** Normalized outcome of one gate command run. */
export type HeartbeatGateCommandResult = {
  /** Process exit code, or null when the process never exited normally. */
  code: number | null;
  stdout: string;
  timedOut: boolean;
  error?: Error;
};

export type HeartbeatGateCommandRunner = (params: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
}) => Promise<HeartbeatGateCommandResult>;

export type HeartbeatGateDecision = { action: "run" } | { action: "skip" };

const runGateCommand: HeartbeatGateCommandRunner = async (params) => {
  const result = await runCommandBuffered([params.command, ...params.args], {
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    maxOutputBytes: HEARTBEAT_GATE_MAX_OUTPUT_BYTES,
  });
  return {
    code: result.code,
    stdout: result.stdout.toString("utf-8"),
    timedOut: result.termination === "timeout",
    ...(result.error ? { error: result.error } : {}),
  };
};

function resolveGateSummary(stdout: string): string {
  const firstLine = stdout.split("\n", 1)[0]?.trim() ?? "";
  return truncateUtf16Safe(firstLine, HEARTBEAT_GATE_SUMMARY_MAX_CHARS);
}

function withSummary(message: string, summary: string): string {
  return summary ? `${message}: ${summary}` : message;
}

/**
 * Decide whether a scheduled heartbeat turn is worth running.
 *
 * The gate command is the cheap deterministic half of the heartbeat: exit 3 means
 * "no work, skip the model turn", exit 0 means "run it". Anything else (unexpected
 * exit code, timeout, spawn failure) fails loud and still runs the turn, so a broken
 * gate can never silence the agent.
 */
export async function evaluateHeartbeatGate(params: {
  gate?: HeartbeatGateConfig;
  cwd?: string;
  runCommand?: HeartbeatGateCommandRunner;
}): Promise<HeartbeatGateDecision> {
  const gate = params.gate;
  if (!gate?.command) {
    return { action: "run" };
  }

  const command = gate.command;
  const timeoutMs = gate.timeoutMs ?? DEFAULT_HEARTBEAT_GATE_TIMEOUT_MS;
  const run = params.runCommand ?? runGateCommand;
  let result: HeartbeatGateCommandResult;
  try {
    result = await run({
      command,
      args: gate.args ?? [],
      cwd: gate.cwd ?? params.cwd,
      timeoutMs,
    });
  } catch (err: unknown) {
    log.error(`heartbeat gate could not run, running the turn anyway: ${formatErrorMessage(err)}`, {
      command,
    });
    return { action: "run" };
  }

  const summary = resolveGateSummary(result.stdout);
  if (result.timedOut) {
    log.error("heartbeat gate timed out, running the turn anyway", { command, timeoutMs });
    return { action: "run" };
  }
  if (result.error) {
    log.error(
      `heartbeat gate failed, running the turn anyway: ${formatErrorMessage(result.error)}`,
      { command },
    );
    return { action: "run" };
  }
  if (result.code === HEARTBEAT_GATE_SKIP_EXIT_CODE) {
    log.info(withSummary("heartbeat skipped: gate found no work", summary), { command, summary });
    return { action: "skip" };
  }
  if (result.code === 0) {
    log.info(withSummary("heartbeat gate found work", summary), { command, summary });
    return { action: "run" };
  }

  log.error(
    withSummary("heartbeat gate exited with an unexpected code, running the turn anyway", summary),
    { command, exitCode: result.code },
  );
  return { action: "run" };
}
