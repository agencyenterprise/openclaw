import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { closeOpenClawStateDatabaseForTest } from '../../state/openclaw-state-db.js';
import { createChannelIngressQueue } from './ingress-queue.js';

it('selects a later matching lane before the bound without claiming unrelated backlog', async () => {
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'ingress-lane-filter-'));
  const q=createChannelIngressQueue<{n:number}>({channelId:'slack',accountId:'fixture',stateDir});
  try {
    for(let i=0;i<40;i++) await q.enqueue(`earlier-${i}`,{n:i},{laneKey:'other-thread',receivedAt:i});
    await q.enqueue('selected-a',{n:100},{laneKey:'selected-thread',receivedAt:100});
    await q.enqueue('selected-b',{n:101},{laneKey:'selected-thread',receivedAt:101});
    const before=await q.listPending({limit:'all',laneKey:'other-thread'});
    const chosen=await q.listPending({limit:1,laneKey:'selected-thread'});
    expect(chosen.map(r=>r.id)).toEqual(['selected-a']);
    const claim=await q.claimNext({candidateIds:chosen.map(r=>r.id),ownerId:'fixture-owner',scanLimit:1});
    expect(claim?.id).toBe('selected-a');
    expect(await q.listPending({limit:'all',laneKey:'other-thread'})).toEqual(before);
    expect((await q.listClaims()).map(r=>r.id)).toEqual(['selected-a']);
    expect((await q.listPending({limit:1}))[0].id).toBe('earlier-0');
    await expect(q.listPending({laneKey:''})).rejects.toThrow('lane filter');
    await expect(q.listPending({laneKey:'   '})).rejects.toThrow('lane filter');
  } finally {closeOpenClawStateDatabaseForTest();await fs.rm(stateDir,{recursive:true,force:true});}
});
