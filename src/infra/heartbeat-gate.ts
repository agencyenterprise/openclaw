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

/**
 * Outer timeout for the whole gate command.
 *
 * Must stay above the gate script's own inner timeout (`DEFAULT_TIMEOUT_S = 90` in
 * scripts/heartbeat_gate.py) plus shutdown grace, so the script gets to report
 * "undecided" instead of being killed by this timer before it can decide.
 */
export const DEFAULT_HEARTBEAT_GATE_TIMEOUT_MS = 120_000;

const HEARTBEAT_GATE_SUMMARY_MAX_CHARS = 200;
const HEARTBEAT_GATE_MAX_OUTPUT_BYTES = 64 * 1024;

/** Contract with the gate command: its last stdout line is this verdict object. */
const HEARTBEAT_GATE_VERDICT_NAME = "heartbeat";
const HEARTBEAT_GATE_VERDICT_VERSION = 1;

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

/**
 * The gate's own verdict, or undefined when it did not state one this run.
 *
 * The exit code alone is not evidence: any wrong, obsolete or half-installed
 * executable can exit 3. A skip is only honored when the gate also names itself
 * and its contract version on its last stdout line.
 */
function resolveGateVerdict(stdout: string): "skip" | "run" | undefined {
  const lastLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
  if (!lastLine) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const verdictLine = parsed as Record<string, unknown>;
  if (
    verdictLine.gate !== HEARTBEAT_GATE_VERDICT_NAME ||
    verdictLine.version !== HEARTBEAT_GATE_VERDICT_VERSION
  ) {
    return undefined;
  }
  return verdictLine.verdict === "skip" || verdictLine.verdict === "run"
    ? verdictLine.verdict
    : undefined;
}

function withSummary(message: string, summary: string): string {
  return summary ? `${message}: ${summary}` : message;
}

/**
 * Decide whether a scheduled heartbeat turn is worth running.
 *
 * The gate command is the cheap deterministic half of the heartbeat: exit 3 plus a
 * `"verdict": "skip"` line means "no work, skip the model turn", exit 0 means "run it".
 * Anything else (unexpected exit code, exit 3 without the verdict line, timeout, spawn
 * failure) fails loud and still runs the turn, so a broken gate can never silence the agent.
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
    const verdict = resolveGateVerdict(result.stdout);
    if (verdict !== "skip") {
      log.error(
        withSummary(
          `heartbeat gate exited ${HEARTBEAT_GATE_SKIP_EXIT_CODE} without a skip verdict line, running the turn anyway`,
          summary,
        ),
        { command, verdict },
      );
      return { action: "run" };
    }
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
