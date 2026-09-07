/** What a dispatcher-path send declares to the outbound `message_sending` hooks. */
import { randomUUID } from "node:crypto";
import type { OutboundPayloadHookMetadata } from "../../infra/outbound/payload-hook-metadata.js";
import { resolveReplyObligationId } from "./reply-obligation.js";

/**
 * Declares what one inbound-dispatcher send is, for the `message_sending` hooks.
 *
 * `sendNonce` names the physical send. The dispatcher fire is not the only one
 * for it: a channel whose inbound turn delivers finals durably runs the hook a
 * second time inside `deliverOutboundPayloads` for this same payload, and a hook
 * that reserves state per fire — the bundled `outbound-dedupe` guard does —
 * would otherwise read its own first reservation as a live duplicate and cancel
 * a send that never went out. Both fires quoting one nonce makes the reservation
 * idempotent.
 *
 * `obligationId` names the ask the reply answers. Only the inbound context knows
 * it; below the dispatcher, delivery sees a payload and a target. A reply that
 * never routes through `routeReply` has no other place to declare it, which is
 * why the obligation half of the guard was inert on this path without it.
 * `inboundMessageId` is that ask: the message that opened this turn. It is what
 * keeps a second ask in a long thread from being read as a re-answer of the
 * first, which is how the 2026-09-04 mute in #fractal-ai-gateway happened.
 */
export function buildDispatchSendHookMetadata(params: {
  channelId: string;
  replyTarget: string;
  sessionKey?: string;
  replyToId?: string;
  /** Ts of the inbound message this turn is answering. */
  inboundMessageId?: string;
  /**
   * What the payload already declared. A caller that named the obligation, the
   * thread root or a deliberate `responseVersion` knows more than this stage
   * derives, so its declaration wins and is never overwritten here.
   */
  declared?: OutboundPayloadHookMetadata;
}): OutboundPayloadHookMetadata {
  const obligationId = resolveReplyObligationId({
    channelId: params.channelId,
    to: params.replyTarget,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.inboundMessageId ? { inboundMessageId: params.inboundMessageId } : {}),
  });
  return {
    sendNonce: randomUUID(),
    ...(obligationId ? { obligationId } : {}),
    ...params.declared,
  };
}
