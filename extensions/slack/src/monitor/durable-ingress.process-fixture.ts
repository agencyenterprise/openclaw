import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createChannelIngressQueue } from '../../../../src/channels/message/ingress-queue.js';
import { createSlackDurableIngress, type SlackIngressPayload, type SlackIngressMetadata } from './durable-ingress.js';

const [phase, stateDir] = process.argv.slice(2);
if (!phase || !stateDir || !path.isAbsolute(stateDir)) throw new Error("Fixture requires phase and absolute state directory");
const scope = { accountId: 'synthetic-account', teamId: 'T123ABC', appId: 'A123ABC', channelId: 'C123ABC', threadTs: '1789380000.000001' };
const queue = createChannelIngressQueue<SlackIngressPayload,SlackIngressMetadata,SlackIngressMetadata>({channelId:'slack',accountId:scope.accountId,stateDir});
const ingress = createSlackDurableIngress({scope,queue,delegate:async()=>{throw new Error('Unexpected unscoped dispatch');}});
const body = {type:'event_callback',team_id:scope.teamId,api_app_id:scope.appId,event_id:'EvSynthetic001',event_time:1789380001,
  token:'synthetic-secret-must-not-persist',response_url:'https://invalid.test/synthetic-capability',
  event:{type:'message',channel:scope.channelId,user:'U123ABC',text:'Synthetic durable receipt fixture',ts:'1789380001.000002',thread_ts:scope.threadTs,event_ts:'1789380001.000002'}};
if (phase === 'receive-before-ack-crash') {
  await ingress.receive({body,ack:async()=>{
    const rows = await queue.listPending({limit:'all'});
    if (rows.length !== 1 || !rows[0] || rows[0].payload.body.token !== undefined || rows[0].payload.body.response_url !== undefined) throw new Error('Commit/redaction absent before ACK');
    writeFileSync(path.join(stateDir,'committed-before-ack.json'),JSON.stringify({id:rows[0].id,digest:rows[0].metadata?.digest,pid:process.pid}),{flag:'wx',mode:0o600});
    // Simulate death after durable commit, before transport acknowledgement.
    process.exit(17);
  }});
  throw new Error('Expected process exit');
} else if (phase === 'claim-without-redelivery') {
  const pending = await queue.listPending({limit:'all'});
  const claim = await ingress.claimOne(`synthetic-second-process:${process.pid}`);
  if(pending.length!==1 || !claim) throw new Error('Restart lost durable event');
  if(existsSync(path.join(stateDir,'claim-observed.json'))) throw new Error('Unexpected repeated consumer');
  writeFileSync(path.join(stateDir,'claim-observed.json'),JSON.stringify({id:claim.id,digest:claim.payload.digest,pid:process.pid}),{flag:'wx',mode:0o600});
  // Journal-only fixture observation, NOT an adoption/provider receipt. Leave claimed.
  process.stdout.write(JSON.stringify({phase,id:claim.id,digest:claim.payload.digest,claimed:true}));
} else if (phase === 'duplicate-claimed') {
  let acked = false;
  await ingress.receive({body,ack:async()=>{acked=true;}});
  const claims = await queue.listClaims();
  if(!acked || claims.length!==1 || !claims[0] || await ingress.claimOne(`synthetic-third-process:${process.pid}`)) throw new Error('Duplicate minted another claim');
  process.stdout.write(JSON.stringify({phase,acked,claims:claims.length,id:claims[0].id}));
} else throw new Error('Unknown phase');
