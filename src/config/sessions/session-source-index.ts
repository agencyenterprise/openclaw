/** Explicit source-index installation; never invoked by the read-only proof. */
import type { DatabaseSync } from "node:sqlite";

export const SOURCE_TRANSCRIPT_INDEX = "idx_agent_source_absence_v1";
export const SOURCE_VALID = "json_valid(event_json)";
export const SOURCE_KEY = "CASE WHEN json_valid(event_json) THEN json_extract(event_json,'$.message.idempotencyKey') END";
export const SOURCE_INDEX_SQL = `CREATE INDEX ${SOURCE_TRANSCRIPT_INDEX} ON transcript_events(${SOURCE_VALID},${SOURCE_KEY})`;
const TABLES = [["transcript_events", "event_json"], ["session_entries", "entry_json"]] as const;
export const SOURCE_COVERAGE_SQL = [SOURCE_INDEX_SQL, ...TABLES.flatMap(([table, column]) =>
  ["INSERT", "UPDATE"].map((operation) => `CREATE TRIGGER source_absence_${table}_${operation.toLowerCase()}_v1
BEFORE ${operation}${operation === "UPDATE" ? ` OF ${column}` : ""} ON ${table}
BEGIN
 SELECT CASE WHEN json_valid(NEW.${column})=0 THEN RAISE(ABORT,'SOURCE_JSON_INVALID') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM json_tree(NEW.${column}) GROUP BY parent,key HAVING count(*)>1)
 THEN RAISE(ABORT,'SOURCE_JSON_DUPLICATE') END;
END`))];
const normalize = (sql: string) => sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
function name(sql: string): string { const value = sql.split(/\s+/)[2]; if (!value) throw new Error("SOURCE_INDEX_CONTRACT"); return value; }
export function verifySourceCoverageIndexes(db: DatabaseSync): boolean {
  return SOURCE_COVERAGE_SQL.every((sql) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name(sql));
    return typeof row?.sql === "string" && normalize(row.sql) === normalize(sql);
  });
}
/** Host-owned explicit maintenance on an isolated/test DB until deployment review.
 * Full history validation and all guards/indexes commit atomically. No row contents escape.
 * Requires an external resource/deadline supervisor for real index construction.
 */
export function installSourceCoverageIndexes(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, column] of TABLES) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE NOT json_valid(${column}) LIMIT 1`).get())
        throw new Error("SOURCE_JSON_INVALID");
      if (db.prepare(`SELECT 1 FROM ${table} WHERE EXISTS
        (SELECT 1 FROM json_tree(${column}) GROUP BY parent,key HAVING count(*)>1) LIMIT 1`).get())
        throw new Error("SOURCE_JSON_DUPLICATE");
    }
    for (const sql of SOURCE_COVERAGE_SQL) {
      const exists = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name(sql));
      if (!exists) db.exec(sql);
      else if (typeof exists.sql !== "string" || normalize(exists.sql) !== normalize(sql)) throw new Error("SOURCE_INDEX_DRIFT");
    }
    if (!verifySourceCoverageIndexes(db)) throw new Error("SOURCE_INDEX_CONTRACT");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
