// Slack tests cover thread-dispatch refusal and busy detection.
import { describe, expect, it } from "vitest";
import {
  isThreadDispatchBusy,
  isThreadDispatchHeldElsewhere,
  isThreadDispatchRefusal,
} from "./thread-dispatch-refusal.js";

describe("thread-dispatch fence errors", () => {
  it("recognizes the fence's refusal and busy errors", () => {
    expect(isThreadDispatchRefusal(new Error("THREAD_DISPATCH_REFUSED"))).toBe(true);
    expect(isThreadDispatchBusy(new Error("NATIVE_BUSY"))).toBe(true);
    expect(isThreadDispatchHeldElsewhere(new Error("THREAD_DISPATCH_REFUSED"))).toBe(true);
    expect(isThreadDispatchHeldElsewhere(new Error("NATIVE_BUSY"))).toBe(true);
  });

  it("treats every other failure as a real dispatch error", () => {
    expect(isThreadDispatchRefusal(new Error("NATIVE_BUSY"))).toBe(false);
    expect(isThreadDispatchBusy(new Error("THREAD_DISPATCH_REFUSED"))).toBe(false);
    expect(isThreadDispatchHeldElsewhere(new Error("THREAD_DISPATCH_REFUSED: extra"))).toBe(false);
    expect(isThreadDispatchHeldElsewhere(new Error("rate limited"))).toBe(false);
    expect(isThreadDispatchHeldElsewhere("NATIVE_BUSY")).toBe(false);
    expect(isThreadDispatchHeldElsewhere(undefined)).toBe(false);
  });
});
