/**
 * Turn Gate hook — SOUL Article A11 (a commitment is backed by an artifact).
 *
 * Registers an `agent_end` core hook (src/plugins/core-hooks.ts) when this
 * module loads, which happens while the gateway loads internal hooks and before
 * `gateway:startup`; core hooks survive plugin registry re-activation.
 * `agent_end` is the turn-end event that carries the message transcript, so one
 * handler covers main, thread, cron and sub-agent sessions.
 *
 * When the final assistant text promises future work ("Next:", "I'll start it"),
 * the turn must also contain the artifact that arms it: a `register_job.py` /
 * `cron add` / `hcom codex` command, a `cron` tool call, or a `state/jobs.json`
 * written during the turn. The verdict is appended to
 * `<workspace>/state/turn_gate.jsonl`.
 *
 * A promise nothing armed is repaired exactly once. `agent_end` runs before
 * delivery, so it only parks the intent; the internal `message:sent` hook below
 * supplies the ts of the message that made the promise, and the repair turn edits
 * that message rather than adding one to the thread.
 */

import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { hasCoreHook, registerCoreHook } from "../../../plugins/core-hooks.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { isMessageSentEvent } from "../../internal-hooks.js";
import { isSlackTs } from "../../slack-thread.js";
import { resolveHookWorkspaceDir } from "../../workspace-state.js";
import {
  createTurnGateDelivery,
  createTurnGateHandler,
  DEFAULT_TURN_GATE_CONFIG,
  type TurnGateConfig,
  type TurnGateDeps,
  type TurnGateHandler,
} from "./gate.js";
import { createLaneAuthorizer } from "./lane-authorization.js";
import { DEFAULT_TURN_GATE_REPAIR_CONFIG, type TurnGateRepairConfig } from "./repair.js";
import { sendRepairTurn } from "./wake.js";

const log = createSubsystemLogger("hooks/turn-gate");

export const TURN_GATE_PLUGIN_ID = "fractal-turn-gate";

/** `agent_end` now only reads the transcript and writes one line. */
const GATE_TIMEOUT_MS = 10_000;

const SLACK_CHANNEL_ID = "slack";

function readStringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : fallback;
}

function readTable(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** A rate limit is only a limit while it is a positive, finite number. */
function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveRepairConfig(value: unknown): TurnGateRepairConfig {
  const table = readTable(value);
  return {
    enabled:
      typeof table.enabled === "boolean" ? table.enabled : DEFAULT_TURN_GATE_REPAIR_CONFIG.enabled,
    cooldownMinutes: readPositiveNumber(
      table.cooldownMinutes,
      DEFAULT_TURN_GATE_REPAIR_CONFIG.cooldownMinutes,
    ),
    maxPerDay: readPositiveNumber(table.maxPerDay, DEFAULT_TURN_GATE_REPAIR_CONFIG.maxPerDay),
  };
}

export function resolveTurnGateConfig(cfg: OpenClawConfig | null): TurnGateConfig {
  const hookConfig = cfg ? resolveHookConfig(cfg, "turn-gate") : undefined;
  return {
    phrases: readStringList(hookConfig?.phrases, DEFAULT_TURN_GATE_CONFIG.phrases),
    commandMarkers: readStringList(
      hookConfig?.commandMarkers,
      DEFAULT_TURN_GATE_CONFIG.commandMarkers,
    ),
    repair: resolveRepairConfig(hookConfig?.repair),
  };
}

/** Register the gate as an `agent_end` core hook. Idempotent. */
export function registerTurnGate(gate: TurnGateHandler): void {
  registerCoreHook({
    pluginId: TURN_GATE_PLUGIN_ID,
    hookName: "agent_end",
    handler: gate,
    timeoutMs: GATE_TIMEOUT_MS,
  });
}

const turnGateDeps: TurnGateDeps = {
  resolveWorkspaceDir: (sessionKey) => resolveHookWorkspaceDir(sessionKey),
  resolveConfig: () => resolveTurnGateConfig(getRuntimeConfigSnapshot()),
  authorizeLane: createLaneAuthorizer(),
  sendRepair: sendRepairTurn,
};

const onDelivered = createTurnGateDelivery(turnGateDeps);

/**
 * Internal hook. `gateway:startup` verifies the core hook is registered;
 * `message:sent` hands a parked repair the ts it needs. Slack's provider message
 * id is the ts, and it can be the literal `"unknown"` or `"suppressed"`, so only
 * a real ts counts.
 */
const turnGateHook: HookHandler = (event) => {
  if (event.type === "gateway" && event.action === "startup") {
    if (hasCoreHook(TURN_GATE_PLUGIN_ID, "agent_end")) {
      log.info("turn-gate: agent_end gate is registered");
    } else {
      log.error("turn-gate: agent_end gate is NOT registered; commitments are unchecked");
    }
    return;
  }
  if (!isMessageSentEvent(event)) {
    return;
  }
  const { channelId, success, messageId } = event.context;
  if (channelId !== SLACK_CHANNEL_ID || !success || !isSlackTs(messageId) || !event.sessionKey) {
    return;
  }
  void onDelivered({ sessionKey: event.sessionKey, messageId });
};

registerTurnGate(createTurnGateHandler(turnGateDeps));

export default turnGateHook;
