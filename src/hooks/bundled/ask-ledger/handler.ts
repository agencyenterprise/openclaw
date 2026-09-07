/**
 * Ask Ledger hook — Constitution Article 3 (Initiative).
 *
 * Every direct ask (DM, mention, or reply in a thread the bot is in) is written
 * to `<workspace>/state/asks.jsonl` on `message:received`, before the model
 * runs, so an ask that never gets a reply still leaves a trace. The bot's own
 * `message:sent` into the same channel + thread appends an `answered` line for the
 * matching pending asks — but only when the platform confirmed the send with a
 * message id — and `message:deleted` writes a tombstone. The ledger is append-only and shared with `scripts/asks.py` (which
 * adds `acknowledged` lines); every write happens under the cross-process file
 * lock.
 *
 * One obligation per source message. The id is `<channel>:<ts>`, so a replay of
 * the same message is idempotent, and `source_message_id` catches the same
 * message arriving under a new id (an edit, a redelivery): that record is an
 * alias of the ask that already owns the obligation. Slack also replays a
 * message the user deleted during an outage next to the user's live re-post —
 * two sources, one question — so an ask repeating a recent one from the same
 * user in the same channel is recorded as a `duplicate` of it.
 *
 * Nothing superseded gets a turn: a `before_dispatch` core hook stops it, since
 * the `message:received` internal hook is fire-and-forget and cannot.
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { hasCoreHook, registerCoreHook } from "../../../plugins/core-hooks.js";
import type { PluginHookHandlerMap } from "../../../plugins/hook-types.js";
import type { HookHandler } from "../../hooks.js";
import type {
  InternalHookEvent,
  MessageDeletedHookContext,
  MessageReceivedHookContext,
  MessageSentHookContext,
} from "../../internal-hooks.js";
import {
  buildAskId,
  extractSlackChannelFromSessionKey,
  extractSlackThreadTsFromSessionKey,
  isSlackDirectMessageChannel,
  isSlackTs,
  normalizeSlackTarget,
} from "../../slack-thread.js";
import {
  resolveHookWorkspaceDir,
  resolveWorkspaceStatePath,
  type WorkspaceDirResolver,
} from "../../workspace-state.js";
import {
  type AskTurnVerdict,
  buildTurnKey,
  InboundTurnGate,
  NO_SUPPRESSION,
} from "./inbound-turn-gate.js";
import {
  AskLedger,
  ASK_LEDGER_FILE,
  buildSourceMessageId,
  type AskOpenRecord,
  type AskReply,
} from "./ledger.js";

const log = createSubsystemLogger("hooks/ask-ledger");

export const ASK_LEDGER_PLUGIN_ID = "fractal-ask-ledger";
/** The only inbound plugin hook whose `{ handled: true }` returns before the agent turn. */
export const ASK_LEDGER_GATE_HOOK_NAME = "before_dispatch";
/** The gate only waits for the recorder's ledger write, which runs under the file lock. */
const GATE_TIMEOUT_MS = 5_000;
const ASK_TEXT_MAX_CHARS = 300;
/**
 * Sentinel the Slack reply path sends as the message id when a threaded answer is
 * dropped because its thread parent was deleted. It mirrors
 * SLACK_PARENT_DELETED_ANSWER_TS in extensions/slack/src/message-sent-hook.ts and is
 * declared here on purpose: a bundled core hook must not import from a channel extension.
 */
const ASK_PARENT_DELETED_ANSWER_TS = "parent_deleted";
const SLACK_CHANNEL_ID = "slack";

type GateHandler = PluginHookHandlerMap[typeof ASK_LEDGER_GATE_HOOK_NAME];

type ReceivedMetadata = {
  threadId?: unknown;
  /** Ts of the original message when this delivery is an edit or a redelivery of it. */
  sourceTs?: unknown;
  senderId?: unknown;
  wasMentioned?: unknown;
  chatType?: unknown;
  senderIsBot?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readSlackTs(value: unknown): string | undefined {
  return isSlackTs(value) ? value : undefined;
}

/** An ask is a DM, a mention, or a reply inside a thread the bot already takes part in. */
function isAsk(params: {
  channel: string;
  chatType?: string;
  wasMentioned: boolean;
  threadTs?: string;
}): boolean {
  return (
    params.chatType === "direct" ||
    isSlackDirectMessageChannel(params.channel) ||
    params.wasMentioned ||
    params.threadTs !== undefined
  );
}

/** The Slack channel this event is about, from the delivery target or the session key. */
function resolveSlackChannel(
  conversationId: string | undefined,
  sessionKey: string,
): string | undefined {
  return normalizeSlackTarget(conversationId) ?? extractSlackChannelFromSessionKey(sessionKey);
}

export function buildAskRecord(event: InternalHookEvent): AskOpenRecord | undefined {
  const ctx = event.context as MessageReceivedHookContext;
  if (ctx.channelId !== SLACK_CHANNEL_ID || !isSlackTs(ctx.messageId)) {
    return undefined;
  }
  const metadata = (ctx.metadata ?? {}) as ReceivedMetadata;
  if (metadata.senderIsBot === true) {
    return undefined;
  }
  const channel = resolveSlackChannel(ctx.conversationId, event.sessionKey);
  if (!channel) {
    return undefined;
  }
  const threadTs =
    readSlackTs(metadata.threadId) ?? extractSlackThreadTsFromSessionKey(event.sessionKey);
  const ask = isAsk({
    channel,
    chatType: readString(metadata.chatType),
    wasMentioned: metadata.wasMentioned === true,
    threadTs,
  });
  if (!ask) {
    return undefined;
  }
  return {
    id: buildAskId(channel, ctx.messageId),
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    user: readString(metadata.senderId) ?? ctx.from,
    text: ctx.content.slice(0, ASK_TEXT_MAX_CHARS),
    received_at: event.timestamp.toISOString(),
    source_message_id: buildSourceMessageId({
      ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
      channel,
      ts: readSlackTs(metadata.sourceTs) ?? ctx.messageId,
    }),
    status: "open",
  };
}

/**
 * The received side of the turn identity the gate reads back on `before_dispatch`.
 * The session key is what tells the two halves of a replay apart: they are
 * byte-identical, so channel, sender and body name both turns the same.
 */
function buildReceivedTurnKey(event: InternalHookEvent, ctx: MessageReceivedHookContext): string {
  const metadata = (ctx.metadata ?? {}) as ReceivedMetadata;
  return buildTurnKey({
    channelId: ctx.channelId,
    senderId: readString(metadata.senderId),
    sessionKey: event.sessionKey,
    content: ctx.content,
  });
}

export function buildDeletedAskId(event: InternalHookEvent): string | undefined {
  const ctx = event.context as MessageDeletedHookContext;
  if (ctx.channelId !== SLACK_CHANNEL_ID || !isSlackTs(ctx.messageId)) {
    return undefined;
  }
  const channel = resolveSlackChannel(ctx.conversationId, event.sessionKey);
  return channel ? buildAskId(channel, ctx.messageId) : undefined;
}

/**
 * A real Slack ts, or the sentinel that says the answer had nowhere to go.
 *
 * The `parent_deleted` sentinel is accepted on purpose: it is the Slack reply path's
 * deliberate marker for a threaded answer whose own thread parent was deleted, so the
 * answer could not be posted anywhere. Rejecting it would leave those asks open forever.
 * Anything else — no id at all, or an id that is not a Slack ts — is not a confirmed
 * delivery and closes nothing.
 */
function readAnswerTs(messageId: string | undefined): string | undefined {
  if (isSlackTs(messageId)) {
    return messageId;
  }
  return messageId === ASK_PARENT_DELETED_ANSWER_TS ? messageId : undefined;
}

/**
 * The reply a `message:sent` stands for, or `undefined` when it closes nothing.
 *
 * `ctx.success` alone is not delivery: the reply path reports success for a send the
 * provider never acknowledged with a message id, and such a send used to close every
 * pending ask in the thread. A confirmed platform ts (or the `parent_deleted` sentinel)
 * is now required.
 *
 * Channel: `normalizeSlackTarget(ctx.to)` wins over the session key, so a send addressed
 * to another channel closes that channel's asks and never the session channel's.
 *
 * Thread: `MessageSentHookContext` carries no thread field, so the reply thread can only
 * come from the session key. The limitation that leaves: a send made under a session key
 * with no `thread:<ts>` part reads as top-level even if it went into a thread, and is
 * matched against the newest pending top-level ask in the channel instead.
 */
function buildReplyFromSentEvent(event: InternalHookEvent): AskReply | undefined {
  const ctx = event.context as MessageSentHookContext;
  if (ctx.channelId !== SLACK_CHANNEL_ID || !ctx.success) {
    return undefined;
  }
  const channel = resolveSlackChannel(ctx.to, event.sessionKey);
  if (!channel) {
    return undefined;
  }
  const answerTs = readAnswerTs(ctx.messageId);
  if (!answerTs) {
    log.warn(
      "ask-ledger: ignoring a message:sent with no platform message id; nothing was marked answered",
      { channel, sessionKey: event.sessionKey },
    );
    return undefined;
  }
  const threadTs = extractSlackThreadTsFromSessionKey(event.sessionKey);
  return {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    answer_ts: answerTs,
    answered_at: event.timestamp.toISOString(),
  };
}

export function createAskLedgerHandler(deps: {
  resolveWorkspaceDir: WorkspaceDirResolver;
  gate: InboundTurnGate;
}): HookHandler {
  const ledgerFor = (sessionKey: string): AskLedger => {
    const filePath = resolveWorkspaceStatePath(
      deps.resolveWorkspaceDir(sessionKey),
      ASK_LEDGER_FILE,
    );
    return new AskLedger(filePath, (lines) =>
      log.warn(`ask-ledger: skipped malformed lines ${lines.join(",")} in ${filePath}`),
    );
  };

  const recordAsk = async (sessionKey: string, ask: AskOpenRecord): Promise<AskTurnVerdict> => {
    const outcome = await ledgerFor(sessionKey).recordInboundAsk(ask);
    const superseded = outcome.supersededBy;
    if (superseded) {
      const reason = `${superseded.kind} of ${superseded.askId}`;
      log.warn(`ask-ledger: ask ${ask.id} is a ${reason}; suppressing its turn`);
      return { suppress: true, reason };
    }
    if (outcome.appended) {
      log.info(`ask-ledger: recorded ask ${ask.id} from ${ask.user}`);
    }
    return NO_SUPPRESSION;
  };

  const handleReceived = (event: InternalHookEvent): Promise<void> => {
    const ask = buildAskRecord(event);
    if (!ask) {
      return Promise.resolve();
    }
    // Claim the turn before awaiting the ledger: this hook is fire-and-forget, so
    // `before_dispatch` can run while the write is still in flight. The gate gets a
    // promise that never rejects; the caller still sees a write that failed.
    const verdict = recordAsk(event.sessionKey, ask);
    deps.gate.track({
      turnKey: buildReceivedTurnKey(event, event.context as MessageReceivedHookContext),
      askId: ask.id,
      verdict: verdict.catch(() => NO_SUPPRESSION),
    });
    return verdict.then(() => undefined);
  };

  const recordDeletion = async (event: InternalHookEvent): Promise<void> => {
    const askId = buildDeletedAskId(event);
    if (!askId) {
      return;
    }
    // Stop the turn first: a deletion that lands while the message is still being
    // dispatched must not produce an answer to a message that no longer exists.
    if (deps.gate.stop(askId, `source message of ${askId} was deleted`)) {
      log.warn(`ask-ledger: stopped the in-flight turn for deleted ask ${askId}`);
    }
    if (await ledgerFor(event.sessionKey).markDeleted(askId, event.timestamp.toISOString())) {
      log.info(`ask-ledger: tombstoned deleted ask ${askId}`);
    }
  };

  const recordReply = async (event: InternalHookEvent) => {
    const reply = buildReplyFromSentEvent(event);
    if (!reply) {
      return;
    }
    const answered = await ledgerFor(event.sessionKey).markAnswered(reply);
    if (answered.length > 0) {
      log.info(`ask-ledger: answered ${answered.join(", ")}`);
    }
  };

  return async (event) => {
    if (event.type !== "message") {
      return;
    }
    if (event.action === "received") {
      await handleReceived(event);
    } else if (event.action === "sent") {
      await recordReply(event);
    } else if (event.action === "deleted") {
      await recordDeletion(event);
    }
  };
}

/**
 * The inbound gate. `{ handled: true }` with no text sends nothing and returns
 * before the agent turn starts, which is what a superseded ask needs: the ask that
 * owns the obligation is already answered, or about to be, in its own thread.
 */
export function createInboundTurnGateHandler(gate: InboundTurnGate): GateHandler {
  return async (event, ctx) => {
    const verdict = await gate.take(
      buildTurnKey({
        channelId: event.channel ?? ctx.channelId,
        senderId: readString(event.senderId ?? ctx.senderId),
        // Production fills both with the same expression; a fixture may fill only one.
        sessionKey: event.sessionKey ?? ctx.sessionKey,
        content: event.content,
      }),
    );
    if (!verdict.suppress) {
      return undefined;
    }
    log.warn(`ask-ledger: stopped the turn — ${verdict.reason}`);
    return { handled: true };
  };
}

/** Register the inbound gate as a `before_dispatch` core hook. Idempotent. */
export function registerAskLedgerGate(gate: InboundTurnGate): void {
  registerCoreHook({
    pluginId: ASK_LEDGER_PLUGIN_ID,
    hookName: ASK_LEDGER_GATE_HOOK_NAME,
    handler: createInboundTurnGateHandler(gate),
    timeoutMs: GATE_TIMEOUT_MS,
  });
}

const askLedgerGate = new InboundTurnGate();

const recordAskLedger = createAskLedgerHandler({
  resolveWorkspaceDir: (sessionKey) => resolveHookWorkspaceDir(sessionKey),
  gate: askLedgerGate,
});

/** Internal hook: verifies at gateway startup that the gate is registered. */
const askLedgerHook: HookHandler = async (event) => {
  if (event.type === "gateway" && event.action === "startup") {
    if (hasCoreHook(ASK_LEDGER_PLUGIN_ID, ASK_LEDGER_GATE_HOOK_NAME)) {
      log.info("ask-ledger: before_dispatch turn gate is registered");
    } else {
      log.error(
        "ask-ledger: before_dispatch turn gate is NOT registered; a replayed ask gets answered twice",
      );
    }
    return;
  }
  await recordAskLedger(event);
};

registerAskLedgerGate(askLedgerGate);

export default askLedgerHook;
