// The cancel-capable `message_sending` handler behind the outbound-dedupe hook,
// plus the `message:sent` confirmation that turns a reservation into a record.
//
// The content hash per channel + thread is reserved before the send goes out,
// so two concurrent sends of the same text cannot both pass.
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
import { isConfirmedPlatformSend } from "./platform-send.js";

const log = createSubsystemLogger("hooks/outbound-dedupe");

export type OutboundDedupeConfig = {
  windowHours: number;
  maxPerThread: number;
  minChars: number;
};

export const DEFAULT_OUTBOUND_DEDUPE_CONFIG: OutboundDedupeConfig = {
  windowHours: 24,
  maxPerThread: 20,
  minChars: 24,
};

const HOUR_MS = 60 * 60 * 1000;

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

function storePathFor(deps: OutboundDedupeDeps, sessionKey: string | undefined): string {
  return resolveWorkspaceStatePath(deps.resolveWorkspaceDir(sessionKey), OUTBOUND_HASHES_FILE);
}

function cancel(reason: string): PluginHookMessageSendingResult {
  return { cancel: true, cancelReason: `outbound-dedupe: ${reason}` };
}

/**
 * Pre-send guard: cancels a send whose normalized text was already posted in the
 * same channel + thread within the window.
 *
 * It does not track which ask a send answers. A run may post an acknowledgement
 * ("I'll review it and reply shortly") and later the answer to the same ask; a
 * one-answer-per-ask rule cannot tell the two apart and cancels the answer
 * (2026-09-22). One turn per ask is enforced where the ask arrives, by the
 * ask-ledger turn gate.
 */
export function createOutboundDedupeGuard(deps: OutboundDedupeDeps): OutboundDedupeGuard {
  const now = deps.now ?? (() => new Date());
  return async (event, ctx) => {
    const config = deps.resolveConfig();
    // Messages under minChars are never deduplicated, so short acknowledgements
    // such as "OK" stay allowed.
    if (event.content.trim().length < config.minChars) {
      return undefined;
    }
    const sendNonce = readSendNonce(event);
    const threadKey = buildThreadKey(event, ctx);
    const outcome = await reserveHash(storePathFor(deps, ctx.sessionKey), {
      threadKey,
      hash: fingerprintOutboundContent(event.content),
      ...(sendNonce ? { sendNonce } : {}),
      now: now(),
      windowMs: config.windowHours * HOUR_MS,
      maxPerThread: config.maxPerThread,
    });
    if (outcome !== "duplicate") {
      return undefined;
    }
    log.warn(`outbound-dedupe: suppressed duplicate`, {
      thread: threadKey,
      sessionKey: ctx.sessionKey,
      preview: event.content.slice(0, 80),
    });
    return cancel(`duplicate of a send within ${config.windowHours}h in ${threadKey}`);
  };
}

export type OutboundSentRecorder = (
  ctx: MessageSentHookContext,
  sessionKey: string,
) => Promise<void>;

/** Post-send recorder: confirms the reservation on success, releases it on failure. */
export function createOutboundSentRecorder(deps: OutboundDedupeDeps): OutboundSentRecorder {
  const now = deps.now ?? (() => new Date());
  return async (ctx, sessionKey) => {
    if (ctx.content.trim().length < deps.resolveConfig().minChars) {
      return;
    }
    await recordSentHash(deps, ctx, sessionKey, fingerprintOutboundContent(ctx.content), now());
  };
}

async function recordSentHash(
  deps: OutboundDedupeDeps,
  ctx: MessageSentHookContext,
  sessionKey: string,
  hash: string,
  now: Date,
): Promise<void> {
  const filePath = storePathFor(deps, sessionKey);
  const threadKey = buildSentThreadKey(ctx, sessionKey);
  if (isConfirmedPlatformSend(ctx)) {
    const confirmed = await confirmHash(filePath, { threadKey, hash, now });
    if (!confirmed) {
      log.debug(`outbound-dedupe: no pending reservation to confirm`, { thread: threadKey });
    }
    return;
  }
  if (ctx.success) {
    // A send that named no message that landed does not get to hold this text for
    // the window. The reservation stays pending and expires, so re-sending the same
    // answer is not blocked for a day by a send nobody can see.
    log.info(`outbound-dedupe: send reported success with no platform message id`, {
      sessionKey,
      messageId: ctx.messageId,
    });
    return;
  }
  const released = await releaseHash(filePath, { threadKey, hash });
  if (released) {
    log.info(`outbound-dedupe: released reservation after failed send`, { thread: threadKey });
  }
}
