import { describe, expect, it } from "vitest";
import {
  extractSlackChannelFromSessionKey,
  extractSlackThreadTsFromSessionKey,
  isSlackDirectMessageChannel,
  isSlackTs,
  normalizeSlackTarget,
} from "./slack-thread.js";

describe("slack-thread helpers", () => {
  const sessionKey = "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609";

  it("reads channel and thread from a thread session key", () => {
    expect(extractSlackChannelFromSessionKey(sessionKey)).toBe("C0A3C98HS48");
    expect(extractSlackThreadTsFromSessionKey(sessionKey)).toBe("1786591963.108609");
  });

  it("returns undefined for keys without a Slack thread", () => {
    expect(extractSlackChannelFromSessionKey("agent:main:main")).toBeUndefined();
    expect(extractSlackThreadTsFromSessionKey("agent:main:slack:channel:c123")).toBeUndefined();
  });

  it("normalizes delivery targets", () => {
    expect(normalizeSlackTarget("channel:C0A3C98HS48")).toBe("C0A3C98HS48");
    expect(normalizeSlackTarget("c0a3c98hs48")).toBe("C0A3C98HS48");
    expect(normalizeSlackTarget("user:U123")).toBe("U123");
    expect(normalizeSlackTarget("  ")).toBeUndefined();
  });

  it("recognizes Slack timestamps and DM channels", () => {
    expect(isSlackTs("1786591963.108609")).toBe(true);
    expect(isSlackTs("channel")).toBe(false);
    expect(isSlackDirectMessageChannel("D0BPP782T2B")).toBe(true);
    expect(isSlackDirectMessageChannel("C0BPP782T2B")).toBe(false);
  });
});
