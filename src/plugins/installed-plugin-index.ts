/** Public installed-plugin-index API for load, refresh, policy hash, and invalidation checks. */
import type { OpenClawConfig } from "../config/types.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import {
  resolveCompatRegistryVersion,
  resolveInstalledPluginIndexPolicyHash,
} from "./installed-plugin-index-policy.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { resolveInstalledPluginIndexRegistry } from "./installed-plugin-index-registry.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type InstalledPluginIndexRefreshReason,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";

export {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  INSTALLED_PLUGIN_INDEX_WARNING,
} from "./installed-plugin-index-types.js";
export type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
  InstalledPluginIndexRefreshReason,
  InstalledPluginInstallRecordInfo,
  LoadInstalledPluginIndexParams,
  RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index-types.js";
export { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
export { diffInstalledPluginIndexInvalidationReasons } from "./installed-plugin-index-invalidation.js";
export { hasMissingConfigPathActivationMetadata } from "./installed-plugin-index-config-path-scope.js";
export { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

function buildInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & { refreshReason?: InstalledPluginIndexRefreshReason },
): { index: InstalledPluginIndex; discovery: PluginDiscoveryResult | undefined } {
  const env = params.env ?? process.env;
  const { candidates, registry, discovery } = resolveInstalledPluginIndexRegistry(params);
  const registryDiagnostics = registry.diagnostics ?? [];
  const diagnostics = [...registryDiagnostics];
  const generatedAtMs = (params.now?.() ?? new Date()).getTime();
  const installRecords = normalizeInstallRecordMap(
    params.installRecords ??
      loadInstalledPluginIndexInstallRecordsSync({
        env,
        ...(params.stateDir ? { stateDir: params.stateDir } : {}),
        ...(params.pluginIndexFilePath ? { filePath: params.pluginIndexFilePath } : {}),
      }),
  );
  const plugins = buildInstalledPluginIndexRecords({
    candidates,
    registry,
    config: params.config,
    diagnostics,
    installRecords,
  });

  return {
    index: {
      version: INSTALLED_PLUGIN_INDEX_VERSION,
      warning: INSTALLED_PLUGIN_INDEX_WARNING,
      hostContractVersion: resolveCompatibilityHostVersion(env),
      compatRegistryVersion: resolveCompatRegistryVersion(),
      migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
      generatedAtMs,
      ...(params.refreshReason ? { refreshReason: params.refreshReason } : {}),
      installRecords,
      plugins,
      diagnostics,
    },
    discovery,
  };
}

export function loadInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams = {},
): InstalledPluginIndex {
  return buildInstalledPluginIndex(params).index;
}

export function loadInstalledPluginIndexWithDiscovery(
  params: LoadInstalledPluginIndexParams = {},
): { index: InstalledPluginIndex; discovery: PluginDiscoveryResult | undefined } {
  return buildInstalledPluginIndex(params);
}

export function refreshInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  return buildInstalledPluginIndex({ ...params, refreshReason: params.reason }).index;
}

export function getInstalledPluginRecord(
  index: InstalledPluginIndex,
  pluginId: string,
): InstalledPluginIndexRecord | undefined {
  return index.plugins.find((plugin) => plugin.pluginId === pluginId);
}

export function isInstalledPluginEnabled(
  index: InstalledPluginIndex,
  pluginId: string,
  config?: OpenClawConfig,
): boolean {
  const record = getInstalledPluginRecord(index, pluginId);
  return record
    ? isInstalledPluginRecordEnabled(record, resolvePluginsConfigContext(config))
    : false;
}

/**
 * Builds an enablement predicate for checking many plugins against one index and config.
 * Record lookup and plugin config normalization run once instead of once per plugin.
 * The predicate snapshots the index records and config at creation; build a new one
 * after mutating either.
 */
export function createInstalledPluginEnabledLookup(
  index: InstalledPluginIndex,
  config?: OpenClawConfig,
): (pluginId: string) => boolean {
  const recordsById = new Map<string, InstalledPluginIndexRecord>();
  for (const record of index.plugins) {
    if (!recordsById.has(record.pluginId)) {
      recordsById.set(record.pluginId, record);
    }
  }
  const configContext = resolvePluginsConfigContext(config);
  return (pluginId) => {
    const record = recordsById.get(pluginId);
    return record ? isInstalledPluginRecordEnabled(record, configContext) : false;
  };
}

type PluginsConfigContext = {
  rootConfig: OpenClawConfig;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
};

function resolvePluginsConfigContext(config?: OpenClawConfig): PluginsConfigContext | undefined {
  return config
    ? { rootConfig: config, normalizedConfig: normalizePluginsConfig(config.plugins) }
    : undefined;
}

function isInstalledPluginRecordEnabled(
  record: InstalledPluginIndexRecord,
  configContext: PluginsConfigContext | undefined,
): boolean {
  if (!configContext) {
    return record.enabled;
  }
  const state = resolveEffectivePluginActivationState({
    id: record.pluginId,
    origin: record.origin,
    config: configContext.normalizedConfig,
    rootConfig: configContext.rootConfig,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
  });
  return state.enabled && (record.enabled || state.explicitlyEnabled);
}
