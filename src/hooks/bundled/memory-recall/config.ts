// Config for the memory-recall hook, read from `hooks.internal.entries.memory-recall`.
// The injection limits are hard caps and the message-length floor is a hard minimum: config
// may tighten them, never loosen them. `timeoutMs` is the exception — Hindsight recall alone
// costs 3s at rest, so config may raise it above the default, up to its own hard ceiling.
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveHookConfig } from "../../config.js";

export const MEMORY_RECALL_HOOK_KEY = "memory-recall";

export type MemoryRecallConfig = {
  enabled: boolean;
  maxItems: number;
  maxChars: number;
  minMessageChars: number;
  timeoutMs: number;
};

export const DEFAULT_MEMORY_RECALL_CONFIG: MemoryRecallConfig = {
  enabled: false,
  maxItems: 6,
  maxChars: 1500,
  minMessageChars: 25,
  timeoutMs: 7000,
};

/** Hard ceiling for `timeoutMs`: config may raise the default up to here, never past it. */
export const MEMORY_RECALL_TIMEOUT_CAP_MS = 9000;

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readCappedInteger(value: unknown, cap: number): number {
  return readBoundedInteger(value, cap, cap);
}

/** Read a positive integer, falling back to `fallback`, and never exceed `cap`. */
function readBoundedInteger(value: unknown, fallback: number, cap: number): number {
  return Math.min(readPositiveInteger(value, fallback), cap);
}

export function resolveMemoryRecallConfig(cfg: OpenClawConfig | null): MemoryRecallConfig {
  const hookConfig = cfg ? resolveHookConfig(cfg, MEMORY_RECALL_HOOK_KEY) : undefined;
  const defaults = DEFAULT_MEMORY_RECALL_CONFIG;
  return {
    enabled: hookConfig?.enabled === true,
    maxItems: readCappedInteger(hookConfig?.maxItems, defaults.maxItems),
    maxChars: readCappedInteger(hookConfig?.maxChars, defaults.maxChars),
    minMessageChars: Math.max(
      defaults.minMessageChars,
      readPositiveInteger(hookConfig?.minMessageChars, defaults.minMessageChars),
    ),
    timeoutMs: readBoundedInteger(
      hookConfig?.timeoutMs,
      defaults.timeoutMs,
      MEMORY_RECALL_TIMEOUT_CAP_MS,
    ),
  };
}
