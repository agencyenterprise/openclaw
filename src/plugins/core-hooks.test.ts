import { afterEach, describe, expect, it } from "vitest";
import {
  CORE_HOOK_SOURCE,
  hasCoreHook,
  listCoreHooks,
  registerCoreHook,
  resetCoreHooksForTest,
  unregisterCoreHook,
} from "./core-hooks.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

afterEach(() => {
  resetCoreHooksForTest();
  resetGlobalHookRunner();
});

describe("core hooks", () => {
  it("registers idempotently by plugin id and hook name", () => {
    const first = () => ({ cancel: true });
    const second = () => undefined;
    registerCoreHook({ pluginId: "core-test", hookName: "message_sending", handler: first });
    registerCoreHook({ pluginId: "core-test", hookName: "message_sending", handler: second });
    registerCoreHook({ pluginId: "core-test", hookName: "agent_end", handler: () => undefined });

    expect(listCoreHooks()).toHaveLength(2);
    expect(listCoreHooks()[0]).toMatchObject({
      pluginId: "core-test",
      hookName: "message_sending",
      handler: second,
      priority: 0,
      source: CORE_HOOK_SOURCE,
    });
    expect(hasCoreHook("core-test", "agent_end")).toBe(true);
    expect(unregisterCoreHook("core-test", "agent_end")).toBe(true);
    expect(hasCoreHook("core-test", "agent_end")).toBe(false);
  });

  it("dispatches through the global hook runner and survives registry re-activation", async () => {
    const seen: string[] = [];
    registerCoreHook({
      pluginId: "core-test",
      hookName: "message_sending",
      handler: (event) => {
        seen.push(event.content);
        return { cancel: true, cancelReason: "core-test" };
      },
    });

    initializeGlobalHookRunner(createMockPluginRegistry([]));
    const runner = getGlobalHookRunner();
    expect(runner?.hasHooks("message_sending")).toBe(true);
    await expect(
      runner?.runMessageSending({ to: "chat", content: "one" }, { channelId: "slack" }),
    ).resolves.toMatchObject({ cancel: true, cancelReason: "core-test" });

    initializeGlobalHookRunner(createMockPluginRegistry([]));
    await getGlobalHookRunner()?.runMessageSending(
      { to: "chat", content: "two" },
      { channelId: "slack" },
    );
    expect(seen).toEqual(["one", "two"]);
  });

  it("dispatches a core hook registered after the runner was initialized", async () => {
    initializeGlobalHookRunner(createMockPluginRegistry([]));
    const runner = getGlobalHookRunner();
    expect(runner?.hasHooks("agent_end")).toBe(false);

    let calls = 0;
    registerCoreHook({
      pluginId: "core-test",
      hookName: "agent_end",
      handler: () => {
        calls += 1;
      },
    });

    expect(runner?.hasHooks("agent_end")).toBe(true);
    await runner?.runAgentEnd({ messages: [], success: true }, { sessionKey: "agent:main:main" });
    expect(calls).toBe(1);
  });

  it("runs alongside plugin-registered hooks for the same name", async () => {
    const order: string[] = [];
    registerCoreHook({
      pluginId: "core-test",
      hookName: "message_sending",
      handler: () => {
        order.push("core");
        return undefined;
      },
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "message_sending",
          priority: 10,
          handler: () => {
            order.push("plugin");
            return undefined;
          },
        },
      ]),
    );
    await getGlobalHookRunner()?.runMessageSending(
      { to: "chat", content: "x" },
      { channelId: "slack" },
    );
    expect(order).toEqual(["plugin", "core"]);
  });
});
