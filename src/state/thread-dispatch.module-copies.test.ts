import { afterEach, expect, it, vi } from "vitest";
import {
  cleanupIdentity,
  fenceFixture,
  removeFenceFixtures,
  verifiedResult,
} from "./thread-dispatch.fence-fixture.test-support.js";
import * as core from "./thread-dispatch.js";

afterEach(() => {
  removeFenceFixtures();
});

/**
 * A second, independently evaluated copy of the module: what a plugin loaded
 * through jiti gets when it imports the plugin SDK (the Slack channel does).
 */
async function pluginCopy(): Promise<typeof core> {
  vi.resetModules();
  const copy = await import("./thread-dispatch.js");
  expect(copy.withLogicalChannelDispatch).not.toBe(core.withLogicalChannelDispatch);
  return copy;
}

const refusedResult = () => ({ meta: { refused: true } });

it("a turn the plugin copy opens runs its core reply and native attempt and settles TERMINAL", async () => {
  const plugin = await pluginCopy();
  const { db, turn, nativeStates } = fenceFixture();
  try {
    await plugin.withLogicalChannelDispatch({
      ...turn("a"),
      run: () =>
        core.withLogicalReplyDispatch({
          ...turn("a"),
          run: async () =>
            core.runLogicalNativeAttempt({
              sessionKey: "session",
              cleanupIdentity,
              refused: refusedResult,
              run: verifiedResult,
            }),
        }),
    });
    expect(nativeStates()).toEqual(["TERMINAL"]);
  } finally {
    db.close();
  }
});

it("core admits a child process claim under a turn the plugin copy opened", async () => {
  const plugin = await pluginCopy();
  const { db, turn, claims } = fenceFixture();
  try {
    await plugin.withLogicalChannelDispatch({
      ...turn("a"),
      run: async () => {
        core.admitDispatchChild({ command: "true" })?.();
      },
    });
    expect(claims().map((claim) => claim.kind)).toEqual(["native", "process_child"]);
  } finally {
    db.close();
  }
});

it("a busy refusal from one copy is recognized by the other", async () => {
  const plugin = await pluginCopy();
  const { db, turn } = fenceFixture();
  try {
    let busy: unknown;
    await plugin.withLogicalChannelDispatch({
      ...turn("a"),
      run: async () => {
        busy = await core
          .withThreadDispatch({
            config: turn("b").config,
            sessionKey: "session",
            operationId: "native:second",
            kind: "native",
            identity: {},
            run: async () => undefined,
            terminalReceipt: () => undefined,
          })
          .catch((error: unknown) => error);
      },
    });
    expect(busy).toBeInstanceOf(plugin.NativeDispatchBusyError);
    expect(core.readNativeAdmissionBusy(busy)).toBeDefined();
    expect(plugin.readNativeAdmissionBusy(busy)).toBeDefined();
  } finally {
    db.close();
  }
});
