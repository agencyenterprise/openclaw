import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it } from "vitest";
import { beginNativeEffectPhase, withNativeCleanupTracking } from "./native-cleanup-proof.js";

it("passes for the run's own open tracking identity", async () => {
  await withNativeCleanupTracking("identity-A", async () => {
    expect(() => beginNativeEffectPhase("identity-A")).not.toThrow();
    return {};
  });
});

it("passes for an untracked run outside any tracking context", () => {
  expect(() => beginNativeEffectPhase(undefined)).not.toThrow();
});

it("refuses a tracked run whose context is missing", () => {
  expect(() => beginNativeEffectPhase("identity-A")).toThrow("NATIVE_CLEANUP_OWNER_MISMATCH");
});

it("refuses another run's context, tracked or untracked", async () => {
  await withNativeCleanupTracking("identity-A", async () => {
    expect(() => beginNativeEffectPhase("identity-B")).toThrow("NATIVE_CLEANUP_OWNER_MISMATCH");
    expect(() => beginNativeEffectPhase(undefined)).toThrow("NATIVE_CLEANUP_OWNER_MISMATCH");
    return {};
  });
});

it("refuses once the owner closed", async () => {
  let enterLate!: () => void;
  await withNativeCleanupTracking("identity-A", async () => {
    const runInOwnerContext = AsyncLocalStorage.snapshot();
    enterLate = () => runInOwnerContext(() => beginNativeEffectPhase("identity-A"));
    return {};
  });
  expect(enterLate).toThrow("NATIVE_CLEANUP_OWNER_CLOSED");
});
