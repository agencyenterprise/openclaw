// Covers the senderIsBot field the memory-recall hook relies on to skip bot-authored messages.
import { describe, expect, it } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessageReceivedContext,
} from "./message-hook-mappers.js";

function makeCtx(overrides: Partial<FinalizedMsgContext>): FinalizedMsgContext {
  return {
    Body: "status of the ARP spoofing routing experiment?",
    From: "slack:U012",
    SessionKey: "agent:main:slack:channel:c0a3c98hs48",
    Provider: "slack",
    ...overrides,
  } as FinalizedMsgContext;
}

describe("message-hook-mappers senderIsBot", () => {
  it("carries the channel's bot flag into the canonical and message:received contexts", () => {
    const canonical = deriveInboundMessageHookContext(makeCtx({ SenderIsBot: true }));
    expect(canonical.senderIsBot).toBe(true);
    expect(toInternalMessageReceivedContext(canonical).metadata?.senderIsBot).toBe(true);
  });

  it("leaves the flag undefined when the channel does not report it", () => {
    const canonical = deriveInboundMessageHookContext(makeCtx({}));
    expect(canonical.senderIsBot).toBeUndefined();
    expect(toInternalMessageReceivedContext(canonical).metadata?.senderIsBot).toBeUndefined();
  });
});
