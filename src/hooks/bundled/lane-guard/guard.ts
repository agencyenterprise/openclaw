// The cancel-capable `before_tool_call` handler behind the lane-guard hook.
// A shell command that spends money or leaves the sandbox must run under an
// active lane; anything else passes untouched. Whether a refusal cancels the
// command or is only recorded depends on the kind of session it came from:
// unattended work (heartbeat, cron) is enforced, a human's thread is audited.
// Every classified command leaves one audit line, whether it ran or not.
import { formatErrorMessage } from "../../../infra/errors.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { PluginHookBeforeToolCallResult } from "../../../plugins/hook-before-tool-call-result.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
} from "../../../plugins/hook-types.js";
import {
  extractSlackChannelFromSessionKey,
  extractSlackThreadTsFromSessionKey,
} from "../../slack-thread.js";
import {
  appendJsonlRecord,
  resolveWorkspaceStatePath,
  type WorkspaceDirResolver,
} from "../../workspace-state.js";
import {
  classifyCommand,
  type CompiledLanePattern,
  compileLanePatterns,
  DEFAULT_LANE_ESTIMATES,
  DEFAULT_LANE_PATTERNS,
  type LaneActionClass,
  type LaneEstimateTable,
  type LanePatternTable,
} from "./classify.js";
import { createLaneCliRunner, type LaneCliRunner, releaseLane, reserveLane } from "./lane-cli.js";
import { type LaneThread, resolveLanesForCommand } from "./lane-lookup.js";
import { selectAuthorizingLane } from "./lane-selection.js";
import { classifyLaneSessionKind, type LaneSessionKind } from "./session-kind.js";

const log = createSubsystemLogger("hooks/lane-guard");

export const LANE_GUARD_AUDIT_FILE = "lane_guard.jsonl";

/** The model can act on this: it names the fix and the script that applies it. */
export const LANE_GUARD_BLOCK_REASON =
  "lane-guard: no active lane for this thread (or budget exceeded). " +
  "Create and activate one with scripts/lane.py, then retry.";

const EXEC_TOOL_NAMES = new Set(["exec", "bash"]);
const COMMAND_PARAM_KEYS = ["command", "cmd"];

/** Whether a refused command is cancelled, per kind of session it came from. */
export type LaneEnforcementTable = Record<LaneSessionKind, boolean>;

export type LaneGuardConfig = {
  enforce: LaneEnforcementTable;
  /** Classes cancelled in every kind unless the lane's allowed_actions name them. */
  alwaysCancel: LaneActionClass[];
  patterns: LanePatternTable;
  estimates: LaneEstimateTable;
};

/**
 * Unattended work is enforced, a human's own thread is only audited: a person
 * in a Slack thread is already the authorization the lane records stand in for,
 * so the guard observes there instead of cancelling their turn's work.
 */
export const DEFAULT_LANE_ENFORCEMENT: LaneEnforcementTable = {
  heartbeat: true,
  cron: true,
  human: false,
};

/** Leaving the sandbox for the outside world is never merely audited. */
export const DEFAULT_LANE_ALWAYS_CANCEL: LaneActionClass[] = ["publish_external"];

export const DEFAULT_LANE_GUARD_CONFIG: LaneGuardConfig = {
  enforce: DEFAULT_LANE_ENFORCEMENT,
  alwaysCancel: DEFAULT_LANE_ALWAYS_CANCEL,
  patterns: DEFAULT_LANE_PATTERNS,
  estimates: DEFAULT_LANE_ESTIMATES,
};

/** What the guard was allowed to do about a refusal, not what it decided. */
export type LaneGuardMode = "enforce" | "audit";

export type LaneGuardDecision = "allowed" | "denied" | "dry_run";

export type LaneGuardAuditRecord = {
  ts: string;
  session: string;
  kind: LaneSessionKind;
  thread: string;
  /** Every class the command charges, joined with `+` when it charges more than one. */
  class: string;
  lane: string;
  decision: LaneGuardDecision;
  mode: LaneGuardMode;
  reason: string;
};

export type LaneGuardDeps = {
  resolveWorkspaceDir: WorkspaceDirResolver;
  resolveConfig: () => LaneGuardConfig;
  createLaneCli?: (workspaceDir: string) => LaneCliRunner;
  now?: () => Date;
};

export type LaneGuard = (
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
) => Promise<PluginHookBeforeToolCallResult | undefined>;

function readExecCommand(event: PluginHookBeforeToolCallEvent): string | undefined {
  if (!EXEC_TOOL_NAMES.has(event.toolName)) {
    return undefined;
  }
  for (const key of COMMAND_PARAM_KEYS) {
    const value = event.params[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

/** Every exec call pays for the regex table, so it is recompiled only when the config changes. */
function createPatternCompiler(): (table: LanePatternTable) => CompiledLanePattern[] {
  let cachedKey: string | undefined;
  let cached: CompiledLanePattern[] = [];
  return (table) => {
    const key = JSON.stringify(table);
    if (key !== cachedKey) {
      cachedKey = key;
      cached = compileLanePatterns(table);
    }
    return cached;
  };
}

/**
 * `before_tool_call` receives a tool context, not the agent context, so the
 * thread comes from the session key the reply pipeline built it from
 * (`agent:main:slack:channel:<id>:thread:<ts>`). `PluginHookToolContext` carries
 * no `inboundMessage`. A session key without a Slack channel and thread (a DM
 * routed by user identity, a cron run, a sub-agent) resolves no thread at all,
 * and such a command has to name its lane with `# lane:<id>`.
 */
function resolveThread(sessionKey: string | undefined): LaneThread {
  return {
    channel: extractSlackChannelFromSessionKey(sessionKey),
    threadTs: extractSlackThreadTsFromSessionKey(sessionKey),
  };
}

function describeThread(thread: LaneThread): string {
  return thread.channel && thread.threadTs
    ? `${thread.channel}:${thread.threadTs}`
    : (thread.channel ?? thread.threadTs ?? "unknown");
}

type LaneOutcome = {
  lane: string;
  allowed: boolean;
  reason: string;
  /** Classes `lane.py` answered for with an explicit allow, which is what alwaysCancel needs. */
  allowedClasses: LaneActionClass[];
};

type LaneBooking = {
  actionClass: LaneActionClass;
  amountUsd: number;
};

type AuthorizeParams = {
  command: string;
  actionClasses: LaneActionClass[];
  estimates: LaneEstimateTable;
  enforce: boolean;
  thread: LaneThread;
  workspaceDir: string;
  run: LaneCliRunner;
  worker: string;
};

/** Give back what a partly booked command already reserved. */
async function rollBack(
  params: AuthorizeParams,
  laneId: string,
  booked: LaneBooking[],
): Promise<void> {
  for (const booking of booked) {
    const failure = await releaseLane(params.run, {
      laneId,
      amountUsd: booking.amountUsd,
      worker: params.worker,
      note: `lane-guard rollback for ${booking.actionClass}`,
    });
    if (failure) {
      log.error(`lane-guard: rollback of ${booking.actionClass} on lane ${laneId}: ${failure}`);
    }
  }
}

/**
 * Book the estimate for every positive-cost class. A reserve that fails is a
 * refusal, not a warning: lane.py re-checks the ceiling under its own lock, so a
 * failure here is how a second agent racing for the same budget finds out it lost.
 */
async function reserveEveryClass(
  params: AuthorizeParams,
  laneId: string,
): Promise<string | undefined> {
  const booked: LaneBooking[] = [];
  for (const actionClass of params.actionClasses) {
    // lane.py rejects a non-positive reserve, so a zero-cost class books nothing.
    const amountUsd = params.estimates[actionClass];
    if (amountUsd <= 0) {
      continue;
    }
    const failure = await reserveLane(params.run, {
      laneId,
      amountUsd,
      worker: params.worker,
      note: `lane-guard estimate for ${actionClass}`,
    });
    if (failure) {
      await rollBack(params, laneId, booked);
      return failure;
    }
    booked.push({ actionClass, amountUsd });
  }
  return undefined;
}

async function authorize(params: AuthorizeParams): Promise<LaneOutcome> {
  const laneIds = await resolveLanesForCommand({
    command: params.command,
    thread: params.thread,
    workspaceDir: params.workspaceDir,
    run: params.run,
  });
  // Several lanes can cover one thread, so the lane charged is the one that
  // allows every class, not whichever lane `lane.py list` happened to sort first.
  const selection = await selectAuthorizingLane({
    laneIds,
    actionClasses: params.actionClasses,
    estimates: params.estimates,
    run: params.run,
  });
  if (!selection) {
    return {
      lane: "",
      allowed: false,
      allowedClasses: [],
      reason: `no active lane authorized in ${describeThread(params.thread)} (no lane origin, permalink thread_ts, or go message resolves to it)`,
    };
  }
  if (!selection.allowed) {
    // The classes the lane did allow are still carried: a refusal elsewhere in a
    // chained command is not the lane refusing an alwaysCancel class it allows.
    return {
      lane: selection.laneId,
      allowed: false,
      reason: selection.reason,
      allowedClasses: selection.allowedClasses,
    };
  }
  // Auditing must not spend: a kind the operator is only observing asks the same
  // questions and books nothing.
  if (!params.enforce) {
    return {
      lane: selection.laneId,
      allowed: true,
      reason: `${selection.reason}; audit mode reserved nothing`,
      allowedClasses: selection.allowedClasses,
    };
  }
  const failure = await reserveEveryClass(params, selection.laneId);
  return failure
    ? {
        lane: selection.laneId,
        allowed: false,
        reason: `reserve refused: ${failure}`,
        allowedClasses: selection.allowedClasses,
      }
    : {
        lane: selection.laneId,
        allowed: true,
        reason: selection.reason,
        allowedClasses: selection.allowedClasses,
      };
}

/**
 * The classes that force a cancel whatever the session kind: an alwaysCancel
 * class the lane did not explicitly allow. A missing lane, a denial of that
 * class, and a broken check for it all leave it unallowed, so all three cancel.
 * A refusal of some *other* class does not, because the lane did answer for
 * this one — the enforced kinds cancel that command on their own.
 */
function unauthorizedAlwaysCancel(
  actionClasses: LaneActionClass[],
  alwaysCancel: LaneActionClass[],
  outcome: LaneOutcome,
): LaneActionClass[] {
  const gated = new Set(alwaysCancel);
  return actionClasses.filter(
    (actionClass) => gated.has(actionClass) && !outcome.allowedClasses.includes(actionClass),
  );
}

export function createLaneGuard(deps: LaneGuardDeps): LaneGuard {
  const now = deps.now ?? (() => new Date());
  const createLaneCli = deps.createLaneCli ?? createLaneCliRunner;
  const compilePatterns = createPatternCompiler();

  return async (event, ctx) => {
    const command = readExecCommand(event);
    if (!command) {
      return undefined;
    }
    const config = deps.resolveConfig();
    const actionClasses = classifyCommand(command, compilePatterns(config.patterns));
    if (actionClasses.length === 0) {
      return undefined;
    }
    const kind = classifyLaneSessionKind(ctx.sessionKey);
    const enforce = config.enforce[kind];
    const mode: LaneGuardMode = enforce ? "enforce" : "audit";
    const thread = resolveThread(ctx.sessionKey);
    const worker = ctx.sessionKey ?? "unknown";
    const workspaceDir = deps.resolveWorkspaceDir(ctx.sessionKey);
    let outcome: LaneOutcome;
    try {
      outcome = await authorize({
        command,
        actionClasses,
        estimates: config.estimates,
        enforce,
        thread,
        workspaceDir,
        run: createLaneCli(workspaceDir),
        worker,
      });
    } catch (err) {
      // A lookup that failed is not a lane that allows: an unanswered question
      // never becomes permission.
      const reason = `lane lookup failed: ${formatErrorMessage(err)}`;
      log.error(`lane-guard: ${reason}`);
      outcome = { lane: "", allowed: false, reason, allowedClasses: [] };
    }
    const forced = unauthorizedAlwaysCancel(actionClasses, config.alwaysCancel, outcome);
    const blocked = !outcome.allowed && (enforce || forced.length > 0);
    const decision: LaneGuardDecision = outcome.allowed
      ? "allowed"
      : blocked
        ? "denied"
        : "dry_run";
    const reason =
      forced.length > 0
        ? `${outcome.reason}; ${forced.join("+")} is always gated: only a lane whose allowed_actions include it may run this`
        : outcome.reason;
    await writeAuditLine(workspaceDir, {
      ts: now().toISOString(),
      session: worker,
      kind,
      thread: describeThread(thread),
      class: actionClasses.join("+"),
      lane: outcome.lane,
      decision,
      mode,
      reason,
    });
    if (!outcome.allowed) {
      log.warn(
        `lane-guard: ${decision} ${actionClasses.join("+")} command in ${describeThread(thread)} (${kind}/${mode}): ${reason}`,
      );
    }
    return blocked
      ? { block: true, blockReason: `${LANE_GUARD_BLOCK_REASON} Detail: ${reason}` }
      : undefined;
  };
}

/**
 * A state-write failure must not decide the tool call. `before_tool_call` is
 * fail-closed, so letting a full disk or a stuck lock throw would block every
 * classified command — including in audit mode, which promises never to cancel.
 */
async function writeAuditLine(workspaceDir: string, record: LaneGuardAuditRecord): Promise<void> {
  try {
    await appendJsonlRecord(resolveWorkspaceStatePath(workspaceDir, LANE_GUARD_AUDIT_FILE), record);
  } catch (err) {
    log.error(`lane-guard: audit line lost (${record.decision}): ${formatErrorMessage(err)}`);
  }
}
