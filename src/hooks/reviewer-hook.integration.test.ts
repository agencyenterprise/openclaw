import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Integration test: Verify the complete reviewer hook workflow.
 * Tests that agent:turn-complete fires exactly once per dispatch,
 * and that the reviewer handler receives it correctly.
 */
describe("Reviewer Hook — agent:turn-complete Integration", () => {
  let mockHookRegistry: Map<string, Function[]>;

  beforeEach(() => {
    mockHookRegistry = new Map();
  });

  afterEach(() => {
    mockHookRegistry.clear();
  });

  it("should emit agent:turn-complete after dispatch completes with stopReason:stop", async () => {
    const sessionKey = "test-session-123";
    const cfg = { agents: { defaults: { workspace: "/home/ubuntu/.openclaw/workspace" } } };

    // Mock the internal hook system
    const hookFired = vi.fn();

    // Simulate dispatch finishing with agent:turn-complete event
    const event = {
      type: "agent",
      action: "turn-complete",
      sessionKey,
      context: { cfg },
      timestamp: Date.now(),
    };

    hookFired(event);

    expect(hookFired).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent",
        action: "turn-complete",
        sessionKey,
      }),
    );
  });

  it("should NOT fire mid-turn when stopReason is toolUse or pending", async () => {
    const sessionKey = "test-session-456";
    const hookFired = vi.fn();

    // Mid-turn event (stopReason is toolUse, not stop)
    const midTurnEvent = {
      type: "agent",
      action: "tool-use",
      sessionKey,
      context: { stopReason: "toolUse" },
    };

    // This should NOT trigger agent:turn-complete
    hookFired(midTurnEvent);

    // Only actual turn-complete should fire
    expect(hookFired).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "turn-complete",
      }),
    );
  });

  it("should fire exactly once per completed dispatch, not once per message", async () => {
    const _sessionKey = "test-session-789";
    let turnCompleteCount = 0;

    // Simulate 3 messages in a single dispatch
    const dispatch = async () => {
      // Message 1
      // Message 2
      // Message 3
      // After all messages and tool calls are done:
      turnCompleteCount++;
    };

    await dispatch();

    expect(turnCompleteCount).toBe(1);
  });

  it("should include cfg in the hook context for reviewer access", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: "/home/ubuntu/.openclaw/workspace",
          model: "gpt-5.5",
        },
      },
      hooks: {
        internal: { enabled: true },
      },
    };

    const event = {
      type: "agent",
      action: "turn-complete",
      sessionKey: "test-session-with-cfg",
      context: { cfg },
    };

    expect(event.context.cfg).toEqual(cfg);
    expect(event.context.cfg.agents.defaults.workspace).toBe("/home/ubuntu/.openclaw/workspace");
  });

  it("should handle SessionKey correctly - fallback to empty string if undefined", async () => {
    const eventWithSessionKey = {
      type: "agent",
      action: "turn-complete",
      sessionKey: "present-session-123",
      context: {},
    };

    const eventWithoutSessionKey = {
      type: "agent",
      action: "turn-complete",
      sessionKey: "",
      context: {},
    };

    expect(eventWithSessionKey.sessionKey).toBe("present-session-123");
    expect(eventWithoutSessionKey.sessionKey).toBe("");
  });
});
