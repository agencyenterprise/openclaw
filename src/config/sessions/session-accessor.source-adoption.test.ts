import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest, openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn, upsertSessionEntry } from "./session-accessor.js";
import { readChannelSourceAdoptionReceipt } from "./session-accessor.source-adoption.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => { closeOpenClawAgentDatabasesForTest(); closeOpenClawStateDatabaseForTest(); });
const sourceTurnId = `channel-user:v1:${"a".repeat(64)}`;
async function fixture() {
  const stateDir = dirs.make("source-adoption-"); const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const scope = { agentId: "main", env, sessionKey: "agent:main:slack:channel:c123:thread:100.000001", sessionId: "session-fixture" };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await persistSessionTranscriptTurn({ ...scope, storePath: database.path }, { expectedSessionId: scope.sessionId,
    sessionLifecyclePatch: { restartRecoveryDeliveryRunId: "run-fixture", restartRecoveryDeliverySourceRunId: sourceTurnId, restartRecoverySourceIngress: "channel", status: "running", updatedAt: 2 },
    messages: [{ eventId: "user-fixture", message: { role: "user", content: "PRIVATE_SYNTHETIC_TEXT", idempotencyKey: sourceTurnId } }],
  });
  const target = { sessionId: scope.sessionId, sessionKey: scope.sessionKey, storePath: database.path, sourceTurnId };
  return { database, scope, target, stateDir };
}
describe("positive source adoption readback", () => {
  it("reads actual atomically persisted transcript/recovery, no private text in receipt or writes", async () => {
    const { database, target } = await fixture();
    const before = database.db.prepare("SELECT total_changes() AS n").get();
    const version = database.db.prepare("PRAGMA data_version").get();
    const result = readChannelSourceAdoptionReceipt(target);
    expect(result).toMatchObject({ status: "VERIFIED", sessionId: target.sessionId, sourceTurnId, transcriptEventId: "user-fixture", recoveryState: "SOURCE_CLAIM", recoveryRunId: "run-fixture" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SYNTHETIC_TEXT");
    expect(database.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(database.db.prepare("PRAGMA data_version").get()).toEqual(version);
  });
  it("requires original session/source and canonical key", async () => {
    const { target } = await fixture();
    expect(readChannelSourceAdoptionReceipt({ ...target, sessionId: "replacement" })).toMatchObject({ status: "UNVERIFIED", reason: "SESSION_MISMATCH" });
    expect(readChannelSourceAdoptionReceipt({ ...target, sessionKey: target.sessionKey.toUpperCase() })).toMatchObject({ status: "UNVERIFIED", reason: "NONCANONICAL_KEY" });
    expect(readChannelSourceAdoptionReceipt({ ...target, sourceTurnId: `channel-user:v1:${"b".repeat(64)}` })).toMatchObject({ status: "UNVERIFIED", reason: "SOURCE_ABSENT_OR_AMBIGUOUS" });
  });
  it("transcript alone does not imply recoverable adoption", async () => {
    const { database, target } = await fixture();
    database.db.prepare("UPDATE session_entries SET entry_json=json_remove(entry_json,'$.restartRecoveryDeliveryRunId','$.restartRecoveryDeliverySourceRunId')").run();
    expect(readChannelSourceAdoptionReceipt(target)).toMatchObject({ status: "UNVERIFIED", reason: "RECOVERY_PROOF_ABSENT" });
  });
  it("retained terminal source proves original adoption after active claim clears", async () => {
    const { database, target } = await fixture();
    const entry = JSON.parse((database.db.prepare("SELECT entry_json FROM session_entries").get() as { entry_json: string }).entry_json);
    delete entry.restartRecoveryDeliveryRunId; delete entry.restartRecoveryDeliverySourceRunId; entry.restartRecoveryTerminalRunIds = [sourceTurnId];
    database.db.prepare("UPDATE session_entries SET entry_json=?").run(JSON.stringify(entry));
    expect(readChannelSourceAdoptionReceipt(target)).toMatchObject({ status: "VERIFIED", recoveryState: "TERMINAL_SOURCE" });
  });
  it.each(["assistant", "wrong-source", "wrong-event-id"])("rejects index/content disagreement %s", async (change) => {
    const { database, target } = await fixture();
    const row = database.db.prepare("SELECT event_json FROM transcript_events WHERE seq=(SELECT seq FROM transcript_event_identities WHERE event_id='user-fixture')").get() as { event_json: string };
    const event = JSON.parse(row.event_json);
    if (change === "assistant") event.message.role = "assistant";
    if (change === "wrong-source") event.message.idempotencyKey = "foreign";
    if (change === "wrong-event-id") event.id = "foreign";
    database.db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=(SELECT seq FROM transcript_event_identities WHERE event_id='user-fixture')").run(JSON.stringify(event));
    expect(readChannelSourceAdoptionReceipt(target)).toMatchObject({ status: "UNVERIFIED", reason: "TRANSCRIPT_IDENTITY" });
  });
  it("refuses oversized source and malformed JSON without raw exception leakage", async () => {
    const { database, target } = await fixture();
    database.db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=(SELECT seq FROM transcript_event_identities WHERE event_id='user-fixture')").run("x".repeat(1024 * 1024 + 1));
    expect(readChannelSourceAdoptionReceipt(target)).toMatchObject({ status: "UNVERIFIED", reason: "EVENT_LIMIT" });
    database.db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=(SELECT seq FROM transcript_event_identities WHERE event_id='user-fixture')").run("PRIVATE_INVALID_JSON");
    expect(readChannelSourceAdoptionReceipt(target)).toEqual({ status: "UNVERIFIED", reason: "READBACK_FAILED" });
  });
  it("does not rebuild a dirty active projection or require active-tail membership", async () => {
    const { database, target } = await fixture();
    database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild=1").run();
    const before = database.db.prepare("SELECT * FROM session_transcript_index_state").all();
    expect(readChannelSourceAdoptionReceipt(target)).toMatchObject({ status: "VERIFIED" });
    expect(database.db.prepare("SELECT * FROM session_transcript_index_state").all()).toEqual(before);
  });
  it("missing DB is never created and no migration occurs", async () => {
    const { target, stateDir, database } = await fixture();
    const absent = join(stateDir, "absent.sqlite");
    expect(readChannelSourceAdoptionReceipt({ ...target, storePath: absent })).toMatchObject({ status: "UNVERIFIED" }); expect(existsSync(absent)).toBe(false);
    database.db.exec("PRAGMA user_version=9");
    expect(readChannelSourceAdoptionReceipt(target)).toMatchObject({ status: "UNVERIFIED", reason: "SCHEMA_VERSION" });
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
  });
});
