// Session snapshot helpers capture and restore runtime skill state for sessions.
import crypto from "node:crypto";
import { stableStringify } from "../../agents/stable-stringify.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { matchesSkillFilter } from "../discovery/filter.js";
import { buildWorkspaceSkillSnapshot } from "../loading/workspace.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import type { SkillEligibilityContext, SkillSnapshot } from "../types.js";
import { getSkillsSnapshotVersion, shouldRefreshSnapshotForVersion } from "./refresh-state.js";
import { ensureSkillsWatcher } from "./refresh.js";
import { hydrateResolvedSkills } from "./snapshot-hydration.js";

const resolvedSkillsCache = new Map<string, SkillSnapshot["resolvedSkills"]>();
const builtSnapshotCache = new Map<string, SkillSnapshot>();
const RESOLVED_SKILLS_CACHE_MAX = 10;

/** Inputs that make a resolved skill snapshot reusable within a process. */
type ReusableSkillSnapshotParams = {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
  eligibility?: SkillEligibilityContext;
  existingSnapshot?: SkillSnapshot;
  snapshotVersion?: number;
  watch?: boolean;
  hydrateExisting?: boolean;
};

type ReusableSkillSnapshotResult = {
  snapshot: SkillSnapshot;
  shouldRefresh: boolean;
  snapshotVersion: number;
};

function fingerprintSkillSnapshotConfig(config: OpenClawConfig): string {
  const skillsEntries = config.skills?.entries;
  const skillEligibilityProjection = skillsEntries
    ? Object.fromEntries(
        Object.entries(skillsEntries).map(([skillKey, entry]) => [
          skillKey,
          {
            enabled: entry?.enabled,
            apiKeyConfigured: hasConfiguredSecretInput(entry?.apiKey),
            env: entry?.env
              ? Object.fromEntries(
                  Object.entries(entry.env).map(([envName, value]) => [
                    envName,
                    typeof value === "string" && value.trim().length > 0,
                  ]),
                )
              : undefined,
          },
        ]),
      )
    : undefined;
  return crypto
    .createHash("sha256")
    .update(
      stableStringify({
        redactedConfig: redactConfigObject(config),
        skills: {
          allowBundled: config.skills?.allowBundled,
          entries: skillEligibilityProjection,
          load: config.skills?.load,
          limits: config.skills?.limits,
        },
      }),
    )
    .digest("hex");
}

function cloneSnapshotTemplate(snapshot: SkillSnapshot): SkillSnapshot {
  const { resolvedSkills, ...persistedSnapshot } = snapshot;
  return defineRuntimeResolvedSkills({ ...persistedSnapshot }, resolvedSkills);
}

function evictSnapshotCachesIfNeeded(): void {
  while (builtSnapshotCache.size > RESOLVED_SKILLS_CACHE_MAX) {
    const oldest = builtSnapshotCache.keys().next().value;
    if (oldest !== undefined) {
      builtSnapshotCache.delete(oldest);
      resolvedSkillsCache.delete(oldest);
    } else {
      break;
    }
  }
}

function defineRuntimeResolvedSkills(
  snapshot: SkillSnapshot,
  resolvedSkills: SkillSnapshot["resolvedSkills"],
): SkillSnapshot {
  Object.defineProperty(snapshot, "resolvedSkills", {
    configurable: true,
    enumerable: false,
    value: resolvedSkills,
    writable: true,
  });
  return snapshot;
}

function cacheResolvedSkills(cacheKey: string, build: () => SkillSnapshot): SkillSnapshot {
  const cachedSnapshot = builtSnapshotCache.get(cacheKey);
  if (cachedSnapshot) {
    return cloneSnapshotTemplate(cachedSnapshot);
  }
  const snapshot = build();
  let resolvedSkills: SkillSnapshot["resolvedSkills"];
  if (resolvedSkillsCache.has(cacheKey)) {
    resolvedSkills = resolvedSkillsCache.get(cacheKey);
  } else {
    resolvedSkills = snapshot.resolvedSkills;
    resolvedSkillsCache.set(cacheKey, resolvedSkills);
  }
  const cached = defineRuntimeResolvedSkills(snapshot, resolvedSkills);
  builtSnapshotCache.set(cacheKey, cached);
  evictSnapshotCachesIfNeeded();
  return cloneSnapshotTemplate(cached);
}

export function resolveReusableWorkspaceSkillSnapshot(
  params: ReusableSkillSnapshotParams,
): ReusableSkillSnapshotResult {
  if (params.watch !== false) {
    ensureSkillsWatcher({ workspaceDir: params.workspaceDir, config: params.config });
  }
  const snapshotVersion = params.snapshotVersion ?? getSkillsSnapshotVersion(params.workspaceDir);
  const promptFormatChanged =
    params.existingSnapshot?.promptFormatVersion !== WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION;
  const skillVersionChanged = shouldRefreshSnapshotForVersion(
    params.existingSnapshot?.version,
    snapshotVersion,
  );
  const nodeSkillsEligibilityChanged =
    stableStringify(params.existingSnapshot?.nodeSkillsEligibility) !==
    stableStringify(params.eligibility?.nodeSkills);
  const shouldRefresh =
    promptFormatChanged ||
    skillVersionChanged ||
    nodeSkillsEligibilityChanged ||
    !matchesSkillFilter(params.existingSnapshot?.skillFilter, params.skillFilter);
  const buildSnapshot = () => {
    return buildWorkspaceSkillSnapshot(params.workspaceDir, {
      config: params.config,
      agentId: params.agentId,
      skillFilter: params.skillFilter,
      eligibility: params.eligibility,
      snapshotVersion,
    });
  };

  const configFingerprint = fingerprintSkillSnapshotConfig(params.config);
  const snapshotCacheKey = JSON.stringify([
    params.workspaceDir,
    snapshotVersion,
    params.skillFilter,
    params.agentId,
    params.eligibility,
    configFingerprint,
  ]);

  const cachedRebuild = (): SkillSnapshot => cacheResolvedSkills(snapshotCacheKey, buildSnapshot);

  const snapshot =
    !params.existingSnapshot || shouldRefresh
      ? cachedRebuild()
      : params.hydrateExisting === false
        ? params.existingSnapshot
        : hydrateResolvedSkills(params.existingSnapshot, cachedRebuild);
  return { snapshot, shouldRefresh, snapshotVersion };
}
