import { describe, expect, it } from "vitest";
import { buildReviewerSyntheticMessage } from "./reviewer-dispatch.js";

describe("buildReviewerSyntheticMessage", () => {
  it("uses the real Slack thread timestamp as the synthetic message timestamp", () => {
    const message = buildReviewerSyntheticMessage(
      {
        channelId: "C123",
        threadTs: "1777403041.009789",
        text: "Gateway restarted. Continue where you left off.",
      },
      "U_BOT",
    );

    expect(message.ts).toBe("1777403041.009789");
    expect(message.event_ts).toBe("1777403041.009789");
    expect(message.thread_ts).toBe("1777403041.009789");
  });

  it("assigns a distinct synthetic inbound id for dedupe", () => {
    const message = buildReviewerSyntheticMessage(
      {
        channelId: "C123",
        threadTs: "1777403041.009789",
        text: "Reviewer feedback.",
      },
      "U_BOT",
    );

    expect(message.openclaw_synthetic_message_id).toMatch(/^reviewer:C123:1777403041\.009789:/);
    expect(message.openclaw_synthetic_message_id).not.toBe(message.ts);
  });

  it("marks the synthetic message as a real thread reply for Slack routing", () => {
    const message = buildReviewerSyntheticMessage(
      {
        channelId: "C123",
        threadTs: "1777403041.009789",
        text: "Reviewer feedback.",
      },
      "U_BOT",
    );

    expect(message.parent_user_id).toBe("U_BOT");
  });

  it("carries a private reviewer replacement target without changing routing", () => {
    const message = buildReviewerSyntheticMessage(
      {
        channelId: "C123",
        threadTs: "1777403041.009789",
        text: "Internal correction.",
        replaceMessageTs: "1777403050.000001",
      },
      "U_BOT",
    );

    expect(message.openclaw_replace_message_ts).toBe("1777403050.000001");
    expect(message.thread_ts).toBe("1777403041.009789");
  });
});
