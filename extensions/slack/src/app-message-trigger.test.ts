// Slack tests cover app-attributed message trigger matching.
import { describe, expect, it } from "vitest";
import { matchesSlackAppMessageTrigger } from "./app-message-trigger.js";

const JUDD = "U02AX1XQ1";
const CLAUDE_APP = "A08SF47R6P4";
const CLAUDE_BOT_USER = "U09J1CLLBGT";
const TRAIL_PATTERN = String.raw`\*Sent using\* <@${CLAUDE_BOT_USER}>\s*$`;

// Field shape taken from a real Claude-sent message (C0AHSKBNDB6, ts 1784593072.285299).
const claudeSentMessage = {
  user: JUDD,
  app_id: CLAUDE_APP,
  text: `Quick correction on the artifact-custody gap. *Sent using* <@${CLAUDE_BOT_USER}>`,
};

const triggers = [{ userId: JUDD, appId: CLAUDE_APP, textPattern: TRAIL_PATTERN }];

describe("matchesSlackAppMessageTrigger", () => {
  it("matches the pinned user via app_id attribution", () => {
    expect(
      matchesSlackAppMessageTrigger({
        triggers,
        message: { user: JUDD, app_id: CLAUDE_APP, text: "no trail in text" },
      }),
    ).toBe(true);
  });

  it("matches the pinned user via the rendered trail when app_id is absent", () => {
    expect(
      matchesSlackAppMessageTrigger({
        triggers,
        message: { user: JUDD, text: claudeSentMessage.text },
      }),
    ).toBe(true);
  });

  it("ignores other users even with Claude attribution", () => {
    expect(
      matchesSlackAppMessageTrigger({
        triggers,
        message: { ...claudeSentMessage, user: "U03EH553GBE" },
      }),
    ).toBe(false);
  });

  it("ignores the pinned user's plain messages", () => {
    expect(
      matchesSlackAppMessageTrigger({
        triggers,
        message: { user: JUDD, text: "regular message typed by hand" },
      }),
    ).toBe(false);
  });

  it("ignores messages when no triggers are configured", () => {
    expect(matchesSlackAppMessageTrigger({ triggers: undefined, message: claudeSentMessage })).toBe(
      false,
    );
    expect(matchesSlackAppMessageTrigger({ triggers: [], message: claudeSentMessage })).toBe(false);
  });

  it("never matches on an invalid textPattern", () => {
    expect(
      matchesSlackAppMessageTrigger({
        triggers: [{ userId: JUDD, textPattern: "([unclosed" }],
        message: claudeSentMessage,
      }),
    ).toBe(false);
  });
});
