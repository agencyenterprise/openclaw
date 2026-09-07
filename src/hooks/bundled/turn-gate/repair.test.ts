import { describe, expect, it } from "vitest";
import type { TurnToolCall } from "./evidence.js";
import { findMessageEditEvidence, isQuestionOnly, stripQuotedLines } from "./repair.js";

const TS = "1786591999.900001";

function toolCall(name: string, args: unknown): TurnToolCall {
  return { name, text: JSON.stringify(args) };
}

describe("turn-gate question detection", () => {
  const requests = [
    "run the harvest",
    "implement the fix",
    "continue",
    "publish it",
    "What changed? Run the tests.",
    "Please do not deploy staging; run the tests.",
    "kick off the sweep tomorrow",
  ];

  const questions = [
    "what would the harvest cost?",
    "How do I build this?",
    "Can you explain how to deploy?",
    "please do not run this yet",
    "I will not run this.",
    "is the runpod pod still up?",
    "",
    undefined,
  ];

  it.each(requests)("reads %j as a request to execute", (text) => {
    expect(isQuestionOnly(text)).toBe(false);
  });

  it.each(questions)("reads %j as a question", (text) => {
    expect(isQuestionOnly(text)).toBe(true);
  });
});

describe("turn-gate edit evidence", () => {
  it("accepts the message tool editing the exact ts, under either id spelling", () => {
    expect(
      findMessageEditEvidence([toolCall("message", { action: "edit", messageId: TS })], TS),
    ).toBe(`message ${TS} edited`);
    expect(
      findMessageEditEvidence([toolCall("message", { action: "edit", message_id: TS })], TS),
    ).toBe(`message ${TS} edited`);
  });

  it("rejects prose that merely talks about editing the message", () => {
    expect(
      findMessageEditEvidence([toolCall("exec", { command: `echo message edit ${TS}` })], TS),
    ).toBeUndefined();
  });

  it("rejects an edit of a different message and a non-edit action", () => {
    expect(
      findMessageEditEvidence(
        [toolCall("message", { action: "edit", messageId: "1700000000.000001" })],
        TS,
      ),
    ).toBeUndefined();
    expect(
      findMessageEditEvidence([toolCall("message", { action: "send", messageId: TS })], TS),
    ).toBeUndefined();
  });
});

describe("turn-gate quote stripping", () => {
  it("drops blockquote lines and keeps the turn's own text", () => {
    expect(stripQuotedLines("> you said this\nI say that")).toBe("I say that");
  });
});
