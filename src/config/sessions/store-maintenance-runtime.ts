// Runtime maintenance config reads current config and falls back for narrow helpers/tests.
import { getRuntimeConfig } from "../config.js";
import type { SessionConfig, SessionMaintenanceConfig } from "../types.base.js";
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
