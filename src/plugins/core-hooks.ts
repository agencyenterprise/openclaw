// Core-contributed typed plugin hooks. Bundled runtime code (for example the
// internal hooks under src/hooks/bundled) registers cancel-capable plugin hooks
// here instead of into a plugin registry: registrations live in a global
// singleton, are composed into every hook dispatch, and survive plugin
// registry re-activation.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginHookName, PluginHookRegistration } from "./hook-types.js";

export const CORE_HOOK_SOURCE = "openclaw-core";

export type CoreHookRegistration<K extends PluginHookName = PluginHookName> = {
  pluginId: string;
  hookName: K;
  handler: PluginHookRegistration<K>["handler"];
  priority?: number;
  timeoutMs?: number;
};

const CORE_HOOKS_KEY = Symbol.for("openclaw.coreHookRegistrations");
const coreHooks = resolveGlobalSingleton<Map<string, PluginHookRegistration>>(
  CORE_HOOKS_KEY,
  () => new Map<string, PluginHookRegistration>(),
);

function coreHookKey(pluginId: string, hookName: string): string {
  return `${pluginId} ${hookName}`;
}

/** Register (or replace) one core hook. Keyed by plugin id + hook name, so re-registration is idempotent. */
export function registerCoreHook<K extends PluginHookName>(hook: CoreHookRegistration<K>): void {
  coreHooks.set(coreHookKey(hook.pluginId, hook.hookName), {
    pluginId: hook.pluginId,
    hookName: hook.hookName,
    handler: hook.handler,
    priority: hook.priority ?? 0,
    ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
    source: CORE_HOOK_SOURCE,
  });
}

export function unregisterCoreHook(pluginId: string, hookName: PluginHookName): boolean {
  return coreHooks.delete(coreHookKey(pluginId, hookName));
}

export function hasCoreHook(pluginId: string, hookName: PluginHookName): boolean {
  return coreHooks.has(coreHookKey(pluginId, hookName));
}

export function listCoreHooks(): PluginHookRegistration[] {
  return [...coreHooks.values()];
}

export function resetCoreHooksForTest(): void {
  coreHooks.clear();
}
