import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasCoreHook, listCoreHooks } from "../../../plugins/core-hooks.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import { DEFAULT_LANE_ESTIMATES, DEFAULT_LANE_PATTERNS } from "./classify.js";
import { DEFAULT_LANE_ALWAYS_CANCEL, DEFAULT_LANE_GUARD_CONFIG } from "./guard.js";
import laneGuardHook, { LANE_GUARD_PLUGIN_ID, resolveLaneGuardConfig } from "./handler.js";

function configWith(entry: Record<string, unknown>): OpenClawConfig {
  return {
    hooks: { internal: { entries: { "lane-guard": { enabled: true, ...entry } } } },
  } as OpenClawConfig;
}

describe("lane-guard handler", () => {
  it("registers the before_tool_call guard as a core hook when the module loads", () => {
    expect(hasCoreHook(LANE_GUARD_PLUGIN_ID, "before_tool_call")).toBe(true);
    expect(listCoreHooks().filter((hook) => hook.pluginId === LANE_GUARD_PLUGIN_ID)).toHaveLength(
      1,
    );
  });

  it("keeps the shipped defaults when the hook has no config block", () => {
    expect(resolveLaneGuardConfig(null)).toEqual(DEFAULT_LANE_GUARD_CONFIG);
    expect(resolveLaneGuardConfig({} as OpenClawConfig).enforce).toEqual({
      heartbeat: true,
      cron: true,
      human: false,
    });
    expect(resolveLaneGuardConfig({} as OpenClawConfig).alwaysCancel).toEqual(
      DEFAULT_LANE_ALWAYS_CANCEL,
    );
  });

  it("takes enforcement from config per kind, keeping the default for the kinds it omits", () => {
    const resolved = resolveLaneGuardConfig(configWith({ enforce: { human: true, cron: false } }));
    expect(resolved.enforce).toEqual({ heartbeat: true, cron: false, human: true });
  });

  it("takes alwaysCancel from config, including an explicitly empty list", () => {
    expect(
      resolveLaneGuardConfig(configWith({ alwaysCancel: ["api_calls"] })).alwaysCancel,
    ).toEqual(["api_calls"]);
    expect(resolveLaneGuardConfig(configWith({ alwaysCancel: [] })).alwaysCancel).toEqual([]);
  });

  it("takes patterns and estimates from config, per class", () => {
    const resolved = resolveLaneGuardConfig(
      configWith({
        patterns: { runpod: ["\\bvast\\s+create\\b"] },
        estimates: { runpod: 12, api_calls: 0 },
      }),
    );
    expect(resolved.patterns.runpod).toEqual(["\\bvast\\s+create\\b"]);
    expect(resolved.patterns.silico).toEqual(DEFAULT_LANE_PATTERNS.silico);
    expect(resolved.estimates.runpod).toBe(12);
    expect(resolved.estimates.api_calls).toBe(0);
    expect(resolved.estimates.silico).toBe(DEFAULT_LANE_ESTIMATES.silico);
  });

  it("falls back to the defaults for malformed entries instead of gating on junk", () => {
    const resolved = resolveLaneGuardConfig(
      configWith({
        enforce: { heartbeat: "yes", human: true },
        alwaysCancel: ["publish_external", "publish-external"],
        patterns: { runpod: ["ok", 7], local_cpu: "systemd-run" },
        estimates: { runpod: -1, api_calls: "free" },
      }),
    );
    expect(resolved.enforce).toEqual({ heartbeat: true, cron: true, human: true });
    expect(resolved.alwaysCancel).toEqual(DEFAULT_LANE_ALWAYS_CANCEL);
    expect(resolved.patterns.runpod).toEqual(DEFAULT_LANE_PATTERNS.runpod);
    expect(resolved.patterns.local_cpu).toEqual(DEFAULT_LANE_PATTERNS.local_cpu);
    expect(resolved.estimates.runpod).toBe(DEFAULT_LANE_ESTIMATES.runpod);
    expect(resolved.estimates.api_calls).toBe(DEFAULT_LANE_ESTIMATES.api_calls);
  });

  it("only reports on gateway startup and ignores other internal events", () => {
    expect(
      laneGuardHook(createInternalHookEvent("gateway", "startup", "gateway:startup")),
    ).toBeUndefined();
    expect(
      laneGuardHook(createInternalHookEvent("message", "received", "agent:main:main")),
    ).toBeUndefined();
    expect(hasCoreHook(LANE_GUARD_PLUGIN_ID, "before_tool_call")).toBe(true);
  });
});
