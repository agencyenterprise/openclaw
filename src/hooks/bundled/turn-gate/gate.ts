// The `agent_end` handler behind the turn-gate hook. It decides one thing: did
// the turn that promised work leave anything behind that actually does it. An
// unbacked promise is parked for repair, and the repair itself runs once delivery
// has settled, because only then does the message that made the promise have a ts.
import { formatErrorMessage } from "../../../infra/errors.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type {
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
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
import { extractTranscriptTurns, lastTurn } from "../lesson-capture/transcript.js";
import { compileCommitments, DEFAULT_COMMITMENT_PHRASES, findCommitments } from "./commitments.js";
import {
  DEFAULT_COMMAND_MARKERS,
  extractToolCalls,
  findJobsFileEvidence,
  findToolCallEvidence,
} from "./evidence.js";
import type { LaneAuthorizer } from "./lane-authorization.js";
import {
  noteDeliveredMessage,
  rememberRepairIntent,
  type RepairIntent,
  type RepairRunner,
} from "./pending-repair.js";
import { claimRepair, consumeRepairNonce, releaseRepair, repairKey } from "./repair-ledger.js";
import {
  buildRepairInstruction,
  DEFAULT_TURN_GATE_REPAIR_CONFIG,
  extractCommitmentSentences,
  findMessageEditEvidence,
  findRepairNonce,
  isHeartbeatAcknowledgement,
  isQuestionOnly,
  type TurnGateRepairConfig,
} from "./repair.js";
import { sliceCurrentTurn, type TurnSlice } from "./turn.js";
import type { RepairTurnSender } from "./wake.js";

const log = createSubsystemLogger("hooks/turn-gate");

export const TURN_GATE_FILE = "turn_gate.jsonl";

export type TurnGateConfig = {
  phrases: string[];
  commandMarkers: string[];
  repair: TurnGateRepairConfig;
};

export const DEFAULT_TURN_GATE_CONFIG: TurnGateConfig = {
  phrases: DEFAULT_COMMITMENT_PHRASES,
  commandMarkers: DEFAULT_COMMAND_MARKERS,
  repair: DEFAULT_TURN_GATE_REPAIR_CONFIG,
};

export type TurnGateVerdict = "backed" | "unbacked" | "none" | "repaired" | "unbacked_after_repair";

export type TurnGateRecord = {
  ts: string;
  session: string;
  thread: string;
  commitments: string[];
  evidence: string[];
  verdict: TurnGateVerdict;
  /** Outcome of the repair decision, present only when one was reached. */
  repair?: string;
};

export type TurnGateDeps = {
  resolveWorkspaceDir: WorkspaceDirResolver;
  resolveConfig: () => TurnGateConfig;
  now?: () => Date;
  authorizeLane?: LaneAuthorizer;
  sendRepair?: RepairTurnSender;
  /** How long after the last delivered message the repair runs. Tests set 0. */
  settleMs?: number;
};

export type TurnGateHandler = (
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
) => Promise<void>;

/**
 * `agent_end` carries the inbound message the reply pipeline recorded; the
 * session key is the fallback for runs that started without one (cron, ACP).
 */
function describeThread(ctx: PluginHookAgentContext): string {
  const channel = ctx.inboundMessage?.channel ?? extractSlackChannelFromSessionKey(ctx.sessionKey);
  const threadTs =
    ctx.inboundMessage?.threadTs ?? extractSlackThreadTsFromSessionKey(ctx.sessionKey);
  if (channel && threadTs) {
    return `${channel}:${threadTs}`;
  }
  return channel ?? threadTs ?? "unknown";
}

/**
 * The turn's own first message timestamp is authoritative. `durationMs` counted
 * back from now is the fallback for transcripts without timestamps; when there
 * is neither, the window is unknown, not zero.
 */
function resolveTurnStart(
  turn: TurnSlice,
  event: PluginHookAgentEndEvent,
  now: Date,
): Date | undefined {
  if (turn.startedAt) {
    return turn.startedAt;
  }
  return typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
    ? new Date(now.getTime() - event.durationMs)
    : undefined;
}

/** Every reason a repair is not parked, in the order the gate asks them. */
type RepairRefusal =
  | "disabled"
  | "no-inbound-message"
  | "heartbeat-ack"
  | "promise-only-quoted"
  | "question-without-lane";

/**
 * A repair turn is graded on what it did, not on what it said: it was told to
 * edit the message that made the promise, so the edit is the deliverable. What it
 * armed on the way stays visible in `evidence`.
 */
async function gradeRepairTurn(params: {
  turn: TurnSlice;
  nonce: string;
  workspaceDir: string;
  sessionKey: string | undefined;
  evidence: string[];
  now: Date;
}): Promise<{ verdict: TurnGateVerdict; evidence: string[] } | undefined> {
  if (!params.sessionKey) {
    return undefined;
  }
  const messageId = await consumeRepairNonce({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    nonce: params.nonce,
    now: params.now,
  });
  // A turn quoting the marker without a nonce this gate minted is an ordinary turn.
  if (!messageId) {
    return undefined;
  }
  const edit = findMessageEditEvidence(extractToolCalls(params.turn.messages), messageId);
  return {
    verdict: edit ? "repaired" : "unbacked_after_repair",
    evidence: edit ? [...params.evidence, edit] : params.evidence,
  };
}

export function createTurnGateHandler(deps: TurnGateDeps): TurnGateHandler {
  const now = deps.now ?? (() => new Date());

  return async (event, ctx) => {
    // The gate is an observer on the turn-end path: a failure here must never
    // surface as a failed turn, so it is logged and swallowed deliberately.
    try {
      const workspaceDir = ctx.workspaceDir ?? deps.resolveWorkspaceDir(ctx.sessionKey);
      const config = deps.resolveConfig();
      const at = now();
      const turn = sliceCurrentTurn(event.messages);
      const finalAssistantText = lastTurn(extractTranscriptTurns(turn.messages), "assistant")?.text;
      const compiled = compileCommitments(config.phrases);
      const commitments = findCommitments(finalAssistantText, compiled);
      const toolEvidence = findToolCallEvidence(
        extractToolCalls(turn.messages),
        config.commandMarkers,
      );
      const jobsEvidence = await findJobsFileEvidence(
        workspaceDir,
        resolveTurnStart(turn, event, at),
      );
      let evidence = jobsEvidence ? [...toolEvidence, jobsEvidence] : toolEvidence;

      const nonce = findRepairNonce(turn.messages);
      const graded = nonce
        ? await gradeRepairTurn({
            turn,
            nonce,
            workspaceDir,
            sessionKey: ctx.sessionKey,
            evidence,
            now: at,
          })
        : undefined;
      if (graded) {
        evidence = graded.evidence;
      }
      const verdict: TurnGateVerdict =
        graded?.verdict ??
        (commitments.length === 0 ? "none" : evidence.length > 0 ? "backed" : "unbacked");

      const record: TurnGateRecord = {
        ts: at.toISOString(),
        session: ctx.sessionKey ?? "unknown",
        thread: describeThread(ctx),
        commitments,
        evidence,
        verdict,
      };
      const sentences =
        verdict === "unbacked" ? extractCommitmentSentences(finalAssistantText, compiled) : [];
      const refusal =
        verdict === "unbacked"
          ? refuseRepair({ deps, ctx, finalAssistantText, sentences, config: config.repair })
          : undefined;
      if (verdict === "unbacked") {
        record.repair = refusal ? `skipped:${refusal}` : "pending-delivery";
        log.warn(
          `turn-gate: unbacked commitment [${commitments.join(", ")}] in ${record.thread} (repair ${record.repair})`,
        );
      }
      if (verdict === "unbacked_after_repair") {
        log.warn(`turn-gate: repair armed nothing in ${record.thread}`);
      }
      // The measurement is written before the repair is armed, so a repair can
      // never run against a turn that has no record of why.
      await appendJsonlRecord(resolveWorkspaceStatePath(workspaceDir, TURN_GATE_FILE), record);
      if (verdict === "unbacked" && !refusal) {
        parkRepair({ ctx, record, sentences, config: config.repair, workspaceDir });
      }
    } catch (err) {
      log.error(`turn-gate: failed to record the turn: ${formatErrorMessage(err)}`);
    }
  };
}

/**
 * Park the repair for delivery. Everything decided here is cheap and local; the
 * lane check and the wake wait until `message:sent` supplies the ts of the
 * message that has to be edited.
 */
function parkRepair(params: {
  ctx: PluginHookAgentContext;
  record: TurnGateRecord;
  sentences: string[];
  config: TurnGateRepairConfig;
  workspaceDir: string;
}): void {
  const inbound = params.ctx.inboundMessage;
  const sessionKey = params.ctx.sessionKey ?? "";
  rememberRepairIntent({
    sessionKey,
    thread: params.record.thread,
    channel: inbound?.channel ?? extractSlackChannelFromSessionKey(sessionKey),
    threadTs: inbound?.threadTs ?? extractSlackThreadTsFromSessionKey(sessionKey),
    workspaceDir: params.workspaceDir,
    inboundMessageId: inbound?.messageId ?? "",
    inboundText: inbound?.text,
    sentences: params.sentences,
    config: params.config,
  });
}

function refuseRepair(params: {
  deps: TurnGateDeps;
  ctx: PluginHookAgentContext;
  finalAssistantText: string | undefined;
  sentences: string[];
  config: TurnGateRepairConfig;
}): RepairRefusal | undefined {
  if (!params.config.enabled || !params.deps.authorizeLane || !params.deps.sendRepair) {
    return "disabled";
  }
  // Without the message that asked, the repair has no "once per deliverable"
  // identity and no human request to read; cron and ACP runs land here.
  if (!params.ctx.sessionKey || !params.ctx.inboundMessage?.messageId) {
    return "no-inbound-message";
  }
  if (isHeartbeatAcknowledgement(params.finalAssistantText)) {
    return "heartbeat-ack";
  }
  if (params.sentences.length === 0) {
    return "promise-only-quoted";
  }
  return undefined;
}

/**
 * The repair itself: ask the lane, claim the one attempt this deliverable gets,
 * and queue the turn. The claim is given back when the turn cannot be queued, so
 * a failed wake never marks a promise repaired forever.
 */
function createRepairRunner(deps: TurnGateDeps): RepairRunner {
  const now = deps.now ?? (() => new Date());
  return async ({ intent, messageId }) => {
    const { authorizeLane, sendRepair } = deps;
    if (!authorizeLane || !sendRepair) {
      return "skipped:disabled";
    }
    const at = now();
    const promiseText = intent.sentences.join("\n");
    const lane = await authorizeLane({
      workspaceDir: intent.workspaceDir,
      thread: { channel: intent.channel, threadTs: intent.threadTs },
      promiseText,
    });
    // An answer to a question may end in a plan nobody asked to be executed. Only
    // a thread that already has a lane is treated as standing execution intent.
    if (isQuestionOnly(intent.inboundText) && !lane.laneId) {
      return "skipped:question-without-lane";
    }
    const key = repairKey(intent.inboundMessageId, intent.sentences);
    const claim = await claimRepair({
      workspaceDir: intent.workspaceDir,
      sessionKey: intent.sessionKey,
      thread: intent.thread,
      key,
      messageId,
      config: intent.config,
      now: at,
    });
    if (!claim.granted) {
      return `skipped:${claim.reason}`;
    }
    const branch = lane.authorized && lane.laneId ? `start:${lane.laneId}` : "correct";
    const instruction = buildRepairInstruction({
      sentences: intent.sentences,
      messageId,
      nonce: claim.nonce,
      ...(lane.authorized && lane.laneId
        ? { laneId: lane.laneId }
        : { blockedReason: lane.reason }),
      tagDecisionOwner: claim.tagDecisionOwner,
    });
    if (sendRepair({ sessionKey: intent.sessionKey, text: instruction })) {
      return `sent:${branch}`;
    }
    await releaseRepair({
      workspaceDir: intent.workspaceDir,
      thread: intent.thread,
      key,
      nonce: claim.nonce,
      tagged: claim.tagDecisionOwner,
      now: at,
    });
    return `enqueue-refused:${branch}`;
  };
}

/**
 * The `message:sent` side. Each delivered message restarts the settle window, so
 * one turn produces one repair aimed at the last message it delivered.
 */
export function createTurnGateDelivery(
  deps: TurnGateDeps,
): (params: { sessionKey: string; messageId: string }) => Promise<string | undefined> {
  const runRepair = createRepairRunner(deps);
  const run: RepairRunner = async (params) => {
    try {
      const note = await runRepair(params);
      log.info(`turn-gate: repair for ${params.intent.thread} on ${params.messageId}: ${note}`);
      return note;
    } catch (err) {
      // A repair that cannot run must be visible: the promise stays unrepaired
      // and the record already says the gate intended to repair it.
      const note = `failed:${formatErrorMessage(err)}`;
      log.error(`turn-gate: repair for ${params.intent.thread} ${note}`);
      return note;
    }
  };
  return ({ sessionKey, messageId }) =>
    noteDeliveredMessage({
      sessionKey,
      messageId,
      run,
      ...(deps.settleMs === undefined ? {} : { settleMs: deps.settleMs }),
    });
}

export type { RepairIntent };
