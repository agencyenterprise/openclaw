import crypto from "node:crypto";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryStatus,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import { stripSessionEntryRuntimeFields } from "./session-entry-runtime-normalize.js";
import type { SessionEntry } from "./types.js";

type SessionStatusDatabase = Pick<OpenClawAgentKyselyDatabase, "session_entries">;

const SESSION_ENTRY_STRING_INTERN_MAX = 4096;
const SESSION_ENTRY_STRING_INTERN_MAX_UTF16_BYTES = 16 * 1024 * 1024;
const SESSION_ENTRY_STRING_INTERN_MAX_STRING_UTF16_BYTES = 512 * 1024;
const sessionEntryStringInternCache = new Map<string, { bytes: number; value: string }>();
let sessionEntryStringInternRetainedUtf16Bytes = 0;
let sessionEntryStringInternHits = 0;

export function normalizeSqliteStatus(value: unknown): SessionEntryStatus | null {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

function internSessionEntryString(value: string): string {
  const bytes = value.length * 2;
  if (bytes > SESSION_ENTRY_STRING_INTERN_MAX_STRING_UTF16_BYTES) {
    return value;
  }
  const key = `${value.length}:${crypto.createHash("sha256").update(value).digest("base64url")}`;
  const existing = sessionEntryStringInternCache.get(key);
  if (existing?.value === value) {
    sessionEntryStringInternHits += 1;
    return existing.value;
  }
  if (existing !== undefined) {
    return value;
  }
  sessionEntryStringInternCache.set(key, { bytes, value });
  sessionEntryStringInternRetainedUtf16Bytes += bytes;
  while (
    sessionEntryStringInternCache.size > SESSION_ENTRY_STRING_INTERN_MAX ||
    sessionEntryStringInternRetainedUtf16Bytes > SESSION_ENTRY_STRING_INTERN_MAX_UTF16_BYTES
  ) {
    const oldest = sessionEntryStringInternCache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = sessionEntryStringInternCache.get(oldest);
      if (evicted) {
        sessionEntryStringInternRetainedUtf16Bytes -= evicted.bytes;
      }
      sessionEntryStringInternCache.delete(oldest);
    } else {
      break;
    }
  }
  return value;
}

function internStringArray(values: string[] | undefined): void {
  if (!Array.isArray(values)) {
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value === "string") {
      values[index] = internSessionEntryString(value);
    }
  }
}

function internSkillsSnapshot(snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return;
  }
  const skillsSnapshot = snapshot as Record<string, unknown>;
  if (typeof skillsSnapshot.prompt === "string") {
    skillsSnapshot.prompt = internSessionEntryString(skillsSnapshot.prompt);
  }
  internStringArray(skillsSnapshot.skillFilter as string[] | undefined);
  const nodeSkillsEligibility = skillsSnapshot.nodeSkillsEligibility;
  if (
    nodeSkillsEligibility &&
    typeof nodeSkillsEligibility === "object" &&
    !Array.isArray(nodeSkillsEligibility) &&
    typeof (nodeSkillsEligibility as Record<string, unknown>).node === "string"
  ) {
    const eligibility = nodeSkillsEligibility as Record<string, unknown>;
    eligibility.node = internSessionEntryString(eligibility.node as string);
  }
  if (Array.isArray(skillsSnapshot.skills)) {
    for (const skill of skillsSnapshot.skills) {
      if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
        continue;
      }
      const snapshotSkill = skill as Record<string, unknown>;
      for (const key of ["name", "primaryEnv"] as const) {
        if (typeof snapshotSkill[key] === "string") {
          snapshotSkill[key] = internSessionEntryString(snapshotSkill[key]);
        }
      }
      internStringArray(snapshotSkill.requiredEnv as string[] | undefined);
    }
  }
}

function internSessionEntry(entry: SessionEntry): SessionEntry {
  internSkillsSnapshot((entry as { skillsSnapshot?: unknown }).skillsSnapshot);
  return stripSessionEntryRuntimeFields(entry);
}

export function parseSqliteSessionEntryJson(row: { entry_json: string }): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? internSessionEntry(parsed as SessionEntry)
      : null;
  } catch {
    return null;
  }
}

export const testing = {
  internSessionEntryString,
  resetSessionEntryStringInternCache: () => {
    sessionEntryStringInternCache.clear();
    sessionEntryStringInternRetainedUtf16Bytes = 0;
    sessionEntryStringInternHits = 0;
  },
  sessionEntryStringInternStats: () => ({
    hits: sessionEntryStringInternHits,
    maxStringUtf16Bytes: SESSION_ENTRY_STRING_INTERN_MAX_STRING_UTF16_BYTES,
    maxUtf16Bytes: SESSION_ENTRY_STRING_INTERN_MAX_UTF16_BYTES,
    retainedUtf16Bytes: sessionEntryStringInternRetainedUtf16Bytes,
    size: sessionEntryStringInternCache.size,
  }),
};

export function readSqliteSessionEntriesByStatus(
  database: OpenClawAgentDatabase,
  statuses: readonly SessionEntryStatus[],
  sessionKeys?: readonly string[],
): SessionEntrySummary[] {
  const selectedStatuses = [...new Set(statuses)];
  const selectedSessionKeys = sessionKeys ? [...new Set(sessionKeys)] : undefined;
  if (selectedStatuses.length === 0 || selectedSessionKeys?.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  let query = db
    .selectFrom("session_entries")
    .select(["session_key", "entry_json", "session_id", "updated_at"])
    .where("status", "in", selectedStatuses);
  if (selectedSessionKeys) {
    query = query.where("session_key", "in", selectedSessionKeys);
  }
  return executeSqliteQuerySync(database.db, query)
    .rows.flatMap((row) => {
      const entry = parseSqliteSessionEntryJson(row);
      return entry ? [{ entry, sessionKey: row.session_key }] : [];
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
