// Slack tests cover app-attributed message trigger matching.
import { describe, expect, it } from "vitest";
import { matchesSlackAppMessageTrigger } from "./app-message-trigger.js";

const JUDD = "U02AX1XQ1";
const FLAVIO = "U03EH553GBE";
const CLAUDE = { appId: "A08SF47R6P4", botUserId: "U09J1CLLBGT" };
const CHATGPT = { appId: "A097V82EGG2", botUserId: "U0BJ55QCP1U" };

const trailPattern = (botUserId: string) => String.raw`\*Sent using\* <@${botUserId}>\s*$`;
const trail = (botUserId: string) => `*Sent using* <@${botUserId}>`;

// Mirrors the deployed config: one trigger per (pinned user, assistant app).
const triggers = [JUDD, FLAVIO].flatMap((userId) =>
  [CLAUDE, CHATGPT].map((app) => ({
    userId,
    appId: app.appId,
    textPattern: trailPattern(app.botUserId),
  })),
);

// Field shape taken from a real Claude-sent message (C0AHSKBNDB6, ts 1784593072.285299).
const claudeSentMessage = {
  user: JUDD,
  app_id: CLAUDE.appId,
  text: `Quick correction on the artifact-custody gap. ${trail(CLAUDE.botUserId)}`,
};

// Field shape taken from a real ChatGPT-sent message (C0AHSKBNDB6, ts 1790104177.344839).
const chatGptSentMessage = {
  user: JUDD,
  app_id: CHATGPT.appId,
  text: `Executed notebook. Package commit: 44d0644. ${trail(CHATGPT.botUserId)}`,
};

describe("matchesSlackAppMessageTrigger", () => {
  it("matches the pinned user via app_id attribution", () => {
    expect(
      matchesSlackAppMessageTrigger({
        triggers,
        message: { user: JUDD, app_id: CLAUDE.appId, text: "no trail in text" },
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

  it("matches a Claude-sent message from each pinned user", () => {
    for (const user of [JUDD, FLAVIO]) {
      expect(
        matchesSlackAppMessageTrigger({ triggers, message: { ...claudeSentMessage, user } }),
      ).toBe(true);
    }
  });

  it("matches a ChatGPT-sent message from each pinned user", () => {
    for (const user of [JUDD, FLAVIO]) {
      expect(
        matchesSlackAppMessageTrigger({ triggers, message: { ...chatGptSentMessage, user } }),
      ).toBe(true);
    }
  });

  it("matches the ChatGPT trail when app_id is absent", () => {
    expect(
      matchesSlackAppMessageTrigger({
        triggers,
        message: { user: JUDD, text: chatGptSentMessage.text },
      }),
    ).toBe(true);
  });

  it("ignores hand-typed messages that merely mention ChatGPT", () => {
    const unrelatedTexts = [
      "I asked ChatGPT about this paper and it agreed",
      // Real hand-typed post sharing a ChatGPT link (C090SGVRM7Z, ts 1790103116.704819).
      "this is the most exciting paper i've come across in a while\n\n<https://chatgpt.com/share/6ab2ce2a|chatgpt.com/share/…>",
      `${trail(CHATGPT.botUserId)} was in the footer of Judd's last post, see above`,
    ];
    for (const text of unrelatedTexts) {
      expect(matchesSlackAppMessageTrigger({ triggers, message: { user: JUDD, text } })).toBe(
        false,
      );
    }
  });

  it("ignores other users even with assistant attribution", () => {
    for (const message of [claudeSentMessage, chatGptSentMessage]) {
      expect(
        matchesSlackAppMessageTrigger({ triggers, message: { ...message, user: "U02PCSCSNSH" } }),
      ).toBe(false);
    }
  });

  it("ignores assistant apps that are not configured", () => {
    expect(
      matchesSlackAppMessageTrigger({
        triggers,
        message: { user: JUDD, app_id: "A0B42PJP3V3", text: `Draft. ${trail("U0B3ZU3U7PV")}` },
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
