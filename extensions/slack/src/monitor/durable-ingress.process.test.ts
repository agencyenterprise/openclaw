import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('retains an actual pre-ACK commit through process death and claims it without redelivery', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'slack-ingress-process-'));
  const fixture=fileURLToPath(new URL('./durable-ingress.process-fixture.ts',import.meta.url));
  const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',NODE_ENV:'test',OPENCLAW_STATE_DIR:dir};
  const run=(phase:string)=>spawnSync(process.execPath,['--import','tsx',fixture,phase,dir],{env,cwd:process.cwd(),encoding:'utf8',timeout:20000});
  try {
    const first=run('receive-before-ack-crash');
    expect(first.error).toBeUndefined(); expect(first.status,first.stderr).toBe(17);
    const committed=JSON.parse(readFileSync(path.join(dir,'committed-before-ack.json'),'utf8'));
    const second=run('claim-without-redelivery');
    expect(second.error).toBeUndefined(); expect(second.status,second.stderr).toBe(0);
    const observed=JSON.parse(readFileSync(path.join(dir,'claim-observed.json'),'utf8'));
    expect(observed.id).toBe(committed.id); expect(observed.digest).toBe(committed.digest); expect(observed.pid).not.toBe(committed.pid);
    const third=run('duplicate-claimed');
    expect(third.error).toBeUndefined(); expect(third.status,third.stderr).toBe(0);
    const duplicate=JSON.parse(third.stdout); expect(duplicate).toMatchObject({acked:true,claims:1,id:committed.id});
  } finally { rmSync(dir,{recursive:true,force:true}); }
},65000);
