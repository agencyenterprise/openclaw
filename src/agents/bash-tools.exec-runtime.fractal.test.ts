import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOREGROUND_EXEC_TIMEOUT_MS,
  resolveExecTimeoutMs,
} from "./bash-tools.exec-runtime.js";

describe("Fractal foreground exec timeout", () => {
  it("caps foreground exec by default while leaving background completion uncapped", () => {
    expect(resolveExecTimeoutMs(undefined, false)).toBe(DEFAULT_FOREGROUND_EXEC_TIMEOUT_MS);
    expect(resolveExecTimeoutMs(undefined, true)).toBeUndefined();
    expect(resolveExecTimeoutMs(12, false)).toBe(12_000);
    expect(resolveExecTimeoutMs(12, true)).toBe(12_000);
  });
});
