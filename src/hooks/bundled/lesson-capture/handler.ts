/**
 * Lesson Capture hook — Constitution Article 5.5 / Article 8 (Learning).
 *
 * Registers an `agent_end` core hook (src/plugins/core-hooks.ts) when this
 * module loads, which happens while the gateway loads internal hooks and
 * before `gateway:startup`; core hooks survive plugin registry re-activation.
 * `agent_end` is the turn-end event that carries the message transcript
 * (session_end and subagent_ended do not), and sub-agent turns run through the
 * same runner, so one handler covers main, thread, cron and sub-agent
 * sessions. Turns whose last human text is a correction, or whose last
 * assistant text carries a result/verdict/closure, become records in
 * `<workspace>/state/lesson_candidates.jsonl`. No model call, no MEMORY.md,
 * no Hindsight: a reviewed reflect job promotes candidates later.
 */

import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { hasCoreHook, registerCoreHook } from "../../../plugins/core-hooks.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { resolveHookWorkspaceDir } from "../../workspace-state.js";
import { createLessonCaptureHandler, type LessonCaptureHandler } from "./capture.js";
import { DEFAULT_LESSON_TRIGGERS, type LessonTriggerConfig } from "./triggers.js";

const log = createSubsystemLogger("hooks/lesson-capture");

export const LESSON_CAPTURE_PLUGIN_ID = "fractal-lesson-capture";
const CAPTURE_TIMEOUT_MS = 10_000;

function readStringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : fallback;
}

export function resolveLessonTriggerConfig(cfg: OpenClawConfig | null): LessonTriggerConfig {
  const hookConfig = cfg ? resolveHookConfig(cfg, "lesson-capture") : undefined;
  return {
    resultTriggers: readStringList(
      hookConfig?.resultTriggers,
      DEFAULT_LESSON_TRIGGERS.resultTriggers,
    ),
    correctionTriggers: readStringList(
      hookConfig?.correctionTriggers,
      DEFAULT_LESSON_TRIGGERS.correctionTriggers,
    ),
  };
}

/** Register the capture as an `agent_end` core hook. Idempotent. */
export function registerLessonCapture(capture: LessonCaptureHandler): void {
  registerCoreHook({
    pluginId: LESSON_CAPTURE_PLUGIN_ID,
    hookName: "agent_end",
    handler: capture,
    timeoutMs: CAPTURE_TIMEOUT_MS,
  });
}

/** Internal hook: verifies at gateway startup that the capture is registered. */
const lessonCaptureHook: HookHandler = (event) => {
  if (event.type !== "gateway" || event.action !== "startup") {
    return;
  }
  if (hasCoreHook(LESSON_CAPTURE_PLUGIN_ID, "agent_end")) {
    log.info("lesson-capture: agent_end capture is registered");
  } else {
    log.error("lesson-capture: agent_end capture is NOT registered; no candidates captured");
  }
};

registerLessonCapture(
  createLessonCaptureHandler({
    resolveWorkspaceDir: (sessionKey) => resolveHookWorkspaceDir(sessionKey),
    resolveTriggers: () => resolveLessonTriggerConfig(getRuntimeConfigSnapshot()),
  }),
);

export default lessonCaptureHook;
