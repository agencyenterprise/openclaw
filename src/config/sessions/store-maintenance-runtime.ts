// Runtime maintenance config reads current config and falls back for narrow helpers/tests.
import { getRuntimeConfig } from "../config.js";
import type { SessionConfig, SessionMaintenanceConfig } from "../types.base.js";
import { resolveStorePath } from "./paths.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

function readRuntimeSessionConfig(): SessionConfig | undefined {
  try {
    return getRuntimeConfig().session;
  } catch {
    // Config may not be available in narrow test/runtime helpers.
    return undefined;
  }
}

export function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig {
  const maintenance: SessionMaintenanceConfig | undefined = readRuntimeSessionConfig()?.maintenance;
  return resolveMaintenanceConfigFromInput(maintenance);
}

/**
 * Session store path that scopes work admissions for one agent.
 *
 * Work admissions are registered under the session store path the runtime
 * resolves for the agent (see `beginSessionWorkAdmission` callers), so any
 * consumer that only knows the agent must resolve the same path to find them.
 */
export function resolveSessionStorePathForAgent(agentId?: string): string {
  return resolveStorePath(readRuntimeSessionConfig()?.store, agentId ? { agentId } : {});
}
