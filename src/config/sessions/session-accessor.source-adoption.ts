/** Positive metadata-only readback of a channel source's durable adoption. */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { hasRestartRecoverySourceClaim, hasRestartRecoveryTerminalRun } from "./restart-recovery-state.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

/** Supplied by the actual core adoption site, never inferred from the latest row. */
export type ChannelSourceAdoptionTarget = Readonly<{
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sourceTurnId: string;
}>;
export type ChannelSourceAdoptionReceipt =
  | { status: "VERIFIED"; sessionKey: string; sessionId: string; sourceTurnId: string;
      transcriptEventId: string; transcriptSeq: number; transcriptEventSha256: string;
      recoveryState: "SOURCE_CLAIM" | "TERMINAL_SOURCE"; recoveryRunId?: string }
  | { status: "UNVERIFIED"; reason: string };
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
function unavailable(reason: string): ChannelSourceAdoptionReceipt { return { status: "UNVERIFIED", reason }; }
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function readChannelSourceAdoptionReceipt(target: ChannelSourceAdoptionTarget): ChannelSourceAdoptionReceipt {
  let database: DatabaseSync | undefined;
  try {
    if (!target || Object.values(target).some((value) => typeof value !== "string" || !value || value.length > 4096) ||
        !/^channel-user:v1:[a-f0-9]{64}$/.test(target.sourceTurnId)) return unavailable("TARGET_INVALID");
    const scope = resolveSqliteScope({ sessionKey: target.sessionKey, storePath: target.storePath });
    if (scope.sessionKey !== target.sessionKey) return unavailable("NONCANONICAL_KEY");
    const path = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0 ||
        (process.getuid && before.uid !== process.getuid())) return unavailable("DATABASE_IDENTITY");
    const { DatabaseSync: Sqlite } = requireNodeSqlite();
    // Do not invoke the normal database opener: it may initialize/migrate/register state.
    database = new Sqlite(path, { readOnly: true });
    database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    const version = database.prepare("PRAGMA user_version").get() as { user_version?: number };
    if (version.user_version !== 10) return unavailable("SCHEMA_VERSION");
    const entryRow = database.prepare(`SELECT session_id, length(CAST(entry_json AS BLOB)) AS bytes,
      CASE WHEN length(CAST(entry_json AS BLOB)) <= ? THEN entry_json ELSE NULL END AS entry_json
      FROM session_entries WHERE session_key = ?`).get(MAX_ENTRY_BYTES, target.sessionKey) as
      { session_id: string; bytes: number; entry_json: string | null } | undefined;
    if (!entryRow || entryRow.session_id !== target.sessionId) return unavailable("SESSION_MISMATCH");
    if (entryRow.entry_json === null) return unavailable("ENTRY_LIMIT");
    const entry = record(JSON.parse(entryRow.entry_json));
    if (!entry || entry.sessionId !== target.sessionId) return unavailable("ENTRY_IDENTITY");
    const rows = database.prepare(`SELECT identity.event_id, identity.seq, identity.event_type,
      length(CAST(event.event_json AS BLOB)) AS bytes,
      CASE WHEN length(CAST(event.event_json AS BLOB)) <= ? THEN event.event_json ELSE NULL END AS event_json
      FROM transcript_event_identities AS identity INDEXED BY idx_agent_transcript_message_idempotency
      JOIN transcript_events AS event ON event.session_id = identity.session_id AND event.seq = identity.seq
      WHERE identity.session_id = ? AND identity.message_idempotency_key = ? LIMIT 2`).all(
      MAX_EVENT_BYTES, target.sessionId, target.sourceTurnId,
    ) as Array<{ event_id: string; seq: number; event_type: string; bytes: number; event_json: string | null }>;
    if (rows.length !== 1) return unavailable("SOURCE_ABSENT_OR_AMBIGUOUS");
    const row = rows[0];
    if (!row) return unavailable("SOURCE_ABSENT_OR_AMBIGUOUS");
    if (row.event_json === null) return unavailable("EVENT_LIMIT");
    const event = record(JSON.parse(row.event_json)); const message = record(event?.message);
    if (!event || row.event_type !== "message" || event.type !== "message" || event.id !== row.event_id ||
        message?.role !== "user" || message.idempotencyKey !== target.sourceTurnId ||
        !Number.isSafeInteger(row.seq) || row.seq < 0) return unavailable("TRANSCRIPT_IDENTITY");
    const canonicalId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim();
    for (const field of ["restartRecoveryDeliveryRunId", "restartRecoveryDeliverySourceRunId"]) {
      if (entry[field] !== undefined && !canonicalId(entry[field])) return unavailable("RECOVERY_PROOF_MALFORMED");
    }
    const terminalIds = entry.restartRecoveryTerminalRunIds;
    if (terminalIds !== undefined && (!Array.isArray(terminalIds) || terminalIds.length > 128 || !terminalIds.every(canonicalId))) return unavailable("RECOVERY_PROOF_MALFORMED");
    const session = entry as unknown as SessionEntry;
    const claimed = hasRestartRecoverySourceClaim(session, target.sourceTurnId);
    const terminal = hasRestartRecoveryTerminalRun(session, target.sourceTurnId);
    if (!claimed && !terminal) return unavailable("RECOVERY_PROOF_ABSENT");
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() || (after.mode & 0o077) !== 0) return unavailable("DATABASE_REPLACED");
    return { status: "VERIFIED", sessionKey: target.sessionKey, sessionId: target.sessionId,
      sourceTurnId: target.sourceTurnId, transcriptEventId: row.event_id, transcriptSeq: row.seq,
      transcriptEventSha256: createHash("sha256").update(row.event_json).digest("hex"),
      recoveryState: claimed ? "SOURCE_CLAIM" : "TERMINAL_SOURCE",
      ...(claimed ? { recoveryRunId: session.restartRecoveryDeliveryRunId } : {}),
    };
  } catch {
    return unavailable("READBACK_FAILED"); // No private SQL/JSON/path exception in logs or receipt.
  } finally {
    if (database) { try { database.exec("ROLLBACK"); } catch { /* Read-only transaction cleanup; never expose private engine text. */ } finally { try { database.close(); } catch { /* No writes were permitted. */ } } }
  }
}
