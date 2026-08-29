import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntry, SessionSystemPromptReport } from "./types.js";

function parseSessionPromptReportJson(value: string): SessionSystemPromptReport | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SessionSystemPromptReport)
      : null;
  } catch {
    return null;
  }
}

export function writeSessionPromptReport(
  database: OpenClawAgentDatabase,
  params: {
    sessionId: string;
    sessionKey: string;
    report: SessionSystemPromptReport;
    updatedAt: number;
  },
): void {
  const db = getSessionKysely(database.db);
  const reportJson = JSON.stringify(params.report);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_prompt_reports")
      .values({
        session_id: params.sessionId,
        session_key: params.sessionKey,
        report_json: reportJson,
        updated_at: params.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: params.sessionKey,
          report_json: reportJson,
          updated_at: params.updatedAt,
        }),
      ),
  );
}

export function deleteUnreferencedSessionPromptReportsForSessionIds(
  database: OpenClawAgentDatabase,
  sessionIds: Iterable<string>,
): void {
  const candidates = uniqueStrings(
    [...sessionIds].map((sessionId) => sessionId.trim()).filter(Boolean),
  );
  if (candidates.length === 0) {
    return;
  }
  // kysely-allow-raw: candidate GC is an unscoped session_id anti-join; session_key
  // is historical metadata and cannot decide report liveness.
  const statement = database.db.prepare(
    `DELETE FROM session_prompt_reports
     WHERE session_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM session_entries
         WHERE session_entries.session_id = session_prompt_reports.session_id
       )`,
  );
  for (const sessionId of candidates) {
    statement.run(sessionId);
  }
}

export function loadSessionPromptReport(params: {
  agentId?: string;
  storePath?: string;
  sessionId?: string;
  sessionKey: string;
}): SessionSystemPromptReport | null {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.storePath ? { storePath: params.storePath } : {}),
    sessionKey: params.sessionKey,
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const query = params.sessionId?.trim()
    ? db
        .selectFrom("session_prompt_reports")
        .select("report_json")
        .where("session_id", "=", params.sessionId.trim())
    : db
        .selectFrom("session_prompt_reports")
        .select("report_json")
        .where("session_key", "=", resolved.sessionKey)
        .orderBy("updated_at", "desc")
        .limit(1);
  const row = executeSqliteQueryTakeFirstSync(database.db, query);
  return row ? parseSessionPromptReportJson(row.report_json) : null;
}

export function loadSessionPromptReportForEntry(params: {
  agentId?: string;
  storePath?: string;
  sessionKey: string;
  entry?: Pick<SessionEntry, "sessionId" | "systemPromptReport">;
}): SessionSystemPromptReport | null {
  if (params.entry?.systemPromptReport) {
    return params.entry.systemPromptReport;
  }
  return loadSessionPromptReport({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.storePath ? { storePath: params.storePath } : {}),
    sessionId: params.entry?.sessionId,
    sessionKey: params.sessionKey,
  });
}

export function loadSessionPromptReportsForEntries(params: {
  agentId?: string;
  storePath?: string;
  entries: Array<{
    sessionKey: string;
    entry?: Pick<SessionEntry, "sessionId" | "systemPromptReport">;
  }>;
}): Map<string, SessionSystemPromptReport | null> {
  const results = new Map<string, SessionSystemPromptReport | null>();
  const pendingBySessionId = new Map<string, string[]>();
  for (const item of params.entries) {
    if (item.entry?.systemPromptReport) {
      results.set(item.sessionKey, item.entry.systemPromptReport);
      continue;
    }
    const sessionId = item.entry?.sessionId?.trim();
    if (!sessionId) {
      results.set(item.sessionKey, null);
      continue;
    }
    const keys = pendingBySessionId.get(sessionId) ?? [];
    keys.push(item.sessionKey);
    pendingBySessionId.set(sessionId, keys);
  }
  if (pendingBySessionId.size === 0) {
    return results;
  }

  const firstPending = params.entries.find((item) => {
    const sessionId = item.entry?.sessionId?.trim();
    return sessionId ? pendingBySessionId.has(sessionId) : false;
  });
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.storePath ? { storePath: params.storePath } : {}),
    sessionKey: firstPending?.sessionKey ?? "agent:default:main",
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const sessionIds = [...pendingBySessionId.keys()];
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_prompt_reports")
      .select(["session_id", "report_json"])
      .where("session_id", "in", sessionIds),
  ).rows;
  const reportsBySessionId = new Map<string, SessionSystemPromptReport | null>();
  for (const row of rows) {
    reportsBySessionId.set(row.session_id, parseSessionPromptReportJson(row.report_json));
  }
  for (const [sessionId, keys] of pendingBySessionId) {
    const report = reportsBySessionId.get(sessionId) ?? null;
    for (const key of keys) {
      results.set(key, report);
    }
  }
  return results;
}
