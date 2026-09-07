// Covers the auto-delivery fallback for a stranded message-tool-only final.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import {
  buildAutoDeliveredPrivateFinalPayload,
  resolveAutoDeliverPrivateFinal,
  shouldAutoDeliverStrandedPrivateFinal,
} from "./stranded-reply-recovery.js";

function configWith(messages: Record<string, unknown>): OpenClawConfig {
  return { messages } as unknown as OpenClawConfig;
}

const strandedTurn = {
  cfg: configWith({ visibleReplies: "message_tool" }),
  isStrandedReply: true,
  isStrandedReplyRetryRun: false,
  isHeartbeat: false,
  isRoomEvent: false,
};

describe("resolveAutoDeliverPrivateFinal", () => {
  it("defaults to enabled when the key is absent", () => {
    expect(resolveAutoDeliverPrivateFinal(configWith({ visibleReplies: "message_tool" }))).toBe(
      true,
    );
    expect(resolveAutoDeliverPrivateFinal({} as OpenClawConfig)).toBe(true);
    expect(resolveAutoDeliverPrivateFinal(undefined)).toBe(true);
  });

  it("is disabled only when the flag is explicitly false", () => {
    expect(resolveAutoDeliverPrivateFinal(configWith({ autoDeliverPrivateFinal: false }))).toBe(
      false,
    );
    expect(resolveAutoDeliverPrivateFinal(configWith({ autoDeliverPrivateFinal: true }))).toBe(
      true,
    );
  });
});

describe("buildAutoDeliveredPrivateFinalPayload", () => {
  it("carries the assistant final text past source-reply suppression", () => {
    const finalText = "The answer the model wrote but never sent with message(action=send).";
    const payload = buildAutoDeliveredPrivateFinalPayload(finalText);

    expect(payload.text).toBe(finalText);
    expect(getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression).toBe(true);
    // Not a diagnostic notice: this is the reply itself, not a delivery failure.
    expect(payload.isError).toBeUndefined();
    expect(payload.isStatusNotice).toBeUndefined();
  });
});

describe("shouldAutoDeliverStrandedPrivateFinal", () => {
  it("auto-delivers a stranded private final by default", () => {
    expect(shouldAutoDeliverStrandedPrivateFinal(strandedTurn)).toBe(true);
  });

  it("does not auto-deliver when the flag is disabled", () => {
    expect(
      shouldAutoDeliverStrandedPrivateFinal({
        ...strandedTurn,
        cfg: configWith({ visibleReplies: "message_tool", autoDeliverPrivateFinal: false }),
      }),
    ).toBe(false);
  });

  it("does not auto-deliver on a stranded-reply retry run", () => {
    expect(
      shouldAutoDeliverStrandedPrivateFinal({ ...strandedTurn, isStrandedReplyRetryRun: true }),
    ).toBe(false);
  });

  it("never auto-delivers on heartbeat or room_event turns", () => {
    expect(shouldAutoDeliverStrandedPrivateFinal({ ...strandedTurn, isHeartbeat: true })).toBe(
      false,
    );
    expect(shouldAutoDeliverStrandedPrivateFinal({ ...strandedTurn, isRoomEvent: true })).toBe(
      false,
    );
  });

  it("does not auto-deliver when the turn was not stranded", () => {
    expect(shouldAutoDeliverStrandedPrivateFinal({ ...strandedTurn, isStrandedReply: false })).toBe(
      false,
    );
  });
});
