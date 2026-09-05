// Maintenance preserve providers protect runtime-owned sessions from pruning/capping.
import {
  collectActiveSessionWorkAdmissionIdentities,
  collectActiveSessionWorkAdmissionIdentitiesForScopes,
} from "../../sessions/session-lifecycle-admission.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

/** Provider hook for session keys that maintenance/pruning should preserve. */
type SessionMaintenancePreserveKeysProvider = () => Iterable<string> | undefined;

const preserveKeysProviders = new Set<SessionMaintenancePreserveKeysProvider>();

/** Registers a provider for session maintenance preserve keys. */
export function registerSessionMaintenancePreserveKeysProvider(
  provider: SessionMaintenancePreserveKeysProvider,
): () => void {
  preserveKeysProviders.add(provider);
  return () => {
    preserveKeysProviders.delete(provider);
  };
}

function addSessionMaintenancePreserveKey(keys: Set<string>, value: string | undefined): void {
  // Match how store keys are normalized in `normalizeStoreSessionKey`
  // (trim + lowercase) so providers can register session keys in any
  // case without missing matches during maintenance lookups.
  const normalized = normalizeStoreSessionKey(value ?? "");
  if (normalized) {
    keys.add(normalized);
  }
}

function addSessionMaintenancePreserveKeys(
  keys: Set<string>,
  values: Iterable<string | undefined> | undefined,
): void {
  for (const value of values ?? []) {
    addSessionMaintenancePreserveKey(keys, value);
  }
}

/** Collects normalized session keys that maintenance/pruning must preserve. */
export function collectSessionMaintenancePreserveKeys(
  baseKeys?: Iterable<string | undefined>,
): Set<string> | undefined {
  const keys = new Set<string>();
  addSessionMaintenancePreserveKeys(keys, baseKeys);
  for (const provider of preserveKeysProviders) {
    try {
      addSessionMaintenancePreserveKeys(keys, provider());
    } catch {
      // Maintenance must remain best-effort if a runtime provider is temporarily unavailable.
    }
  }
  return keys.size > 0 ? keys : undefined;
}

function resolveAdmittedStoreKeys(
  activeIdentities: ReadonlySet<string>,
  store: Record<string, SessionEntry>,
): Set<string> | undefined {
  if (activeIdentities.size === 0) {
    return undefined;
  }
  const normalizedIdentities = new Set(
    Array.from(activeIdentities, (identity) => normalizeStoreSessionKey(identity)),
  );
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(store)) {
    if (
      normalizedIdentities.has(normalizeStoreSessionKey(key)) ||
      activeIdentities.has(entry.sessionId)
    ) {
      // Maintenance iterates the persisted keys verbatim, while admissions
      // normally use canonical identities. Preserve both representations.
      keys.add(key);
      keys.add(normalizeStoreSessionKey(key));
    }
  }
  return keys.size > 0 ? keys : undefined;
}

function mergeSessionMaintenancePreserveKeys(
  baseKeys: Iterable<string | undefined> | undefined,
  admittedKeys: Set<string> | undefined,
): Set<string> | undefined {
  const keys = collectSessionMaintenancePreserveKeys(baseKeys) ?? new Set<string>();
  for (const key of admittedKeys ?? []) {
    keys.add(key);
  }
  return keys.size > 0 ? keys : undefined;
}

/** Resolves store keys owned by active work, including aliases sharing a backing session id. */
export function collectActiveSessionWorkAdmissionKeys(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): Set<string> | undefined {
  return resolveAdmittedStoreKeys(
    collectActiveSessionWorkAdmissionIdentities(params.storePath),
    params.store,
  );
}

/**
 * Same as `collectActiveSessionWorkAdmissionKeys`, for a store whose admissions
 * can be registered under more than one scope path (one per agent sharing the
 * file, or an explicit path a caller passed instead of the configured one).
 */
function collectActiveSessionWorkAdmissionKeysForStoreScopes(params: {
  matchesStoreScope: (storeScope: string) => boolean;
  store: Record<string, SessionEntry>;
}): Set<string> | undefined {
  return resolveAdmittedStoreKeys(
    collectActiveSessionWorkAdmissionIdentitiesForScopes(params.matchesStoreScope),
    params.store,
  );
}

/** Collects every runtime and active-work key protected from automatic maintenance. */
export function collectSessionMaintenancePreserveKeysForStore(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  baseKeys?: Iterable<string | undefined>;
}): Set<string> | undefined {
  return mergeSessionMaintenancePreserveKeys(
    params.baseKeys,
    collectActiveSessionWorkAdmissionKeys({ storePath: params.storePath, store: params.store }),
  );
}

/** Collects protected keys for a store identified by scope match instead of one path. */
export function collectSessionMaintenancePreserveKeysForStoreScopes(params: {
  matchesStoreScope: (storeScope: string) => boolean;
  store: Record<string, SessionEntry>;
  baseKeys?: Iterable<string | undefined>;
}): Set<string> | undefined {
  return mergeSessionMaintenancePreserveKeys(
    params.baseKeys,
    collectActiveSessionWorkAdmissionKeysForStoreScopes({
      matchesStoreScope: params.matchesStoreScope,
      store: params.store,
    }),
  );
}
