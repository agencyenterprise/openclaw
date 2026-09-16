import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createChannelIngressQueue } from '../../../../src/channels/message/ingress-queue.js';
import { persistSessionTranscriptTurn, upsertSessionEntry } from '../../../../src/config/sessions/session-accessor.js';
import { closeOpenClawAgentDatabasesForTest, openOpenClawAgentDatabase } from '../../../../src/state/openclaw-agent-db.js';
import { closeOpenClawStateDatabase } from '../../../../src/state/openclaw-state-db.js';
import { installSourceCoverageIndexes } from '../../../../src/config/sessions/session-source-index.js';
import { requireNodeSqlite } from '../../../../src/infra/node-sqlite.js';
import { withLogicalChannelDispatch, dispatchHash, type DispatchConfig } from '../../../../src/state/thread-dispatch.js';
import { buildChannelSourceTurnId, setChannelSourceTurnId } from '../../../../src/auto-reply/reply/source-turn-id.js';
import { createSlackDurableIngress, type SlackIngressPayload, type SlackIngressMetadata } from './durable-ingress.js';
import { attachSlackPreparedIngress, getSlackIngressAdoptionCallback, withSlackIngressOptions } from './durable-adoption.js';
import { createSlackDurableMonitor } from './durable-monitor.js';
const phaseArg=process.argv[2], stateDirArg=process.argv[3];
if (process.argv.length!==4 || !phaseArg || !['owner','consumer1','consumer2','audit'].includes(phaseArg) || !stateDirArg) throw new Error('FIXTURE_ARGUMENTS');
const phase:string=phaseArg, stateDir:string=stateDirArg;
const log=(event:string,extra:Record<string,unknown>={})=>appendFileSync(join(stateDir,'events.jsonl'),JSON.stringify({event,phase,pid:process.pid,time:Date.now(),...extra})+'\n',{mode:0o600});
const scope={accountId:'fixture',teamId:'T123',appId:'A123',channelId:'C123',threadTs:'100.000001'};
const sessionKey='agent:main:slack:channel:c123:thread:100.000001';
const source=buildChannelSourceTurnId({provider:'slack',accountId:'fixture',conversationId:'channel:C123',messageId:'101.000001'})!;
const fencePath=join(stateDir,'fence.sqlite');
const config:DispatchConfig={databasePath:fencePath,scopes:{'slack/C123/100.000001':1},sessionScopes:{[sessionKey]:'slack/C123/100.000001'}};
const database=openOpenClawAgentDatabase({agentId:'main',env:process.env});
const target={storePath:database.path,sessionKey,sessionId:'original-fixture-session',sourceTurnId:source};
const storeScope={...target,agentId:'main',env:process.env};
const deadline=Date.now()+55000;
const waitFor=async(name:string)=>{while(!existsSync(join(stateDir,name))){if(Date.now()>deadline)throw new Error('FIXTURE_DEADLINE');await new Promise(r=>setTimeout(r,30));}};
try{
 if(phase==='owner'){
  await upsertSessionEntry(storeScope,{sessionId:target.sessionId,updatedAt:1});
  installSourceCoverageIndexes(database.db);log('EXPLICIT_FIXTURE_INDEX_INSTALLED');
  const sqlSource=readFileSync(new URL('../../../../src/state/thread-dispatch.test.ts',import.meta.url),'utf8');
  const matched=sqlSource.match(/const SQL =\s*("(?:[^"\\]|\\.)*");/s);
  const encoded=matched?.[1];if(!encoded)throw new Error('FIXTURE_SCHEMA_MISSING');
  const sql:unknown=JSON.parse(encoded);if(typeof sql!=='string')throw new Error('FIXTURE_SCHEMA_INVALID');
  const db=new(requireNodeSqlite().DatabaseSync)(fencePath);db.exec(sql);chmodSync(fencePath,0o600);db.prepare("INSERT INTO thread_fences VALUES ('slack/C123/100.000001',1,'OPEN',0)").run();db.close();
  await withLogicalChannelDispatch({config,sessionKey,sourceTurnId:'channel-user:v1:'+'c'.repeat(64),prompt:'synthetic incumbent',run:async(done)=>{
   log('OWNER_ACTIVE');writeFileSync(join(stateDir,'owner-ready'),String(process.pid),{flag:'wx',mode:0o600});
   await waitFor('finish-owner');log('OWNER_COMPLETION_OBSERVED');done(dispatchHash('known synthetic owner completed'));
  }});
  log('OWNER_TERMINAL');writeFileSync(join(stateDir,'owner-terminal'),String(process.pid),{flag:'wx',mode:0o600});
 }else if(phase==='consumer1'||phase==='consumer2'){
  const queue=createChannelIngressQueue<SlackIngressPayload,SlackIngressMetadata,SlackIngressMetadata>({channelId:'slack',accountId:scope.accountId,stateDir});
  const journal=createSlackDurableIngress({scope,queue,delegate:async()=>{throw new Error('UNEXPECTED_DELEGATE');}});
  if(phase==='consumer1'){
   await journal.receive({body:{type:'event_callback',team_id:scope.teamId,api_app_id:scope.appId,event_id:'EvRestartFixture',event:{type:'message',channel:scope.channelId,user:'U123',ts:'101.000001',thread_ts:scope.threadTs,text:'synthetic original source'}},ack:async()=>{log('RECEIVE_ACK');}});
  }else{
   const pending=await queue.listPending();const first=pending[0];if(pending.length!==1||!first)throw new Error('PENDING_RESTART_MISSING');log('REOPEN_PENDING',{id:first.id});
  }
  let monitor:ReturnType<typeof createSlackDurableMonitor>;let releases=0;
  const release=queue.release.bind(queue);
  queue.release=async(...args:Parameters<typeof queue.release>)=>{const result=await release(...args);if(result){releases++;log('VERIFIED_BUSY_RELEASE',{id:typeof args[0]==='string'?args[0]:args[0].id});writeFileSync(join(stateDir,phase+'-released'),String(process.pid),{mode:0o600});if(phase==='consumer1')monitor.stop();}return result;};
  const complete=queue.complete.bind(queue);
  queue.complete=async(...args:Parameters<typeof queue.complete>)=>{const result=await complete(...args);if(result){log('QUEUE_COMPLETED',{id:typeof args[0]==='string'?args[0]:args[0].id});monitor.stop();}return result;};
  monitor=createSlackDurableMonitor({scope,queue,onHeld:()=>{log('HELD_UNCERTAIN');}});
  monitor.bindApp({processEvent:async({body})=>{
   log('SYNTHETIC_APP_DISPATCH');const event=(body as {event:object}).event;
   const opts=withSlackIngressOptions(event,{source:'message'});if(opts.awaitDispatch!==true)throw new Error('BRIDGE_NOT_ATTACHED');
   const context={};setChannelSourceTurnId(context,source);attachSlackPreparedIngress(opts,context,target);
   const adopted=getSlackIngressAdoptionCallback(context);if(!adopted)throw new Error('ADOPTION_CALLBACK_MISSING');
   await withLogicalChannelDispatch({config,sessionKey,sourceTurnId:source,prompt:'synthetic original source',run:async(done)=>{
    log('SYNTHETIC_EFFECT');
    await persistSessionTranscriptTurn(storeScope,{expectedSessionId:target.sessionId,sessionLifecyclePatch:{restartRecoveryDeliveryRunId:'original-fixture-run',restartRecoveryDeliverySourceRunId:source,restartRecoverySourceIngress:'channel',status:'running',updatedAt:Date.now()},messages:[{eventId:'original-fixture-user-event',message:{role:'user',content:'synthetic original source',idempotencyKey:source}}]});
    await adopted(target);log('ADOPTION_READBACK_COMPLETED');done(dispatchHash('known synthetic reply completed'));
   }});
  }});
  const timer=setTimeout(()=>{log('CONSUMER_DEADLINE');monitor.stop();},50000);
  try{await monitor.start();}finally{clearTimeout(timer);monitor.stop();}
  const summary={phase,pid:process.pid,pending:(await queue.listPending()).length,claims:(await queue.listClaims()).length,releases};
  writeFileSync(join(stateDir,phase+'-result.json'),JSON.stringify(summary),{flag:'wx',mode:0o600});log('CONSUMER_STOPPED',summary);
 }else if(phase==='audit'){
  const queue=createChannelIngressQueue<SlackIngressPayload,SlackIngressMetadata,SlackIngressMetadata>({channelId:'slack',accountId:scope.accountId,stateDir});
  const db=new(requireNodeSqlite().DatabaseSync)(fencePath,{readOnly:true});
  const claims=db.prepare('SELECT claim_id,kind,state,terminal_receipt FROM thread_dispatch_claims ORDER BY claim_id').all();db.close();
  const sourceCount=database.db.prepare('SELECT count(*) AS n FROM transcript_event_identities WHERE message_idempotency_key=?').get(source)?.n;
  const result={claims,sourceCount,pending:(await queue.listPending()).length,held:(await queue.listClaims()).length,source};
  writeFileSync(join(stateDir,'audit.json'),JSON.stringify(result),{flag:'wx',mode:0o600});
 }else throw new Error('UNKNOWN_PHASE');
}finally{closeOpenClawAgentDatabasesForTest();closeOpenClawStateDatabase();}
