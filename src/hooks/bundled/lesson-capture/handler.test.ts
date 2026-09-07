import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasCoreHook, listCoreHooks } from "../../../plugins/core-hooks.js";
import { LESSON_CAPTURE_PLUGIN_ID, resolveLessonTriggerConfig } from "./handler.js";
import { DEFAULT_LESSON_TRIGGERS } from "./triggers.js";

describe("lesson-capture handler", () => {
  it("registers the agent_end capture as a core hook when the module loads", () => {
    expect(hasCoreHook(LESSON_CAPTURE_PLUGIN_ID, "agent_end")).toBe(true);
    expect(
      listCoreHooks().filter((hook) => hook.pluginId === LESSON_CAPTURE_PLUGIN_ID),
    ).toHaveLength(1);
  });

  it("reads trigger lists from config with defaults for missing or invalid values", () => {
    expect(resolveLessonTriggerConfig(null)).toEqual(DEFAULT_LESSON_TRIGGERS);
    const cfg = {
      hooks: {
        internal: {
          entries: {
            "lesson-capture": {
              enabled: true,
              resultTriggers: ["DONE"],
              correctionTriggers: "nope",
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveLessonTriggerConfig(cfg)).toEqual({
      resultTriggers: ["DONE"],
      correctionTriggers: DEFAULT_LESSON_TRIGGERS.correctionTriggers,
    });
  });
});
