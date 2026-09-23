import fs from "node:fs";
import path from "node:path";
// Extracts provider public artifacts from plugin metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import { PLUGIN_MANIFEST_FILENAME } from "./manifest.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshotMemoEnvFingerprint } from "./plugin-metadata-snapshot.js";
import { fileFingerprint } from "./plugin-snapshot-fingerprint.js";
import {
  resolveDirectBundledProviderPolicySurface,
  resolveTrustedExternalProviderPolicySurface,
  type BundledProviderPolicySurface,
} from "./provider-policy-surface.js";

type ManifestPluginRecord = PluginManifestRegistry["plugins"][number];
type ProviderPolicyOwnerIndex = ReadonlyMap<string, ManifestPluginRecord>;

type BundledProviderPolicyOwnerIndexMemo = {
  contextKey: string;
  bundledPluginsDir: string;
  overlayManifestPaths: readonly string[];
  manifestFingerprint: string;
  owners: ProviderPolicyOwnerIndex;
};

// Provider policy hooks run per provider on every model-resolution pass, so the
// default manifest scan is memoized per process. The memo is keyed by the
// discovery-relevant env, revalidated against the bundled manifest files on
// every lookup, and dropped by the plugin metadata lifecycle (installed-index
// writes from plugin install/enable, runtime resets, gateway close).
let bundledProviderPolicyOwnerIndexMemo: BundledProviderPolicyOwnerIndexMemo | undefined;

registerPluginMetadataProcessMemoLifecycleClear(() => {
  bundledProviderPolicyOwnerIndexMemo = undefined;
});

function listProviderPolicyRefs(plugin: ManifestPluginRecord): Set<string> {
  const ownedProviders = new Set(
    [...plugin.providers, ...plugin.cliBackends]
      .map((provider) => normalizeProviderId(provider))
      .filter(Boolean),
  );
  const refs = new Set(ownedProviders);
  for (const [rawAlias, rawTarget] of Object.entries(plugin.providerAuthAliases ?? {})) {
    const alias = normalizeProviderId(rawAlias);
    if (alias && ownedProviders.has(normalizeProviderId(rawTarget))) {
      refs.add(alias);
    }
  }
  return refs;
}

function pluginOwnsProviderPolicyRef(
  plugin: ManifestPluginRecord,
  normalizedProviderId: string,
): boolean {
  return listProviderPolicyRefs(plugin).has(normalizedProviderId);
}

function sortPluginsById(plugins: readonly ManifestPluginRecord[]): ManifestPluginRecord[] {
  return plugins.toSorted((left, right) => left.id.localeCompare(right.id));
}

function findBundledProviderPolicyOwner(
  registry: Pick<PluginManifestRegistry, "plugins">,
  normalizedProviderId: string,
): ManifestPluginRecord | undefined {
  return sortPluginsById(registry.plugins).find(
    (plugin) =>
      plugin.origin === "bundled" && pluginOwnsProviderPolicyRef(plugin, normalizedProviderId),
  );
}

// The first bundled plugin by id that owns a provider ref wins, which is the
// plugin findBundledProviderPolicyOwner returns for that ref.
function buildBundledProviderPolicyOwnerIndex(
  registry: Pick<PluginManifestRegistry, "plugins">,
): ProviderPolicyOwnerIndex {
  const owners = new Map<string, ManifestPluginRecord>();
  for (const plugin of sortPluginsById(registry.plugins)) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    for (const ref of listProviderPolicyRefs(plugin)) {
      if (!owners.has(ref)) {
        owners.set(ref, plugin);
      }
    }
  }
  return owners;
}

function listBundledManifestProbePaths(bundledPluginsDir: string): string[] {
  let entryNames: string[];
  try {
    entryNames = fs.readdirSync(bundledPluginsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entryNames
    .toSorted()
    .map((entryName) => path.join(bundledPluginsDir, entryName, PLUGIN_MANIFEST_FILENAME));
}

// Probing the manifest slot of every bundled directory (present or missing)
// detects added, removed, repaired, and edited bundled plugins without
// re-running discovery. Source overlays live outside the bundled directory, so
// their manifests are probed by path.
function fingerprintManifestPaths(manifestPaths: readonly string[]): string {
  return JSON.stringify(manifestPaths.map((manifestPath) => fileFingerprint(manifestPath)));
}

function resolveCurrentManifestFingerprint(
  bundledPluginsDir: string,
  overlayManifestPaths: readonly string[],
): string {
  return fingerprintManifestPaths([
    ...listBundledManifestProbePaths(bundledPluginsDir),
    ...overlayManifestPaths,
  ]);
}

function listOverlayManifestPaths(
  registry: Pick<PluginManifestRegistry, "plugins">,
  bundledPluginsDir: string,
): string[] {
  const bundledRoot = path.resolve(bundledPluginsDir) + path.sep;
  return registry.plugins
    .filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => path.resolve(plugin.manifestPath))
    .filter((manifestPath) => !manifestPath.startsWith(bundledRoot))
    .toSorted();
}

function resolveDefaultBundledProviderPolicyOwnerIndex(
  bundledPluginsDir: string,
): ProviderPolicyOwnerIndex {
  const contextKey = JSON.stringify([
    bundledPluginsDir,
    resolvePluginMetadataSnapshotMemoEnvFingerprint(process.env),
  ]);
  const memo = bundledProviderPolicyOwnerIndexMemo;
  if (
    memo?.contextKey === contextKey &&
    memo.manifestFingerprint ===
      resolveCurrentManifestFingerprint(memo.bundledPluginsDir, memo.overlayManifestPaths)
  ) {
    return memo.owners;
  }
  bundledProviderPolicyOwnerIndexMemo = undefined;
  const fingerprintBeforeScan = resolveCurrentManifestFingerprint(bundledPluginsDir, []);
  const registry = loadPluginManifestRegistry();
  const owners = buildBundledProviderPolicyOwnerIndex(registry);
  // A bundled manifest that changed while discovery ran may not be reflected
  // in this scan, so only memoize scans that saw a stable bundled tree.
  if (resolveCurrentManifestFingerprint(bundledPluginsDir, []) === fingerprintBeforeScan) {
    const overlayManifestPaths = listOverlayManifestPaths(registry, bundledPluginsDir);
    bundledProviderPolicyOwnerIndexMemo = {
      contextKey,
      bundledPluginsDir,
      overlayManifestPaths,
      manifestFingerprint: resolveCurrentManifestFingerprint(
        bundledPluginsDir,
        overlayManifestPaths,
      ),
      owners,
    };
  }
  return owners;
}

function resolveBundledProviderPolicyPlugin(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): ManifestPluginRecord | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    return null;
  }
  const owner = options.manifestRegistry
    ? findBundledProviderPolicyOwner(options.manifestRegistry, normalizedProviderId)
    : resolveDefaultBundledProviderPolicyOwnerIndex(bundledPluginsDir).get(normalizedProviderId);
  return owner ?? null;
}

/** Resolves provider policy hooks for a bundled provider or its owning plugin. */
export function resolveBundledProviderPolicySurface(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): BundledProviderPolicySurface | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const directSurface = resolveDirectBundledProviderPolicySurface(normalizedProviderId);
  if (directSurface) {
    return directSurface;
  }
  const ownerPlugin = resolveBundledProviderPolicyPlugin(normalizedProviderId, options);
  if (ownerPlugin) {
    const ownerSurface = resolveDirectBundledProviderPolicySurface(ownerPlugin.id);
    if (ownerSurface) {
      return ownerSurface;
    }
  }
  if (!ownerPlugin) {
    return null;
  }
  // A stable plugin id can differ from its stock directory name. Use the
  // registry-owned root basename so its pre-runtime policy stays discoverable.
  return resolveDirectBundledProviderPolicySurface(path.basename(ownerPlugin.rootDir));
}

/** Resolves provider policy hooks from bundled or trusted official plugin artifacts. */
export function resolveProviderPolicySurface(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): BundledProviderPolicySurface | null {
  const bundledSurface = resolveBundledProviderPolicySurface(providerId, options);
  if (bundledSurface) {
    return bundledSurface;
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId || !options.manifestRegistry) {
    return null;
  }
  for (const plugin of sortPluginsById(options.manifestRegistry.plugins)) {
    if (
      pluginOwnsProviderPolicyRef(plugin, normalizedProviderId) &&
      plugin.trustedOfficialInstall === true
    ) {
      const surface = resolveTrustedExternalProviderPolicySurface({
        pluginId: plugin.id,
        pluginRoot: plugin.rootDir,
        trustedOfficialInstall: plugin.trustedOfficialInstall,
      });
      if (surface) {
        return surface;
      }
    }
  }
  return null;
}
