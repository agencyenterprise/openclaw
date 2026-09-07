/**
 * Lane Guard hook — SOUL Articles A3.2, A4.1, A9 (lane authorization and budget).
 *
 * Registers a cancel-capable `before_tool_call` core hook
 * (src/plugins/core-hooks.ts) when this module loads, which happens while the
 * gateway loads internal hooks and before `gateway:startup`. Core hooks are
 * composed into every plugin hook dispatch and survive plugin registry
 * re-activation.
 *
 * Only `exec`/`bash` commands that a config-extensible regex table classifies as
 * spending or publishing (runpod, silico, spark_gpu, local_cpu, api_calls,
 * publish_external) are gated; everything else passes untouched. A classified
 * command must run under an active lane authorized in the thread — by
 * `origin.thread_ts`, by the permalink's `thread_ts=` query, or by the message
 * its permalink names being the thread root or a reply the ask ledger places in
 * the thread — or under one named inline with `# lane:<id>`. Several lanes can
 * cover one thread, and the one charged is the first that allows every class the
 * command charges. Authorization and budget are decided by
 * `<workspace>/scripts/lane.py`, never re-derived here, and an allowed command
 * reserves its estimate against the lane. Every classified command appends one
 * line to `<workspace>/state/lane_guard.jsonl` under the shared file lock.
 *
 * Enforcement is per session kind: `enforce.heartbeat` and `enforce.cron` are
 * true by default, so unattended work is cancelled when it has no lane, and
 * `enforce.human` is false, so a person's own thread is only audited. Whatever
 * the kind, an `alwaysCancel` class is cancelled unless the lane explicitly
 * allows it.
 */

import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { hasCoreHook, registerCoreHook } from "../../../plugins/core-hooks.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { resolveHookWorkspaceDir } from "../../workspace-state.js";
import {
  DEFAULT_LANE_ESTIMATES,
  DEFAULT_LANE_PATTERNS,
  LANE_ACTION_CLASSES,
  type LaneActionClass,
  type LaneEstimateTable,
  type LanePatternTable,
} from "./classify.js";
import {
  createLaneGuard,
  DEFAULT_LANE_ALWAYS_CANCEL,
  DEFAULT_LANE_ENFORCEMENT,
  DEFAULT_LANE_GUARD_CONFIG,
  type LaneEnforcementTable,
  type LaneGuardConfig,
} from "./guard.js";
import { LANE_SESSION_KINDS } from "./session-kind.js";

const log = createSubsystemLogger("hooks/lane-guard");

export const LANE_GUARD_PLUGIN_ID = "fractal-lane-guard";
const GUARD_TIMEOUT_MS = 20_000;

function readPatternList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : fallback;
}

function readEstimate(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readTable(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * A non-boolean here is loud, not silent: `"human": "true"` is a common
 * templating slip, and falling back to the default quietly would leave an
 * operator believing they turned enforcement on.
 */
function readEnforcement(value: unknown): LaneEnforcementTable {
  const configured = readTable(value);
  return Object.fromEntries(
    LANE_SESSION_KINDS.map((kind) => {
      const raw = configured[kind];
      if (typeof raw === "boolean") {
        return [kind, raw];
      }
      if (raw !== undefined) {
        log.error(
          `lane-guard: enforce.${kind} must be a boolean, got ${JSON.stringify(raw)}; using the default ${DEFAULT_LANE_ENFORCEMENT[kind]}`,
        );
      }
      return [kind, DEFAULT_LANE_ENFORCEMENT[kind]];
    }),
  ) as LaneEnforcementTable;
}

function isLaneActionClass(value: unknown): value is LaneActionClass {
  return (LANE_ACTION_CLASSES as readonly string[]).includes(value as string);
}

/**
 * An empty list is an explicit choice and stays empty, the same way an empty
 * pattern list switches a class off. A list holding anything that is not an
 * action class is junk, and falling back beats gating on a typo.
 */
function readAlwaysCancel(value: unknown): LaneActionClass[] {
  if (value === undefined) {
    return DEFAULT_LANE_ALWAYS_CANCEL;
  }
  if (Array.isArray(value) && value.every(isLaneActionClass)) {
    return value;
  }
  log.error(
    `lane-guard: alwaysCancel must list action classes, got ${JSON.stringify(value)}; using the default [${DEFAULT_LANE_ALWAYS_CANCEL.join(", ")}]`,
  );
  return DEFAULT_LANE_ALWAYS_CANCEL;
}

export function resolveLaneGuardConfig(cfg: OpenClawConfig | null): LaneGuardConfig {
  const hookConfig = cfg ? resolveHookConfig(cfg, "lane-guard") : undefined;
  if (!hookConfig) {
    return DEFAULT_LANE_GUARD_CONFIG;
  }
  const patterns = readTable(hookConfig.patterns);
  const estimates = readTable(hookConfig.estimates);
  return {
    enforce: readEnforcement(hookConfig.enforce),
    alwaysCancel: readAlwaysCancel(hookConfig.alwaysCancel),
    patterns: Object.fromEntries(
      LANE_ACTION_CLASSES.map((actionClass) => [
        actionClass,
        readPatternList(patterns[actionClass], DEFAULT_LANE_PATTERNS[actionClass]),
      ]),
    ) as LanePatternTable,
    estimates: Object.fromEntries(
      LANE_ACTION_CLASSES.map((actionClass) => [
        actionClass,
        readEstimate(estimates[actionClass], DEFAULT_LANE_ESTIMATES[actionClass]),
      ]),
    ) as LaneEstimateTable,
  };
}

/** Register the guard as a `before_tool_call` core hook. Idempotent. */
export function registerLaneGuard(): void {
  registerCoreHook({
    pluginId: LANE_GUARD_PLUGIN_ID,
    hookName: "before_tool_call",
    handler: createLaneGuard({
      resolveWorkspaceDir: (sessionKey) => resolveHookWorkspaceDir(sessionKey),
      resolveConfig: () => resolveLaneGuardConfig(getRuntimeConfigSnapshot()),
    }),
    timeoutMs: GUARD_TIMEOUT_MS,
  });
}

function describeEnforcement(enforce: LaneEnforcementTable): string {
  return LANE_SESSION_KINDS.map((kind) => `${kind}=${enforce[kind]}`).join(" ");
}

/** Internal hook: verifies at gateway startup that the guard is registered. */
const laneGuardHook: HookHandler = (event) => {
  if (event.type !== "gateway" || event.action !== "startup") {
    return;
  }
  if (!hasCoreHook(LANE_GUARD_PLUGIN_ID, "before_tool_call")) {
    log.error("lane-guard: before_tool_call guard is NOT registered; spending is ungated");
    return;
  }
  const { enforce, alwaysCancel } = resolveLaneGuardConfig(getRuntimeConfigSnapshot());
  log.info(
    `lane-guard: before_tool_call guard is registered (enforce ${describeEnforcement(enforce)}; alwaysCancel ${alwaysCancel.join(",") || "none"})`,
  );
};

registerLaneGuard();

export default laneGuardHook;
