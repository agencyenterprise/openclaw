// The cancel-capable `message_sending` handler behind the outbound-dedupe hook,
// plus the `message:sent` confirmation that turns a reservation into a record.
//
// Two independent signals run before every send, both reserved before the send
// goes out so two concurrent sends cannot both pass:
//   1. the content hash per channel + thread (this file's original guard), and
//   2. the obligation reservation per channel + thread root + obligation +
//      response version (see obligation-key.ts), which catches a second answer
//      to the same ask even when it is paraphrased and lands in another thread.
import { formatErrorMessage } from "../../../infra/errors.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type {
  PluginHookMessageContext,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
} from "../../../plugins/hook-message.types.js";
import type { MessageSentHookContext } from "../../internal-hooks.js";
import { extractSlackThreadTsFromSessionKey } from "../../slack-thread.js";
import { resolveWorkspaceStatePath, type WorkspaceDirResolver } from "../../workspace-state.js";
import { canonicalTarget } from "./channel-target.js";
import { fingerprintOutboundContent } from "./content-fingerprint.js";
import { confirmHash, OUTBOUND_HASHES_FILE, releaseHash, reserveHash } from "./hash-store.js";
import { type OutboundObligation, resolveOutboundObligation } from "./obligation-key.js";
import {
  confirmObligation,
  OUTBOUND_OBLIGATIONS_FILE,
  releaseObligation,
  reserveObligation,
} from "./obligation-store.js";
import { isConfirmedPlatformSend } from "./platform-send.js";

const log = createSubsystemLogger("hooks/outbound-dedupe");

export type OutboundDedupeConfig = {
  windowHours: number;
  maxPerThread: number;
  minChars: number;
  /**
   * How long the run that reserved an obligation may keep sending under it. One
   * answer is delivered as several payloads and `message_sending` fires once per
   * payload, so those all belong to the reservation; anything later is a
   * re-answer. Seconds, not hours: it bounds one delivery, not one conversation.
   * Keep it under `PENDING_TTL_MS`, so an unconfirmed reservation still blocks
   * other runs after its holder's burst is over.
   */
  answerBurstSeconds: number;
};

export const DEFAULT_OUTBOUND_DEDUPE_CONFIG: OutboundDedupeConfig = {
  windowHours: 24,
  maxPerThread: 20,
  minChars: 24,
  answerBurstSeconds: 60,
};

const HOUR_MS = 60 * 60 * 1000;
const SECOND_MS = 1_000;

/** A send whose delivery has no session attached still needs a stable holder. */
const UNKNOWN_HOLDER = "unknown-session";

/**
 * Payload metadata naming the one physical send a fire belongs to.
 *
 * One send runs this hook more than once — the inbound dispatcher runs it before
 * it hands the payload to delivery, and core outbound delivery runs it again for
 * the same payload — so without a shared id the second fire reads the first
 * fire's own reservation as a live duplicate and cancels a send that never went
 * out. Core delivery projects the value from `hookMetadata.sendNonce`
 * (`src/infra/outbound/payload-hook-metadata.ts`); the name is a by-name wire
 * contract with that file, and a rename there does not fail loudly, it silently
 * turns the fires of one send back into a self-cancelling duplicate.
 */
export const SEND_NONCE_METADATA_KEY = "sendNonce";

function readSendNonce(event: PluginHookMessageSendingEvent): string | undefined {
  const value = event.metadata?.[SEND_NONCE_METADATA_KEY];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildKey(params: {
  channelId: string;
  target?: string;
  conversationId?: string;
  threadId?: string | number;
  sessionKey?: string;
}): string {
  const target =
    canonicalTarget(params.channelId, params.target) ??
    canonicalTarget(params.channelId, params.conversationId) ??
    "unknown";
  const thread =
    (params.threadId !== undefined ? String(params.threadId) : undefined) ??
    extractSlackThreadTsFromSessionKey(params.sessionKey) ??
    "root";
  return `${params.channelId}:${target}:${thread}`;
}

export function buildThreadKey(
  event: PluginHookMessageSendingEvent,
  ctx: PluginHookMessageContext,
): string {
  return buildKey({
    channelId: ctx.channelId,
    target: event.to,
    conversationId: ctx.conversationId,
    threadId: event.threadId,
    sessionKey: ctx.sessionKey,
  });
}

export function buildSentThreadKey(ctx: MessageSentHookContext, sessionKey: string): string {
  return buildKey({
    channelId: ctx.channelId,
    target: ctx.to,
    conversationId: ctx.conversationId,
    sessionKey,
  });
}

export type OutboundDedupeGuard = (
  event: PluginHookMessageSendingEvent,
  ctx: PluginHookMessageContext,
) => Promise<PluginHookMessageSendingResult | undefined>;

export type OutboundDedupeDeps = {
  resolveWorkspaceDir: WorkspaceDirResolver;
  resolveConfig: () => OutboundDedupeConfig;
  now?: () => Date;
};

function storePathFor(
  deps: OutboundDedupeDeps,
  sessionKey: string | undefined,
  fileName: string,
): string {
  return resolveWorkspaceStatePath(deps.resolveWorkspaceDir(sessionKey), fileName);
}

function cancel(reason: string): PluginHookMessageSendingResult {
  return { cancel: true, cancelReason: `outbound-dedupe: ${reason}` };
}

/**
 * Pre-send guard. The content hash is reserved first and keeps its own behaviour;
 * the obligation reservation then runs for sends that answer an identified ask.
 */
export function createOutboundDedupeGuard(deps: OutboundDedupeDeps): OutboundDedupeGuard {
  const now = deps.now ?? (() => new Date());
  return async (event, ctx) => {
    const config = deps.resolveConfig();
    const obligation = resolveOutboundObligation(event, ctx);
    const sendNonce = readSendNonce(event);
    const threadKey = buildThreadKey(event, ctx);
    const hash = fingerprintOutboundContent(event.content);
    const hashPath = storePathFor(deps, ctx.sessionKey, OUTBOUND_HASHES_FILE);
    // Messages under minChars are never content-deduplicated, so short
    // acknowledgements such as "OK" stay allowed. The obligation reservation
    // does not read the text at all, so it still covers a short answer.
    const contentGuarded = event.content.trim().length >= config.minChars;

    if (contentGuarded) {
      const outcome = await reserveHash(hashPath, {
        threadKey,
        hash,
        ...(sendNonce ? { sendNonce } : {}),
        now: now(),
        windowMs: config.windowHours * HOUR_MS,
        maxPerThread: config.maxPerThread,
      });
      if (outcome === "duplicate") {
        log.warn(`outbound-dedupe: suppressed duplicate`, {
          thread: threadKey,
          sessionKey: ctx.sessionKey,
          preview: event.content.slice(0, 80),
        });
        return cancel(`duplicate of a send within ${config.windowHours}h in ${threadKey}`);
      }
    }
    if (!obligation) {
      return undefined;
    }
    return await guardObligation({
      deps,
      config,
      event,
      ctx,
      obligation,
      contentHash: hash,
      ...(sendNonce ? { sendNonce } : {}),
      now: now(),
      // The hash reservation this send just took must not be left behind when the
      // send is cancelled: `message:sent` never comes, and until it expires the
      // stray pending entry can absorb another send's confirmation in that thread.
      // Reaching here means the hash was reserved, by this fire or by an earlier
      // fire of this same send; either way the entry belongs to this send and a
      // cancel below has to roll it back.
      releaseHashReservation: contentGuarded
        ? () => releaseHash(hashPath, { threadKey, hash, ...(sendNonce ? { sendNonce } : {}) })
        : undefined,
    });
  };
}

async function guardObligation(params: {
  deps: OutboundDedupeDeps;
  config: OutboundDedupeConfig;
  event: PluginHookMessageSendingEvent;
  ctx: PluginHookMessageContext;
  obligation: OutboundObligation;
  contentHash: string;
  sendNonce?: string;
  now: Date;
  releaseHashReservation?: () => Promise<boolean>;
}): Promise<PluginHookMessageSendingResult | undefined> {
  const { config, ctx, obligation } = params;
  const filePath = storePathFor(params.deps, ctx.sessionKey, OUTBOUND_OBLIGATIONS_FILE);
  let outcome: Awaited<ReturnType<typeof reserveObligation>>;
  try {
    outcome = await reserveObligation(filePath, {
      key: obligation.key,
      holder: ctx.sessionKey ?? UNKNOWN_HOLDER,
      contentHash: params.contentHash,
      ...(params.sendNonce ? { sendNonce: params.sendNonce } : {}),
      now: params.now,
      windowMs: config.windowHours * HOUR_MS,
      burstMs: config.answerBurstSeconds * SECOND_MS,
    });
  } catch (err) {
    // Fail closed. An unreachable store cannot tell us whether this obligation was
    // already answered, and the incident this guard exists for is a second answer
    // reaching the channel. A send held back is visible in the audit trail and can
    // be retried; a duplicate answer cannot be taken back. The error is logged, not
    // swallowed, and only sends that answer an obligation are affected — everything
    // else keeps the behaviour it had before this guard existed.
    log.error(`outbound-dedupe: obligation store unreachable; cancelling the send`, {
      obligation: obligation.key,
      sessionKey: ctx.sessionKey,
      file: filePath,
      error: formatErrorMessage(err),
    });
    return cancel(`obligation store unreachable (${filePath}); refusing to risk a second answer`);
  }
  if (outcome !== "duplicate") {
    return undefined;
  }
  await params.releaseHashReservation?.();
  log.warn(`outbound-dedupe: suppressed a second answer for one obligation`, {
    obligation: obligation.key,
    source: obligation.source,
    sessionKey: ctx.sessionKey,
    preview: params.event.content.slice(0, 80),
  });
  return cancel(
    `obligation ${obligation.key} was already answered within ${config.windowHours}h; ` +
      `a deliberate follow-up must declare a new responseVersion`,
  );
}

export type OutboundSentRecorder = (
  ctx: MessageSentHookContext,
  sessionKey: string,
) => Promise<void>;

/** Post-send recorder: confirms the reservations on success, releases them on failure. */
export function createOutboundSentRecorder(deps: OutboundDedupeDeps): OutboundSentRecorder {
  const now = deps.now ?? (() => new Date());
  return async (ctx, sessionKey) => {
    const contentHash = fingerprintOutboundContent(ctx.content);
    if (ctx.content.trim().length >= deps.resolveConfig().minChars) {
      await recordSentHash(deps, ctx, sessionKey, contentHash, now());
    }
    // An obligation key never looks at the text, so its reservation is settled for
    // every send, short acknowledgements included.
    await recordSentObligation(deps, ctx, sessionKey, contentHash, now());
  };
}

async function recordSentHash(
  deps: OutboundDedupeDeps,
  ctx: MessageSentHookContext,
  sessionKey: string,
  hash: string,
  now: Date,
): Promise<void> {
  const filePath = storePathFor(deps, sessionKey, OUTBOUND_HASHES_FILE);
  const threadKey = buildSentThreadKey(ctx, sessionKey);
  if (isConfirmedPlatformSend(ctx)) {
    const confirmed = await confirmHash(filePath, { threadKey, hash, now });
    if (!confirmed) {
      log.debug(`outbound-dedupe: no pending reservation to confirm`, { thread: threadKey });
    }
    return;
  }
  if (ctx.success) {
    // Same rule as the obligation: a send that named no message that landed does
    // not get to hold this text for the window. The reservation stays pending and
    // expires, so re-sending the same answer is not blocked for a day by a send
    // nobody can see.
    return;
  }
  const released = await releaseHash(filePath, { threadKey, hash });
  if (released) {
    log.info(`outbound-dedupe: released reservation after failed send`, { thread: threadKey });
  }
}

/**
 * Settle the reservation this `message:sent` belongs to.
 *
 * Only a confirmed platform send keeps the key for the full window. A send that
 * reports success without a platform message id did not reach the channel as an
 * identifiable message — an ephemeral slash reply, a suppressed silent token, a
 * stream acknowledgement, the `parent_deleted` sentinel — and holding the
 * obligation for it would mute every later answer to that ask. Those release the
 * reservation instead, so the next attempt goes through.
 *
 * A reservation whose send is cancelled before delivery gets no `message:sent`
 * at all; it stays pending and expires after `PENDING_TTL_MS`, which is the
 * bound on how long a send that never reported back can block a retry.
 */
async function recordSentObligation(
  deps: OutboundDedupeDeps,
  ctx: MessageSentHookContext,
  sessionKey: string,
  contentHash: string,
  now: Date,
): Promise<void> {
  const filePath = storePathFor(deps, sessionKey, OUTBOUND_OBLIGATIONS_FILE);
  if (isConfirmedPlatformSend(ctx)) {
    await confirmObligation(filePath, { holder: sessionKey, contentHash, now });
    return;
  }
  if (ctx.success) {
    // Reported success with no message that landed. Neither outcome is safe to
    // assume, so the reservation is left pending: it still blocks an immediate
    // re-answer and it expires after PENDING_TTL_MS instead of holding the
    // obligation — and muting the ask — for the whole window.
    log.info(`outbound-dedupe: send reported success with no platform message id`, {
      sessionKey,
      messageId: ctx.messageId,
    });
    return;
  }
  const released = await releaseObligation(filePath, { holder: sessionKey, contentHash });
  if (released) {
    log.info(`outbound-dedupe: released the obligation reservation after a failed send`, {
      sessionKey,
    });
  }
}
