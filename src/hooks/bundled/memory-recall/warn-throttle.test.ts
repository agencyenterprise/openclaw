import { describe, expect, it } from "vitest";
import { createThrottledWarn } from "./warn-throttle.js";

describe("createThrottledWarn", () => {
  it("emits once per interval", () => {
    const seen: string[] = [];
    let clock = 0;
    const warn = createThrottledWarn((message) => seen.push(message), {
      intervalMs: 60_000,
      now: () => clock,
    });

    expect(warn("a")).toBe(true);
    clock = 30_000;
    expect(warn("b")).toBe(false);
    clock = 60_000;
    expect(warn("c")).toBe(true);
    expect(seen).toEqual(["a", "c"]);
  });
});
