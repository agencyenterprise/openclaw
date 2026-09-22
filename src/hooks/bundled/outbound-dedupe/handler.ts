/**
 * Outbound Dedupe hook — Constitution Article 7 (Signal).
 *
 * Registers a cancel-capable `message_sending` core hook (src/plugins/core-hooks.ts)
 * when this module loads, which happens while the gateway loads internal hooks
 * and before `gateway:startup`. Core hooks are composed into every plugin hook
 * dispatch and survive plugin registry re-activation. A send whose normalized
 * text matches a send in the same channel + thread within `windowHours` is
 * cancelled before it reaches Slack. Cron announces and heartbeat replies pass
 * through the same guard because every outbound path runs `message_sending`.
 *
 * A hash is reserved as pending at `message_sending`, confirmed by the internal
 * `message:sent` event on success, released on failure, and expires unconfirmed
 * after two minutes, so a retry after a failed send is never suppressed.
 */

import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { hasCoreHook, registerCoreHook } from "../../../plugins/core-hooks.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import type { MessageSentHookContext } from "../../internal-hooks.js";
import { resolveHookWorkspaceDir } from "../../workspace-state.js";
import {
  createOutboundDedupeGuard,
  createOutboundSentRecorder,
  DEFAULT_OUTBOUND_DEDUPE_CONFIG,
  type OutboundDedupeConfig,
  type OutboundDedupeDeps,
  type OutboundSentRecorder,
} from "./guard.js";

const log = createSubsystemLogger("hooks/outbound-dedupe");

export const OUTBOUND_DEDUPE_PLUGIN_ID = "fractal-outbound-dedupe";
const GUARD_TIMEOUT_MS = 5_000;

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

export function resolveOutboundDedupeConfig(cfg: OpenClawConfig | null): OutboundDedupeConfig {
  const hookConfig = cfg ? resolveHookConfig(cfg, "outbound-dedupe") : undefined;
  return {
    windowHours: readPositiveNumber(
      hookConfig?.windowHours,
      DEFAULT_OUTBOUND_DEDUPE_CONFIG.windowHours,
    ),
    maxPerThread: readPositiveInteger(
      hookConfig?.maxPerThread,
      DEFAULT_OUTBOUND_DEDUPE_CONFIG.maxPerThread,
    ),
    minChars: readPositiveNumber(hookConfig?.minChars, DEFAULT_OUTBOUND_DEDUPE_CONFIG.minChars),
  };
}

/** Register the pre-send guard as a core plugin hook. Idempotent. */
export function registerOutboundDedupeGuard(deps: OutboundDedupeDeps): void {
  registerCoreHook({
    pluginId: OUTBOUND_DEDUPE_PLUGIN_ID,
    hookName: "message_sending",
    handler: createOutboundDedupeGuard(deps),
    timeoutMs: GUARD_TIMEOUT_MS,
  });
}

/** Internal hook: verifies the guard at startup and confirms/releases reservations on message:sent. */
export function createOutboundDedupeHandler(recordSent: OutboundSentRecorder): HookHandler {
  return async (event) => {
    if (event.type === "gateway" && event.action === "startup") {
      if (hasCoreHook(OUTBOUND_DEDUPE_PLUGIN_ID, "message_sending")) {
        log.info("outbound-dedupe: message_sending guard is registered");
      } else {
        log.error("outbound-dedupe: message_sending guard is NOT registered; sends are unguarded");
      }
      return;
    }
    if (event.type === "message" && event.action === "sent") {
      await recordSent(event.context as MessageSentHookContext, event.sessionKey);
    }
  };
}

const runtimeDeps: OutboundDedupeDeps = {
  resolveWorkspaceDir: (sessionKey) => resolveHookWorkspaceDir(sessionKey),
  resolveConfig: () => resolveOutboundDedupeConfig(getRuntimeConfigSnapshot()),
};

registerOutboundDedupeGuard(runtimeDeps);

const outboundDedupeHook = createOutboundDedupeHandler(createOutboundSentRecorder(runtimeDeps));

export default outboundDedupeHook;
