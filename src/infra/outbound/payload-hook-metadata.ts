// Caller-declared, payload-level metadata for the pre-send `message_sending`
// hook. It is not channel content: nothing here reaches a transport, it only
// tells hooks what an outbound payload is an answer to.
import type { ReplyPayload } from "../../auto-reply/types.js";

/**
 * What an outbound payload declares about the obligation it answers.
 *
 * The field names are the wire contract read by the `outbound-dedupe` hook
 * (`src/hooks/bundled/outbound-dedupe/obligation-key.ts`), which looks them up
 * by name on the hook event metadata. A rename here does not fail — it
 * silently disables the obligation half of the duplicate-answer guard — so the
 * names must stay identical on both sides.
 */
export type OutboundPayloadHookMetadata = {
  /**
   * The ask this send answers, as `<channel>:<ts>`. Declared by a caller that
   * knows the canonical id, so a replayed ask collapsed onto the original in
   * the ask ledger answers under the original id instead of the replay.
   */
  obligationId?: string;
  /** Root ts of the thread the obligation lives in, never where this answer lands. */
  threadRootTs?: string;
  /** 0 is the answer to an obligation; a deliberate follow-up declares 1, 2, … */
  responseVersion?: number;
  /**
   * Names the one physical send this payload becomes, so the hook fires that
   * precede it are recognised as that single send rather than as repeats.
   *
   * The inbound dispatcher runs `message_sending` before it hands a payload to
   * delivery, and delivery runs it again for the same payload; a guard that
   * reserves state per fire would otherwise read its own first reservation as a
   * live duplicate and cancel a send that never went out.
   */
  sendNonce?: string;
};

/** Reply payload plus the metadata outbound delivery forwards to `message_sending`. */
export type OutboundReplyPayload = ReplyPayload & {
  hookMetadata?: OutboundPayloadHookMetadata;
};

/**
 * Projects declared payload metadata onto a `message_sending` hook event.
 * Undeclared fields are omitted so a payload that declares nothing produces
 * exactly the metadata the hook received before this channel existed.
 */
export function toMessageSendingHookMetadata(
  declared: OutboundPayloadHookMetadata | undefined,
): OutboundPayloadHookMetadata {
  if (!declared) {
    return {};
  }
  return {
    ...(declared.obligationId !== undefined ? { obligationId: declared.obligationId } : {}),
    ...(declared.threadRootTs !== undefined ? { threadRootTs: declared.threadRootTs } : {}),
    ...(declared.responseVersion !== undefined
      ? { responseVersion: declared.responseVersion }
      : {}),
    ...(declared.sendNonce !== undefined ? { sendNonce: declared.sendNonce } : {}),
  };
}
