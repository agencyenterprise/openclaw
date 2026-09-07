/**
 * The obligation half of the outbound-dedupe guard.
 *
 * The content hash asks "did we already post this paragraph in this thread?".
 * That misses the failure this key exists for: Slack replayed an ask the user
 * had deleted next to the user's live re-post, two runs answered the same
 * obligation with differently paraphrased text, and the two answers sat under
 * two different thread keys. So a second key is reserved per send:
 *
 *     <channel>:<threadRootTs>:<obligationId>:v<responseVersion>
 *
 * - `channel`      — canonical delivery target (Slack ids case-folded).
 * - `threadRootTs` — the root of the thread the OBLIGATION lives in, never the
 *   parent ts of the individual message and never where this particular answer
 *   happened to land. It is the ts inside the ask id, so a threaded reply and a
 *   top-level post about the same obligation collapse onto one key instead of
 *   splitting into two (exactly the shape of the leak).
 * - `obligationId` — the ask this send answers: `<channel>:<ts>`, the same shape
 *   `ask-ledger/ledger.ts` `buildAskId` writes. Declared by the caller through
 *   payload metadata when it knows the canonical id (a replayed ask collapses to
 *   the original there), otherwise derived from the message this send replies to.
 * - `responseVersion` — 0 for the answer to an obligation. A deliberate follow-up
 *   or correction opts in to 1, 2, … and gets its own reservation. Nothing bumps
 *   it automatically: retries, chunked payloads and re-renders of one answer stay
 *   on the same version, because a version that moves on its own would make every
 *   accidental re-answer look new and defeat the guard.
 *
 * A send that answers nothing identifiable (a cron announce, a heartbeat, the
 * 2nd..nth payload of an answer whose reply target was consumed) has NO
 * obligation and is left to the content hash alone. The session key is
 * deliberately not used as a stand-in obligation: `message_sending` fires once
 * per payload chunk and one long-lived session posts many unrelated messages, so
 * a session-keyed obligation would cancel the rest of every chunked answer and
 * every later announce in that session.
 *
 * Neither is the THREAD ROOT. A Slack reply that targets the root of the thread
 * it lands in is addressed to the thread, not to one message in it, and a
 * long-lived thread carries many asks. Deriving an obligation from that target
 * makes every answer in the thread look like a re-answer of the first, and once
 * the holder's burst is over the guard cancels it for the whole window. That is
 * the 2026-09-04 mute in #fractal-ai-gateway: two sends at 02:45:37 and 02:46:31
 * were cancelled under `C0AHSKBNDB6:1788473062.847669:...` with
 * `source: "reply-target"`, and both were answers to asks that thread root is
 * not. Such a send declares no obligation and keeps the content-hash behaviour;
 * a caller that knows which ask it answers declares it instead.
 */
import type {
  PluginHookMessageContext,
  PluginHookMessageSendingEvent,
} from "../../../plugins/hook-message.types.js";
import { isSlackTs } from "../../slack-thread.js";
import { canonicalTarget } from "./channel-target.js";

/** Payload metadata a caller sets to declare what a send answers. */
export const OBLIGATION_ID_METADATA_KEY = "obligationId";
export const THREAD_ROOT_TS_METADATA_KEY = "threadRootTs";
export const RESPONSE_VERSION_METADATA_KEY = "responseVersion";

/** The answer to an obligation. Follow-ups and corrections declare 1, 2, … */
export const FIRST_RESPONSE_VERSION = 0;

/** Used when neither the obligation id nor the caller names a thread root. */
export const UNKNOWN_THREAD_ROOT = "root";

const UNKNOWN_CHANNEL = "unknown";

/** Where the obligation id came from — declared by the caller, or derived from the reply target. */
export type ObligationSource = "declared" | "reply-target";

export type OutboundObligation = {
  key: string;
  channel: string;
  threadRootTs: string;
  obligationId: string;
  responseVersion: number;
  source: ObligationSource;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * A caller that sends garbage in `responseVersion` gets version 0 — the strict
 * direction. Treating an unusable value as a new version would let a broken
 * caller re-answer forever.
 */
function readResponseVersion(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : FIRST_RESPONSE_VERSION;
}

/** The ts of an ask id (`<channel>:<ts>`), which is the root of that ask's thread. */
function threadRootOfAskId(obligationId: string): string | undefined {
  const ts = obligationId.slice(obligationId.lastIndexOf(":") + 1);
  return isSlackTs(ts) ? ts : undefined;
}

/**
 * Does this reply target name ONE ask? A Slack ts does, unless it is the root of
 * the thread the send lands in: that names the thread, which many asks share.
 */
function identifiesOneAsk(
  event: PluginHookMessageSendingEvent,
  replyToId: string | undefined,
): replyToId is string {
  if (!isSlackTs(replyToId)) {
    return false;
  }
  const threadId = event.threadId !== undefined ? String(event.threadId) : undefined;
  return threadId !== replyToId;
}

export function buildObligationKey(params: {
  channel: string;
  threadRootTs: string;
  obligationId: string;
  responseVersion: number;
}): string {
  return `${params.channel}:${params.threadRootTs}:${params.obligationId}:v${params.responseVersion}`;
}

/** The obligation this send answers, or undefined when it answers none. */
export function resolveOutboundObligation(
  event: PluginHookMessageSendingEvent,
  ctx: PluginHookMessageContext,
): OutboundObligation | undefined {
  const metadata = event.metadata ?? {};
  const channel =
    canonicalTarget(ctx.channelId, event.to) ??
    canonicalTarget(ctx.channelId, ctx.conversationId) ??
    UNKNOWN_CHANNEL;
  const declaredId = readString(metadata[OBLIGATION_ID_METADATA_KEY]);
  const replyToId = event.replyToId !== undefined ? String(event.replyToId) : undefined;
  const identified: Pick<OutboundObligation, "obligationId" | "source"> | undefined = declaredId
    ? { obligationId: declaredId, source: "declared" }
    : identifiesOneAsk(event, replyToId)
      ? { obligationId: `${channel}:${replyToId}`, source: "reply-target" }
      : undefined;
  if (!identified) {
    return undefined;
  }
  const threadRootTs =
    readString(metadata[THREAD_ROOT_TS_METADATA_KEY]) ??
    threadRootOfAskId(identified.obligationId) ??
    UNKNOWN_THREAD_ROOT;
  const responseVersion = readResponseVersion(metadata[RESPONSE_VERSION_METADATA_KEY]);
  return {
    key: buildObligationKey({
      channel,
      threadRootTs,
      obligationId: identified.obligationId,
      responseVersion,
    }),
    channel,
    threadRootTs,
    responseVersion,
    ...identified,
  };
}
