// Process seam for `<workspace>/scripts/lane.py`. The lane records are the
// authority on authorization and budget, so the guard runs the same CLI a human
// runs instead of reimplementing its rules. The runner is injected, so tests
// never spawn python. Every invocation pins LANE_STATE_DIR to the workspace the
// hook resolved, so the guard and the script always read the same records.
import path from "node:path";
import { runCommandBuffered } from "../../../process/exec.js";

const LANE_SCRIPT = "scripts/lane.py";
const LANE_CLI_TIMEOUT_MS = 15_000;
const DENIED_EXIT_CODE = 2;

export type LaneCliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type LaneCliRunner = (args: string[]) => Promise<LaneCliResult>;

export function resolveLaneStateDir(workspaceDir: string): string {
  return path.join(workspaceDir, "state", "lanes");
}

export function createLaneCliRunner(workspaceDir: string): LaneCliRunner {
  return async (args) => {
    const result = await runCommandBuffered(["python3", LANE_SCRIPT, ...args], {
      cwd: workspaceDir,
      env: { LANE_STATE_DIR: resolveLaneStateDir(workspaceDir) },
      timeoutMs: LANE_CLI_TIMEOUT_MS,
    });
    return {
      code: result.code,
      stdout: result.stdout.toString("utf-8"),
      stderr: result.stderr.toString("utf-8"),
    };
  };
}

function describeFailure(result: LaneCliResult, args: string[]): string {
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  return `lane.py ${args[0]} failed (exit ${result.code ?? "signal"}): ${detail}`;
}

/** `--json` was asked for, so an exit that reports success unreadably reports nothing. */
function describeUnreadable(result: LaneCliResult, args: string[]): string {
  const detail = result.stdout.trim() || result.stderr.trim() || "no output";
  return `lane.py ${args[0]} exited 0 without a readable --json answer: ${detail}`;
}

/** The JSON object `--json` promises, or undefined when stdout is not one. */
function readJsonPayload(result: LaneCliResult): Record<string, unknown> | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    // Not swallowed: every caller turns a missing payload into its own loud failure.
    return undefined;
  }
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function readReason(payload: Record<string, unknown> | undefined): string | undefined {
  return typeof payload?.reason === "string" && payload.reason ? payload.reason : undefined;
}

/**
 * The one refusal that says nothing about this thread's authorization: the lane
 * is simply not scoped to the action. It is the only code a caller may pass over
 * on its way to another lane.
 */
export const LANE_ACTION_NOT_ALLOWED = "action_not_allowed";

/** Every `code` this build understands. `lane.py` names one on each check. */
const LANE_CHECK_CODES = [
  "allowed",
  "not_active",
  "expired",
  "unknown_action",
  LANE_ACTION_NOT_ALLOWED,
  "bad_amount",
  "over_ceiling",
  "corrupt_record",
] as const;

export type LaneCheckCode = (typeof LANE_CHECK_CODES)[number];

function readCheckCode(payload: Record<string, unknown> | undefined): LaneCheckCode | undefined {
  const code = payload?.code;
  return typeof code === "string" && (LANE_CHECK_CODES as readonly string[]).includes(code)
    ? (code as LaneCheckCode)
    : undefined;
}

/**
 * What `lane.py check` answered. `unanswered` is not a denial: the question was
 * never put to the lane, so nothing may be built on the answer it did not give.
 */
export type LaneCheckVerdict = "allowed" | "denied" | "unanswered";

export type LaneCheck = {
  verdict: LaneCheckVerdict;
  reason: string;
  /**
   * Which refusal this was, when `lane.py` named one this build knows. Absent
   * when the answer carried no code, an unrecognised one, or no readable stdout
   * at all — argparse refuses a bad `--action` with the same exit 2, printing
   * usage to stderr and nothing to stdout — and every one of those is a hard
   * refusal a caller must not pass over.
   */
  code?: LaneCheckCode;
};

/**
 * `lane.py check` exits 0 when the action is allowed and 2 when it is refused.
 * Any other exit is a broken check, reported as its own verdict rather than as a
 * refusal: a spend must never proceed on an unanswered question, and a caller
 * must be able to tell a lane that said no from a lane it could not ask. Exit 0
 * is only an allow when it comes with the answer `--json` promised: a wrapper
 * bug or a stray `sys.exit(0)` must not read as permission.
 */
export async function checkLane(
  run: LaneCliRunner,
  params: { laneId: string; action: string; amountUsd: number },
): Promise<LaneCheck> {
  const args = [
    "check",
    params.laneId,
    "--action",
    params.action,
    "--amount",
    String(params.amountUsd),
    "--json",
  ];
  const result = await run(args);
  const payload = readJsonPayload(result);
  const reason = readReason(payload);
  if (result.code === 0) {
    return payload?.allowed === true && reason
      ? { verdict: "allowed", reason, code: "allowed" }
      : { verdict: "unanswered", reason: describeUnreadable(result, args) };
  }
  if (result.code === DENIED_EXIT_CODE) {
    return {
      verdict: "denied",
      reason: reason ?? (result.stderr.trim() || "denied"),
      code: readCheckCode(payload),
    };
  }
  return { verdict: "unanswered", reason: describeFailure(result, args) };
}

export type LaneBudgetEntry = {
  laneId: string;
  amountUsd: number;
  worker: string;
  note: string;
};

function runBudgetCommand(
  run: LaneCliRunner,
  command: "reserve" | "release",
  params: LaneBudgetEntry,
): Promise<string | undefined> {
  const args = [
    command,
    params.laneId,
    String(params.amountUsd),
    "--worker",
    params.worker,
    "--note",
    params.note,
    "--json",
  ];
  return run(args).then((result) => {
    if (result.code !== 0) {
      return describeFailure(result, args);
    }
    // A booking that cannot be read back is not a booking: the command would run
    // with nothing durable recorded against the lane.
    return readJsonPayload(result) ? undefined : describeUnreadable(result, args);
  });
}

/** Reserve the estimate against the lane. Returns the failure reason, or undefined on success. */
export function reserveLane(
  run: LaneCliRunner,
  params: LaneBudgetEntry,
): Promise<string | undefined> {
  return runBudgetCommand(run, "reserve", params);
}

/** Give a reservation back, used to roll back a partly booked command. */
export function releaseLane(
  run: LaneCliRunner,
  params: LaneBudgetEntry,
): Promise<string | undefined> {
  return runBudgetCommand(run, "release", params);
}

type LaneSummary = { lane_id?: unknown };

/** Ids of every lane currently in state `active`. Throws when the listing fails. */
export async function listActiveLaneIds(run: LaneCliRunner): Promise<string[]> {
  const args = ["list", "--state", "active", "--json"];
  const result = await run(args);
  if (result.code !== 0) {
    throw new Error(describeFailure(result, args));
  }
  const rows = JSON.parse(result.stdout) as LaneSummary[];
  return rows.flatMap((row) => (typeof row.lane_id === "string" ? [row.lane_id] : []));
}
