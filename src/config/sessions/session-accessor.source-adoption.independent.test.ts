import { afterEach, expect, it } from 'vitest';
import { useAutoCleanupTempDirTracker } from '../../../test/helpers/temp-dir.js';
import { closeOpenClawAgentDatabasesForTest, openOpenClawAgentDatabase } from '../../state/openclaw-agent-db.js';
import { closeOpenClawStateDatabaseForTest } from '../../state/openclaw-state-db.js';
import { persistSessionTranscriptTurn, upsertSessionEntry } from './session-accessor.js';
import { readChannelSourceAdoptionReceipt } from './session-accessor.source-adoption.js';
const dirs=useAutoCleanupTempDirTracker(afterEach);
afterEach(()=>{closeOpenClawAgentDatabasesForTest();closeOpenClawStateDatabaseForTest();});
const source='channel-user:v1:'+'b'.repeat(64);
async function fixture(){
 const env={...process.env,OPENCLAW_STATE_DIR:dirs.make('adoption-independent-')};
 const database=openOpenClawAgentDatabase({agentId:'main',env});
 const scope={agentId:'main',env,storePath:database.path,sessionKey:'agent:main:slack:channel:c777:thread:100.000001',sessionId:'original-session'};
 await upsertSessionEntry(scope,{sessionId:scope.sessionId,updatedAt:1});
 await persistSessionTranscriptTurn(scope,{expectedSessionId:scope.sessionId,
 sessionLifecyclePatch:{restartRecoveryDeliveryRunId:'original-run',restartRecoveryDeliverySourceRunId:source,restartRecoverySourceIngress:'channel',status:'running',updatedAt:2},
 messages:[{eventId:'original-event',message:{role:'user',content:'PRIVATE_FIXTURE_SENTINEL',idempotencyKey:source}}]});
 const target={sessionId:scope.sessionId,sessionKey:scope.sessionKey,storePath:database.path,sourceTurnId:source};
 function mutate(patch:Record<string,unknown>){const row=database.db.prepare('SELECT entry_json FROM session_entries WHERE session_key=?').get(scope.sessionKey) as {entry_json:string};const entry=JSON.parse(row.entry_json);Object.assign(entry,patch);database.db.prepare('UPDATE session_entries SET entry_json=? WHERE session_key=?').run(JSON.stringify(entry),scope.sessionKey);}
 return {database,target,mutate};
}
it.each([
 {restartRecoveryDeliveryRunId:' original-run '},
 {restartRecoveryDeliverySourceRunId:' '+source+' '},
 {restartRecoveryTerminalRunIds:source},
 {restartRecoveryTerminalRunIds:[source,42]},
 {restartRecoveryTerminalRunIds:[' '+source+' ']},
])('malformed proof remains held even when forgiving old predicate could match %j',async(patch)=>{
 const {target,mutate}=await fixture();mutate(patch);
 expect(readChannelSourceAdoptionReceipt(target).status).toBe('UNVERIFIED');
});
it('valid transcript plus a different recovery source cannot prove adoption',async()=>{
 const {target,mutate}=await fixture();mutate({restartRecoveryDeliverySourceRunId:'channel-user:v1:'+'c'.repeat(64)});
 expect(readChannelSourceAdoptionReceipt(target)).toMatchObject({status:'UNVERIFIED',reason:'RECOVERY_PROOF_ABSENT'});
});
it('payload pretending to contain recovery proof cannot substitute for session proof',async()=>{
 const {target,mutate,database}=await fixture();mutate({restartRecoveryDeliveryRunId:undefined,restartRecoveryDeliverySourceRunId:undefined});
 const row=database.db.prepare("SELECT seq,event_json FROM transcript_events WHERE event_json LIKE '%original-event%'").get() as {seq:number,event_json:string};const event=JSON.parse(row.event_json);
 event.message.restartRecoveryDeliveryRunId='forged';event.message.restartRecoveryDeliverySourceRunId=source;
 database.db.prepare('UPDATE transcript_events SET event_json=? WHERE seq=?').run(JSON.stringify(event),row.seq);
 const result=readChannelSourceAdoptionReceipt(target);expect(result.status).toBe('UNVERIFIED');expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE_SENTINEL');
});
it('terminal source proof cannot replace missing indexed user event',async()=>{
 const {target,mutate,database}=await fixture();mutate({restartRecoveryDeliveryRunId:undefined,restartRecoveryDeliverySourceRunId:undefined,restartRecoveryTerminalRunIds:[source]});
 database.db.prepare('UPDATE transcript_event_identities SET message_idempotency_key=? WHERE event_id=?').run('foreign','original-event');
 expect(readChannelSourceAdoptionReceipt(target)).toMatchObject({status:'UNVERIFIED',reason:'SOURCE_ABSENT_OR_AMBIGUOUS'});
});
