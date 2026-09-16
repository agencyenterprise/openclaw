import { afterEach, expect, it } from 'vitest';
import { useAutoCleanupTempDirTracker } from '../../../test/helpers/temp-dir.js';
import { closeOpenClawAgentDatabasesForTest, openOpenClawAgentDatabase } from '../../state/openclaw-agent-db.js';
import { closeOpenClawStateDatabaseForTest } from '../../state/openclaw-state-db.js';
import { persistSessionTranscriptTurn, upsertSessionEntry } from './session-accessor.js';
import { readChannelSourcePreAdmissionAbsence } from './session-accessor.source-absence.js';
const dirs=useAutoCleanupTempDirTracker(afterEach);
afterEach(()=>{closeOpenClawAgentDatabasesForTest();closeOpenClawStateDatabaseForTest();});
const source='channel-user:v1:'+'d'.repeat(64);
async function fixture(){
 const env={...process.env,OPENCLAW_STATE_DIR:dirs.make('absence-independent-')};
 const database=openOpenClawAgentDatabase({agentId:'main',env});
 const scope={agentId:'main',env,storePath:database.path,sessionKey:'agent:main:slack:channel:c888:thread:100.000001',sessionId:'original-session'};
 await upsertSessionEntry(scope,{sessionId:scope.sessionId,updatedAt:1});
 const target={sessionKey:scope.sessionKey,storePath:database.path,sourceTurnId:source};
 return {database,scope,target};
}
it('old indexed source stays held after exact session key rotates to a fresh session',async()=>{
 const {database,scope,target}=await fixture();
 await persistSessionTranscriptTurn(scope,{expectedSessionId:scope.sessionId,messages:[{eventId:'old-source',message:{role:'user',content:'PRIVATE_OLD_SOURCE',idempotencyKey:source}}]});
 await upsertSessionEntry({...scope,sessionId:'new-session'},{sessionId:'new-session',updatedAt:2});
 expect(database.db.prepare('SELECT session_id FROM session_entries WHERE session_key=?').get(scope.sessionKey)?.session_id).toBe('new-session');
 expect(readChannelSourcePreAdmissionAbsence(target)).toMatchObject({status:'UNVERIFIED',reason:'SOURCE_TRANSCRIPT_PRESENT'});
});
it.each(['active','terminal'])('source recovery proof in another session remains held: %s',async(kind)=>{
 const {scope,target}=await fixture();
 await upsertSessionEntry({...scope,sessionKey:'agent:main:older',sessionId:'older-session'}, {sessionId:'older-session',updatedAt:1,...(kind==='active'?{restartRecoveryDeliveryRunId:'old-run',restartRecoveryDeliverySourceRunId:source}:{restartRecoveryTerminalRunIds:[source]})});
 expect(readChannelSourcePreAdmissionAbsence(target)).toMatchObject({status:'UNVERIFIED',reason:'SOURCE_RECOVERY_PRESENT'});
});
it.each(['broken-json','padded-source','mixed-terminal'])('malformed unrelated session metadata prevents absence: %s',async(kind)=>{
 const {database,target}=await fixture();
 const content=kind==='broken-json'?'PRIVATE_BROKEN_JSON':JSON.stringify({sessionId:'original-session',...(kind==='padded-source'?{restartRecoveryDeliverySourceRunId:' '+source}:{restartRecoveryTerminalRunIds:[42]})});
 database.db.prepare('UPDATE session_entries SET entry_json=?').run(content);
 const result=readChannelSourcePreAdmissionAbsence(target);expect(result.status).toBe('UNVERIFIED');expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('per-entry size overflow prevents absence without emitting contents',async()=>{
 const {database,target}=await fixture();database.db.prepare('UPDATE session_entries SET entry_json=?').run(JSON.stringify({sessionId:'original-session',payload:'PRIVATE'.repeat(50000)}));
 expect(readChannelSourcePreAdmissionAbsence(target)).toMatchObject({status:'UNVERIFIED',reason:'RECOVERY_SCAN_LIMIT'});
});
it('recovery row cap prevents absence even with individually valid entries',async()=>{
 const {database,target}=await fixture();
 const columns=database.db.prepare('PRAGMA table_info(session_entries)').all().map(r=>String(r.name));
 const quoted=columns.map(n=>'"'+n+'"');const selection=columns.map(n=>n==='session_key'?'?':'"'+n+'"').join(',');
 const insert=database.db.prepare('INSERT INTO session_entries('+quoted.join(',')+') SELECT '+selection+' FROM session_entries WHERE session_key=?');
 database.db.exec('BEGIN');try{for(let i=0;i<1024;i++)insert.run('agent:main:historical-'+i,target.sessionKey);database.db.exec('COMMIT');}catch(e){database.db.exec('ROLLBACK');throw e;}
 expect(readChannelSourcePreAdmissionAbsence(target)).toMatchObject({status:'UNVERIFIED',reason:'RECOVERY_SCAN_LIMIT'});
});

it('missing historical identity coverage cannot certify absent source',async()=>{
 const {database,scope,target}=await fixture();
 await persistSessionTranscriptTurn(scope,{expectedSessionId:scope.sessionId,messages:[{eventId:'lost-identity',message:{role:'user',content:'PRIVATE_OLD_SOURCE',idempotencyKey:source}}]});
 database.db.prepare('DELETE FROM transcript_event_identities WHERE event_id=?').run('lost-identity');
 expect(readChannelSourcePreAdmissionAbsence(target).status).toBe('UNVERIFIED');
});
it('explicit historical source key cannot hide in an unindexed non-user event',async()=>{
 const {database,scope,target}=await fixture();
 await persistSessionTranscriptTurn(scope,{expectedSessionId:scope.sessionId,messages:[{eventId:'nonuser-source',message:{role:'user',content:'PRIVATE_OLD_SOURCE',idempotencyKey:source}}]});
 const row=database.db.prepare("SELECT event_json,seq FROM transcript_events WHERE event_json LIKE '%nonuser-source%'").get() as {event_json:string,seq:number};
 const event=JSON.parse(row.event_json);event.message.role='assistant';
 database.db.prepare('UPDATE transcript_events SET event_json=? WHERE seq=?').run(JSON.stringify(event),row.seq);
 database.db.prepare('DELETE FROM transcript_event_identities WHERE event_id=?').run('nonuser-source');
 expect(readChannelSourcePreAdmissionAbsence(target).status).toBe('UNVERIFIED');
});
