import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasCoreHook, listCoreHooks } from "../../../plugins/core-hooks.js";
import { DEFAULT_TURN_GATE_CONFIG } from "./gate.js";
import { resolveTurnGateConfig, TURN_GATE_PLUGIN_ID } from "./handler.js";

function configWith(entry: Record<string, unknown>): OpenClawConfig {
  return {
    hooks: { internal: { entries: { "turn-gate": entry } } },
  } as unknown as OpenClawConfig;
}

describe("turn-gate handler", () => {
  it("registers the agent_end gate as a core hook when the module loads", () => {
    expect(hasCoreHook(TURN_GATE_PLUGIN_ID, "agent_end")).toBe(true);
    expect(listCoreHooks().filter((hook) => hook.pluginId === TURN_GATE_PLUGIN_ID)).toHaveLength(1);
  });

  it("reads config overrides and falls back to defaults", () => {
    expect(resolveTurnGateConfig(null)).toEqual(DEFAULT_TURN_GATE_CONFIG);
    expect(
      resolveTurnGateConfig(
        configWith({ enabled: true, phrases: ["kicking off"], commandMarkers: [42] }),
      ),
    ).toEqual({
      phrases: ["kicking off"],
      commandMarkers: DEFAULT_TURN_GATE_CONFIG.commandMarkers,
      repair: DEFAULT_TURN_GATE_CONFIG.repair,
    });
  });

  it("reads the repair block and keeps a default for every unusable value", () => {
    expect(
      resolveTurnGateConfig(
        configWith({ repair: { enabled: false, cooldownMinutes: 5, maxPerDay: 3 } }),
      ).repair,
    ).toEqual({ enabled: false, cooldownMinutes: 5, maxPerDay: 3 });

    expect(
      resolveTurnGateConfig(
        configWith({ repair: { enabled: "no", cooldownMinutes: 0, maxPerDay: "many" } }),
      ).repair,
    ).toEqual(DEFAULT_TURN_GATE_CONFIG.repair);
  });
});
