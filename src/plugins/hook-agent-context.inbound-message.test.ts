// Covers the typed inbound-message facts surfaced to plugin hooks (used by memory-recall).
import { describe, expect, it } from "vitest";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookInboundMessage,
} from "./hook-agent-context.js";

describe("buildAgentHookInboundMessage", () => {
  it("normalizes ids and prefers the explicit thread ts", () => {
    expect(
      buildAgentHookInboundMessage({
        currentMessageId: 42,
        currentThreadTs: "1786591963.108609",
        messageThreadId: 7,
        senderIsBot: false,
        inboundBody: "  what did we decide?  ",
        channelId: "C0A3C98HS48",
      }),
    ).toEqual({
      messageId: "42",
      threadTs: "1786591963.108609",
      channel: "C0A3C98HS48",
      senderIsBot: false,
      text: "what did we decide?",
    });
  });

  it("falls back to the message thread id and omits unknown fields", () => {
    expect(buildAgentHookInboundMessage({ currentMessageId: "1.2", messageThreadId: 7 })).toEqual({
      messageId: "1.2",
      threadTs: "7",
    });
  });

  it("is absent when the run has no inbound message", () => {
    expect(buildAgentHookInboundMessage({})).toBeUndefined();
    expect(
      buildAgentHookInboundMessage({ currentMessageId: null, inboundBody: "" }),
    ).toBeUndefined();
  });
});

describe("buildAgentHookContextChannelFields", () => {
  it("attaches inboundMessage alongside the channel fields", () => {
    const fields = buildAgentHookContextChannelFields({
      sessionKey: "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609",
      messageProvider: "slack",
      currentChannelId: "channel:C0A3C98HS48",
      senderId: "U012",
      currentMessageId: "1786591970.000100",
      currentThreadTs: "1786591963.108609",
      senderIsBot: true,
      inboundBody: "status?",
    });
    expect(fields.inboundMessage).toEqual({
      messageId: "1786591970.000100",
      threadTs: "1786591963.108609",
      channel: fields.channelId,
      senderIsBot: true,
      text: "status?",
    });
  });

  it("leaves inboundMessage out for runs without one", () => {
    const fields = buildAgentHookContextChannelFields({ messageProvider: "heartbeat" });
    expect(fields).not.toHaveProperty("inboundMessage");
  });
});
