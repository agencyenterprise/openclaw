/** Bounded historical source absence over maintained metadata, never a replay decision alone. */
import { lstatSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
export type ChannelSourceAbsenceTarget = Readonly<{ storePath: string; sessionKey: string; sourceTurnId: string }>;
export type ChannelSourceAbsenceReceipt =
  | { status: "VERIFIED_ABSENT"; sessionKey: string; sourceTurnId: string; checkedSessionEntries: number; basis: "MAINTAINED_SOURCE_INDEX_AND_RECOVERY_METADATA" }
  | { status: "UNVERIFIED"; reason: string };
import { SOURCE_TRANSCRIPT_INDEX, SOURCE_VALID, SOURCE_KEY, verifySourceCoverageIndexes } from "./session-source-index.js";
const RECOVERY_SQL = `
WITH safe AS (
 SELECT session_id, json_valid(entry_json) AS valid,
 CASE WHEN json_valid(entry_json) THEN entry_json ELSE '{}' END AS doc
 FROM session_entries
), flags AS (
 SELECT *, CASE WHEN
 valid=0 OR json_type(doc) IS NOT 'object'
 OR json_extract(doc,'$.sessionId') IS NOT session_id
 OR EXISTS (SELECT 1 FROM json_each(doc) f
 WHERE f.key IN ('restartRecoveryDeliveryRunId','restartRecoveryDeliverySourceRunId')
 AND (f.type != 'text' OR length(f.value) NOT BETWEEN 1 AND 512 OR f.value GLOB '*[^!-~]*'))
 OR (json_type(doc,'$.restartRecoveryTerminalRunIds') IS NOT NULL AND
 json_type(doc,'$.restartRecoveryTerminalRunIds') IS NOT 'array')
 OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(doc,'$.restartRecoveryTerminalRunIds')='array'
 THEN json_extract(doc,'$.restartRecoveryTerminalRunIds') ELSE '[]' END) t
 WHERE t.type!='text' OR length(t.value) NOT BETWEEN 1 AND 512 OR t.value GLOB '*[^!-~]*')
 THEN 1 ELSE 0 END AS malformed
 FROM safe
)
SELECT count(*) AS entries, coalesce(max(malformed),0) AS malformed,
 coalesce(max(CASE WHEN json_extract(doc,'$.restartRecoveryDeliverySourceRunId')=?
 OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(doc,'$.restartRecoveryTerminalRunIds')='array'
 THEN json_extract(doc,'$.restartRecoveryTerminalRunIds') ELSE '[]' END) t WHERE t.value=?)
 THEN 1 ELSE 0 END),0) AS present
FROM flags
`;
const canonicalId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim();
export function readChannelSourcePreAdmissionAbsence(target: ChannelSourceAbsenceTarget): ChannelSourceAbsenceReceipt {
  let db: DatabaseSync | undefined;
  const held = (reason: string): ChannelSourceAbsenceReceipt => ({ status: "UNVERIFIED", reason });
  try {
    if (!target || !canonicalId(target.sessionKey) || typeof target.storePath !== "string" || !target.storePath || target.storePath.length > 4096 || !/^channel-user:v1:[a-f0-9]{64}$/.test(target.sourceTurnId)) return held("TARGET_INVALID");
    const scope = resolveSqliteScope(target);
    if (scope.sessionKey !== target.sessionKey) return held("NONCANONICAL_KEY");
    const path = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) return held("DATABASE_IDENTITY");
    db = new (requireNodeSqlite().DatabaseSync)(path, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    if ((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version !== 10) return held("SCHEMA_VERSION");
    if (!verifySourceCoverageIndexes(db)) return held("SOURCE_INDEX_CONTRACT");
    if (db.prepare(`SELECT 1 FROM transcript_events INDEXED BY ${SOURCE_TRANSCRIPT_INDEX}
      WHERE ${SOURCE_VALID}=0 LIMIT 1`).get()) return held("TRANSCRIPT_COVERAGE_MALFORMED");
    // Direct complete-table index includes raw rows even when maintained identity metadata is absent.
    if (db.prepare(`SELECT 1 FROM transcript_events INDEXED BY ${SOURCE_TRANSCRIPT_INDEX}
      WHERE ${SOURCE_VALID}=1 AND ${SOURCE_KEY}=? LIMIT 1`).get(target.sourceTurnId)) return held("SOURCE_TRANSCRIPT_PRESENT");
    // Preserve orphan metadata as a conservative positive; do not infer absence from just one projection.
    if (db.prepare(`SELECT 1 FROM transcript_event_identities INDEXED BY idx_agent_transcript_message_idempotency
      WHERE message_idempotency_key IS NOT NULL AND message_idempotency_key=? LIMIT 1`).get(target.sourceTurnId)) return held("SOURCE_TRANSCRIPT_PRESENT");
    // Complete recovery scan stays inside SQLite. No transcript/entry payload crosses the API.
    const recovery = db.prepare(RECOVERY_SQL).get(target.sourceTurnId, target.sourceTurnId);
    if (!recovery || typeof recovery.entries !== "number" || !Number.isSafeInteger(recovery.entries)) return held("RECOVERY_UNVERIFIED");
    if (recovery.malformed !== 0) return held("RECOVERY_MALFORMED");
    if (recovery.present !== 0) return held("SOURCE_RECOVERY_PRESENT");
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() || (after.mode & 0o077) !== 0) return held("DATABASE_REPLACED");
    return { status: "VERIFIED_ABSENT", sessionKey: target.sessionKey, sourceTurnId: target.sourceTurnId,
      checkedSessionEntries: recovery.entries, basis: "MAINTAINED_SOURCE_INDEX_AND_RECOVERY_METADATA" };
  } catch { return held("READBACK_FAILED"); }
  finally { if (db) { try { db.exec("ROLLBACK"); } catch { /* read only */ } finally { try { db.close(); } catch { /* no private logs */ } } } }
}
