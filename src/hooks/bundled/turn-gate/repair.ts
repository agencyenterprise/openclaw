// The repair pass behind SOUL Article A11. The gate measures a promise that
// nothing armed; the repair makes the thread honest again without adding a
// message to it: the follow-up turn either starts the promised step and appends a
// "Running:" line to the message that promised it, or rewrites that promise as
// "Not started: needs <decision>". Everything here is pure text analysis; the
// lane check, the ledger and the wake live in sibling modules.
import { HEARTBEAT_TOKEN, isSilentReplyText } from "../../../auto-reply/tokens.js";
import { extractTranscriptTurns } from "../lesson-capture/transcript.js";
import { type CompiledCommitment, findCommitments } from "./commitments.js";
import type { TurnToolCall } from "./evidence.js";

/** Prefix of every repair instruction; also how the repair turn recognizes itself. */
export const REPAIR_MARKER = "Turn gate (SOUL A11):";

/** The human a blocked deliverable is escalated to. */
export const DECISION_OWNER_TAG = "<@U03EH553GBE>";

/** How many promised sentences the instruction quotes back. */
export const MAX_QUOTED_COMMITMENTS = 3;

const MAX_QUOTED_CHARS = 240;

const QUOTED_LINE_RE = /^\s*>/;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;
const NONCE_RE = /\[repair:([0-9a-f]{8,})\]/i;

/**
 * A request to execute names the execution. The three tests below run per
 * clause, not per message: "What changed? Run the tests." asks and then tells,
 * and the telling is what matters.
 */
const CLAUSE_SPLIT_RE = /[.!?;\n]+/;

const EXECUTION_INTENT_RE =
  /\b(?:run|runs|running|start|starts|starting|launch|launches|launching|build|builds|building|ship|ships|shipping|deploy|deploys|deploying|implement|implements|publish|publishes|register|registers|arm|arms|spawn|spawns|proceed|continue|go ahead|kick off|do it|fix it|fix this|fix the|test (?:it|this|them|that))\b/i;

const NEGATED_EXECUTION_RE =
  /\b(?:do not|don't|dont|never|no need to|without|instead of|will not|won't|wont|cannot|can't|should not|shouldn't|not going to)\s+(?:\w+\s+){0,2}?(?:run|start|launch|build|ship|deploy|publish|register|arm|spawn)\w*\b/i;

const INTERROGATIVE_OPENER_RE =
  /^\s*(?:how|what|why|when|where|which|who|whom|whose|can|could|should|would|will|is|are|was|were|does|did|have|has|may|might|do (?:you|we|i|they))\b/i;

/**
 * A promise the turn only quoted from a human is not the turn's own promise.
 * Blockquote lines are dropped before the commitment sentences are read, so
 * "> I'll start the harvest" never triggers a repair.
 */
export function stripQuotedLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !QUOTED_LINE_RE.test(line))
    .join("\n");
}

/**
 * Every sentence of the turn's own text that carries a commitment phrase, in
 * full. Lines split before sentences do, so a bulleted "Next:" list keeps one
 * deliverable per bullet. The text is kept whole here because the lane
 * classification and the deliverable identity are both read from it; only the
 * instruction shortens it.
 */
export function extractCommitmentSentences(
  text: string | undefined,
  compiled: CompiledCommitment[],
): string[] {
  if (!text) {
    return [];
  }
  return stripQuotedLines(text)
    .split("\n")
    .flatMap((line) => line.split(SENTENCE_SPLIT_RE))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && findCommitments(sentence, compiled).length > 0);
}

function truncateForDisplay(text: string): string {
  return text.length <= MAX_QUOTED_CHARS ? text : `${text.slice(0, MAX_QUOTED_CHARS - 1)}…`;
}

/** The nonce a repair instruction carries, when it carries one. */
export function readRepairNonce(text: string): string | undefined {
  return text.includes(REPAIR_MARKER) ? text.match(NONCE_RE)?.[1]?.toLowerCase() : undefined;
}

/**
 * The nonce of the repair this turn was started by. Only a user-role message can
 * carry it, and only the gate ever minted it, so quoting the marker back is not
 * enough to be graded as a repair — the caller still has to find the nonce in its
 * own ledger.
 */
export function findRepairNonce(messages: readonly unknown[]): string | undefined {
  for (const turn of extractTranscriptTurns(messages)) {
    const nonce = turn.role === "user" ? readRepairNonce(turn.text) : undefined;
    if (nonce) {
      return nonce;
    }
  }
  return undefined;
}

/**
 * A heartbeat or cron acknowledgement promises nothing. The test is the fork's
 * own token-only test, so a turn that merely mentions the token in prose is still
 * a real turn and still repairable.
 */
export function isHeartbeatAcknowledgement(finalAssistantText: string | undefined): boolean {
  return isSilentReplyText(finalAssistantText, HEARTBEAT_TOKEN);
}

/** One clause tells rather than asks. */
function isExecutionClause(clause: string, wasQuestion: boolean): boolean {
  const text = clause.trim();
  return (
    text.length > 0 &&
    !wasQuestion &&
    EXECUTION_INTENT_RE.test(text) &&
    !NEGATED_EXECUTION_RE.test(text) &&
    !INTERROGATIVE_OPENER_RE.test(text)
  );
}

/**
 * True when the inbound human message only asked. One clause that tells is
 * enough to make the whole message a request, so "Please do not deploy staging;
 * run the tests." is a request and "I will not run this." is not.
 */
export function isQuestionOnly(inboundText: string | undefined): boolean {
  const text = inboundText?.trim();
  if (!text) {
    return true;
  }
  const clauses = text.split(CLAUSE_SPLIT_RE);
  // A clause is a question when the separator that ended it was "?".
  const terminators = text.match(/[.!?;\n]/g) ?? [];
  return !clauses.some((clause, index) => isExecutionClause(clause, terminators[index] === "?"));
}

const MESSAGE_TOOL_NAME = "message";
const EDIT_MESSAGE_ID_KEYS = ["messageId", "message_id"];

function readEditArguments(call: TurnToolCall): Record<string, unknown> | undefined {
  if (call.name.toLowerCase() !== MESSAGE_TOOL_NAME) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(call.text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Did the repair turn edit the exact message it was sent to edit. The `message`
 * tool, the `edit` action and the ts must all match: prose that merely mentions
 * an edit, and an edit of some other message, are both not the deliverable.
 */
export function findMessageEditEvidence(
  toolCalls: readonly TurnToolCall[],
  messageId: string,
): string | undefined {
  const edited = toolCalls.some((call) => {
    const args = readEditArguments(call);
    return args?.action === "edit" && EDIT_MESSAGE_ID_KEYS.some((key) => args[key] === messageId);
  });
  return edited ? `message ${messageId} edited` : undefined;
}

export type TurnGateRepairConfig = {
  enabled: boolean;
  cooldownMinutes: number;
  maxPerDay: number;
};

export const DEFAULT_TURN_GATE_REPAIR_CONFIG: TurnGateRepairConfig = {
  enabled: true,
  cooldownMinutes: 30,
  maxPerDay: 20,
};

export type RepairPlan = {
  /** Every commitment sentence found, in full. */
  sentences: string[];
  /** The delivered Slack ts of the message that made the promise. */
  messageId: string;
  /** Ties the repair turn back to this repair; the gate mints and consumes it. */
  nonce: string;
  /** Set only when a lane already authorizes starting exactly this work. */
  laneId?: string;
  /** Why no lane authorizes it; read when `laneId` is absent. */
  blockedReason?: string;
  tagDecisionOwner: boolean;
};

/**
 * The promises the instruction quotes. When there are more than it can quote, the
 * count goes with them so the correction covers the whole message rather than the
 * three sentences it can see.
 */
function describePromises(sentences: readonly string[]): string {
  const quoted = sentences
    .slice(0, MAX_QUOTED_COMMITMENTS)
    .map((sentence) => `"${truncateForDisplay(sentence)}"`)
    .join(" ");
  return sentences.length > MAX_QUOTED_COMMITMENTS
    ? `${quoted} (and ${String(sentences.length - MAX_QUOTED_COMMITMENTS)} more promise(s) in the same message — correct all of them)`
    : quoted;
}

function describeEdit(messageId: string): string {
  return `edit message ${messageId} in place (message tool, action "edit", messageId ${messageId})`;
}

const NO_NEW_MESSAGE =
  "Do not post a new message in this thread. Do not restate the plan. " +
  "Reply HEARTBEAT_OK when the edit is done.";

function buildStartInstruction(plan: RepairPlan, laneId: string): string {
  return [
    `${REPAIR_MARKER} [repair:${plan.nonce}] your last message promised: ${describePromises(plan.sentences)}.`,
    "Nothing is running for them: no job registered, no cron armed, no worker spawned.",
    `Lane ${laneId} already authorizes exactly this work, so start that step now and nothing wider.`,
    `Then ${describeEdit(plan.messageId)}, appending one line:`,
    "Running: <what you started> (<the id the start returned: job id, cron id or pod id>).",
    NO_NEW_MESSAGE,
  ].join(" ");
}

function buildCorrectionInstruction(plan: RepairPlan): string {
  const tagClause = plan.tagDecisionOwner
    ? `Include ${DECISION_OWNER_TAG} in that same edit, unless the thread already shows a "Not started:" line.`
    : 'Do not tag anyone: this thread already carries a "Not started:" line.';
  return [
    `${REPAIR_MARKER} [repair:${plan.nonce}] your last message promised: ${describePromises(plan.sentences)}.`,
    `Nothing is running for them and no lane authorizes starting them (${plan.blockedReason ?? "no active lane covers this thread"}).`,
    "Do not start the work and do not create a lane.",
    `${describeEdit(plan.messageId)}, replacing the promise with one line:`,
    "Not started: needs <decision>.",
    "<decision> names the missing authorization only — an active lane, budget, a protocol change,",
    "or a human-owned action — never a decision you invented.",
    tagClause,
    NO_NEW_MESSAGE,
  ].join(" ");
}

/**
 * What the repair turn is told to do. A lane that already authorizes the work
 * buys one start and an appended receipt; anything else buys only an honest
 * correction of the promise. Neither branch may add a message to the thread.
 */
export function buildRepairInstruction(plan: RepairPlan): string {
  return plan.laneId ? buildStartInstruction(plan, plan.laneId) : buildCorrectionInstruction(plan);
}
