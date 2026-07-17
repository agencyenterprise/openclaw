// sessions_yield tool tests cover cooperative turn yielding and unsupported
// context errors.
import { describe, expect, it, vi } from "vitest";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

type SessionsYieldDetails = {
  status?: string;
  message?: string;
  error?: string;
};

describe("sessions_yield tool", () => {
  it("returns error when no sessionId is provided", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ onYield });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("No session context");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("invokes onYield callback with default message", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("yielded");
    expect(details.message).toBe("Turn yielded.");
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Turn yielded.");
  });

  it("passes the custom message through the yield callback", async () => {
    // The callback message becomes operator-visible scheduler context, so the
    // tool must not replace a supplied reason with the default text.
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", onYield });
    const result = await tool.execute("call-1", { message: "Waiting for fact-checker" });
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("yielded");
    expect(details.message).toBe("Waiting for fact-checker");
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Waiting for fact-checker");
  });

  it("requires a visible source reply before yielding in message-tool-only turns", async () => {
    const onYield = vi.fn();
    const hasRepliedRef = { value: false };
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      onYield,
      sourceReplyDeliveryMode: "message_tool_only",
      hasRepliedRef,
    });
    const blocked = await tool.execute("call-1", { message: "Waiting for steelman" });
    expect((blocked.details as SessionsYieldDetails).status).toBe("error");
    expect((blocked.details as SessionsYieldDetails).error).toContain("Visible status required");
    expect(onYield).not.toHaveBeenCalled();

    hasRepliedRef.value = true;
    const yielded = await tool.execute("call-2", { message: "Waiting for steelman" });
    expect((yielded.details as SessionsYieldDetails).status).toBe("yielded");
    expect(onYield).toHaveBeenCalledWith("Waiting for steelman");
  });

  it("allows an explicitly silent yield without a prior visible source reply", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      onYield,
      sourceReplyDeliveryMode: "message_tool_only",
      hasRepliedRef: { value: false },
    });

    const blocked = await tool.execute("call-1", {
      message: "Waiting privately for editor",
      silent: false,
    });
    expect((blocked.details as SessionsYieldDetails).status).toBe("error");
    expect(onYield).not.toHaveBeenCalled();

    const yielded = await tool.execute("call-2", {
      message: "Waiting privately for editor",
      silent: true,
    });
    expect((yielded.details as SessionsYieldDetails).status).toBe("yielded");
    expect((yielded.details as SessionsYieldDetails).message).toBe("Waiting privately for editor");
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Waiting privately for editor");
  });

  it("returns error without onYield callback", async () => {
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("Yield not supported in this context");
  });
});
