import { afterEach, expect, it } from 'vitest';
import { useAutoCleanupTempDirTracker } from '../../../test/helpers/temp-dir.js';
import { closeOpenClawAgentDatabasesForTest, openOpenClawAgentDatabase } from '../../state/openclaw-agent-db.js';
import { closeOpenClawStateDatabaseForTest } from '../../state/openclaw-state-db.js';
import { persistSessionTranscriptTurn, upsertSessionEntry } from './session-accessor.js';
import { readChannelSourcePreAdmissionAbsence } from './session-accessor.source-absence.js';
import { installSourceCoverageIndexes, verifySourceCoverageIndexes, SOURCE_TRANSCRIPT_INDEX } from './session-source-index.js';
const dirs=useAutoCleanupTempDirTracker(afterEach);
afterEach(()=>{closeOpenClawAgentDatabasesForTest();closeOpenClawStateDatabaseForTest();});
const source='channel-user:v1:'+'d'.repeat(64);
async function fixture(install=true){
 const env={...process.env,OPENCLAW_STATE_DIR:dirs.make('indexed-absence-')};
 const database=openOpenClawAgentDatabase({agentId:'main',env});
 const scope={agentId:'main',env,storePath:database.path,sessionKey:'agent:main:slack:channel:c888:thread:100.000001',sessionId:'original-session'};
 await upsertSessionEntry(scope,{sessionId:scope.sessionId,updatedAt:1});
 if(install)installSourceCoverageIndexes(database.db);
 return {db:database.db,scope,target:{sessionKey:scope.sessionKey,storePath:database.path,sourceTurnId:source}};
}
it('decoded escaped aliases collide within one object and never enter contract',async()=>{
 const f=await fixture(false);
 f.db.prepare('UPDATE session_entries SET entry_json=?').run('{"sessionId":"original-session","nested":{"idempotencyKey":"first","idempotency\\u004bey":"second"}}');
 expect(()=>installSourceCoverageIndexes(f.db)).toThrow('SOURCE_JSON_DUPLICATE');
 expect(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'source_absence_%' OR name=?").get(SOURCE_TRANSCRIPT_INDEX)?.n).toBe(0);
});
it('same decoded keys in distinct objects are valid, not false duplicates',async()=>{
 const f=await fixture(false);
 f.db.prepare('UPDATE session_entries SET entry_json=?').run(JSON.stringify({sessionId:f.scope.sessionId,nested:[{x:1},{x:2}]}));
 installSourceCoverageIndexes(f.db);expect(readChannelSourcePreAdmissionAbsence(f.target).status).toBe('VERIFIED_ABSENT');
});
it('late contract conflict rolls back all newly created objects preserving preexisting conflict',async()=>{
 const f=await fixture(false);
 f.db.exec('CREATE TRIGGER source_absence_session_entries_update_v1 BEFORE UPDATE ON session_entries BEGIN SELECT 1; END');
 const before=f.db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'source_absence_%' OR name=? ORDER BY name").all(SOURCE_TRANSCRIPT_INDEX);
 expect(()=>installSourceCoverageIndexes(f.db)).toThrow('SOURCE_INDEX_DRIFT');
 expect(f.db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'source_absence_%' OR name=? ORDER BY name").all(SOURCE_TRANSCRIPT_INDEX)).toEqual(before);
 f.db.exec('BEGIN IMMEDIATE; ROLLBACK');
});
it('orphan maintained identity is held after raw event removed',async()=>{
 const f=await fixture();
 await persistSessionTranscriptTurn(f.scope,{expectedSessionId:f.scope.sessionId,messages:[{eventId:'orphan-source',message:{role:'user',content:'synthetic',idempotencyKey:source}}]});
 const old=f.db.prepare('SELECT * FROM transcript_event_identities WHERE message_idempotency_key=?').get(source)!;
 f.db.exec('PRAGMA foreign_keys=OFF');
 f.db.prepare("DELETE FROM transcript_events WHERE json_extract(event_json,'$.id')='orphan-source'").run();
 // Explicitly construct corrupt orphan metadata; real maintained deletion normally cascades.
 if(!f.db.prepare('SELECT 1 FROM transcript_event_identities WHERE message_idempotency_key=?').get(source)) {
 const names=Object.keys(old);f.db.prepare('INSERT INTO transcript_event_identities ('+names.join(',')+') VALUES ('+names.map(()=>'?').join(',')+')').run(...Object.values(old));
 }
 f.db.exec('PRAGMA foreign_keys=ON');
 expect(f.db.prepare('SELECT 1 FROM transcript_event_identities WHERE message_idempotency_key=?').get(source)).toBeDefined();
 expect(readChannelSourcePreAdmissionAbsence(f.target)).toMatchObject({status:'UNVERIFIED',reason:'SOURCE_TRANSCRIPT_PRESENT'});
});
it('future transcript key alias cannot hide source behind first-key interpretation',async()=>{
 const f=await fixture();
 await persistSessionTranscriptTurn(f.scope,{expectedSessionId:f.scope.sessionId,messages:[{eventId:'update-source',message:{role:'user',content:'synthetic'}}]});
 const raw='{"id":"update-source","type":"message","message":{"role":"user","idempotencyKey":"other","idempotency\\u004bey":"'+source+'"}}';
 expect(()=>f.db.prepare("UPDATE transcript_events SET event_json=? WHERE json_extract(event_json,'$.id')='update-source'").run(raw)).toThrow('SOURCE_JSON_DUPLICATE');
 expect(readChannelSourcePreAdmissionAbsence(f.target).status).toBe('VERIFIED_ABSENT');
});
