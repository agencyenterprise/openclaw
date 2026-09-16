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
it('read never creates missing coverage indexes',async()=>{const f=await fixture(false);expect(readChannelSourcePreAdmissionAbsence(f.target)).toMatchObject({status:'UNVERIFIED',reason:'SOURCE_INDEX_CONTRACT'});expect(verifySourceCoverageIndexes(f.db)).toBe(false);});
it('duplicate historical JSON rejects installation before DDL',async()=>{const f=await fixture(false);f.db.prepare('UPDATE session_entries SET entry_json=?').run('{"sessionId":"original-session","sessionId":"other"}');expect(()=>installSourceCoverageIndexes(f.db)).toThrow('SOURCE_JSON_DUPLICATE');expect(f.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(SOURCE_TRANSCRIPT_INDEX)).toBeUndefined();});
it('future duplicate and invalid JSON writes fail with safe constant reason',async()=>{const f=await fixture();expect(()=>f.db.prepare('UPDATE session_entries SET entry_json=?').run('{"x":1,"x":2}')).toThrow('SOURCE_JSON_DUPLICATE');expect(()=>f.db.prepare('UPDATE session_entries SET entry_json=?').run('PRIVATE_INVALID')).toThrow('SOURCE_JSON_INVALID');expect(readChannelSourcePreAdmissionAbsence(f.target).status).toBe('VERIFIED_ABSENT');});
it.each(['\t','\n','\u00a0','\ufeff','😀'])('noncanonical proof metadata holds: %s',async(pad)=>{const f=await fixture();f.db.prepare('UPDATE session_entries SET entry_json=?').run(JSON.stringify({sessionId:f.scope.sessionId,restartRecoveryDeliverySourceRunId:pad+source}));expect(readChannelSourcePreAdmissionAbsence(f.target)).toMatchObject({status:'UNVERIFIED',reason:'RECOVERY_MALFORMED'});});
it('source without identity row remains present',async()=>{const f=await fixture();await persistSessionTranscriptTurn(f.scope,{expectedSessionId:f.scope.sessionId,messages:[{eventId:'source',message:{role:'user',content:'PRIVATE',idempotencyKey:source}}]});f.db.prepare("DELETE FROM transcript_event_identities WHERE event_id='source'").run();expect(readChannelSourcePreAdmissionAbsence(f.target)).toMatchObject({status:'UNVERIFIED',reason:'SOURCE_TRANSCRIPT_PRESENT'});});
it('1761 full recovery entries do not trip old caps and last terminal stays held',async()=>{const f=await fixture();const columns=f.db.prepare('PRAGMA table_info(session_entries)').all().map(r=>String(r.name));const quoted=columns.map(n=>'"'+n+'"');const selection=columns.map(n=>n==='session_key'?'?':n==='entry_json'?'?':'"'+n+'"').join(',');const insert=f.db.prepare('INSERT INTO session_entries('+quoted.join(',')+') SELECT '+selection+' FROM session_entries WHERE session_key=?');f.db.exec('BEGIN');for(let i=0;i<1760;i++)insert.run('agent:main:old-'+i,JSON.stringify({sessionId:f.scope.sessionId,padding:'x'.repeat(8000)}),f.target.sessionKey);f.db.exec('COMMIT');expect(readChannelSourcePreAdmissionAbsence(f.target)).toMatchObject({status:'VERIFIED_ABSENT',checkedSessionEntries:1761});f.db.prepare('UPDATE session_entries SET entry_json=? WHERE session_key=?').run(JSON.stringify({sessionId:f.scope.sessionId,restartRecoveryTerminalRunIds:[source]}),'agent:main:old-1759');expect(readChannelSourcePreAdmissionAbsence(f.target)).toMatchObject({status:'UNVERIFIED',reason:'SOURCE_RECOVERY_PRESENT'});});
it('missing future guard invalidates proof even when index remains',async()=>{const f=await fixture();f.db.exec('DROP TRIGGER source_absence_session_entries_update_v1');expect(readChannelSourcePreAdmissionAbsence(f.target)).toMatchObject({status:'UNVERIFIED',reason:'SOURCE_INDEX_CONTRACT'});});
