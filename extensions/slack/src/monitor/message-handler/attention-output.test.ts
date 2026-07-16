import { describe, expect, it } from "vitest";
import { shouldSuppressRecentSlackDuplicate } from "./dispatch.js";

describe("attention-aware Slack output", () => {
  it("suppresses an exact duplicate in the same thread within the TTL", () => {
    const key = `C123:${Math.random()}`;
    expect(
      shouldSuppressRecentSlackDuplicate({ threadKey: key, text: "Same answer", nowMs: 1_000 }),
    ).toBe(false);
    expect(
      shouldSuppressRecentSlackDuplicate({
        threadKey: key,
        text: "  Same   answer ",
        nowMs: 2_000,
      }),
    ).toBe(true);
  });

  it("allows changed content and later restatements", () => {
    const key = `C123:${Math.random()}`;
    expect(
      shouldSuppressRecentSlackDuplicate({
        threadKey: key,
        text: "First answer",
        nowMs: 1_000,
        ttlMs: 100,
      }),
    ).toBe(false);
    expect(
      shouldSuppressRecentSlackDuplicate({
        threadKey: key,
        text: "Changed answer",
        nowMs: 1_050,
        ttlMs: 100,
      }),
    ).toBe(false);
    expect(
      shouldSuppressRecentSlackDuplicate({
        threadKey: key,
        text: "First answer",
        nowMs: 1_200,
        ttlMs: 100,
      }),
    ).toBe(false);
  });
});
