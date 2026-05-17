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
});
