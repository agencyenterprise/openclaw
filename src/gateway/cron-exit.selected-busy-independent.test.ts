import {mkdtempSync,writeFileSync,readFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {createCronExitWatchers} from './cron-exit-watchers.js';
import {resolveCronDispatchOrigin} from './cron-dispatch-origin.js';
import {createProcessSupervisor} from '../process/supervisor/supervisor.js';
import {requireNodeSqlite} from '../infra/node-sqlite.js';
import type {CronJob} from '../cron/types.js';
it('persisted selected origin defeats unrelated job allowlist and stays BUSY before real supervisor',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watcher-selected-'));const cfg=join(root,'config.json');const databasePath=join(root,'fence.sqlite');
 const jobId='12345678-1234-4123-8123-123456789abc',scope='slack/C123/100.000001',session='agent:main:slack:channel:c123:thread:100.000001';
 const matched=readFileSync(new URL('../state/thread-dispatch.test.ts',import.meta.url),'utf8').match(/const SQL =\s*("(?:[^"\\]|\\.)*");/s);const raw=matched?.[1];if(!raw)throw Error('FIXTURE_SCHEMA');
 const db=new(requireNodeSqlite().DatabaseSync)(databasePath);db.exec(JSON.parse(raw));chmodSync(databasePath,0o600);
 db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
 db.prepare("INSERT INTO thread_dispatch_claims VALUES ('incumbent',?,1,?,'native','UNKNOWN',0,0,NULL)").run(scope,'a'.repeat(64));
 writeFileSync(cfg,JSON.stringify({databasePath,scopes:{[scope]:1},sessionScopes:{[session]:scope},unscopedCronSessionKeys:['agent:main:cron:'+jobId]}),{mode:0o600});vi.stubEnv('OPENCLAW_THREAD_DISPATCH_CONFIG',cfg);
 const supervisor=createProcessSupervisor();const spawn=vi.spyOn(supervisor,'spawn');const warning=vi.fn(),fire=vi.fn(),persist=vi.fn();const marker=join(root,'UNEXPECTED');
 const watcher=createCronExitWatchers({getProcessSupervisor:()=>supervisor,resolveDispatchOrigin:job=>resolveCronDispatchOrigin(job,'main',{}),persistCompletion:persist,fireOnExit:fire,logger:{info:vi.fn(),warn:warning},shell:{command:'/usr/bin/touch',argsFor:()=>[marker]}});
 const job={id:jobId,name:'synthetic selected watcher',enabled:true,createdAtMs:1,updatedAtMs:1,schedule:{kind:'on-exit',command:'synthetic'},sessionTarget:'isolated',sessionKey:session,wakeMode:'now',payload:{kind:'systemEvent',text:'synthetic'},delivery:{mode:'none'},state:{}} as CronJob;
 try{
 watcher.reconcile([job]);await vi.waitFor(()=>expect(warning).toHaveBeenCalledOnce(),{timeout:1500});
 expect(warning.mock.calls[0]?.[0]).toMatchObject({err:'NativeDispatchBusyError: NATIVE_BUSY',jobId});expect(spawn).not.toHaveBeenCalled();expect(existsSync(marker)).toBe(false);
 expect(fire).not.toHaveBeenCalled();expect(persist).not.toHaveBeenCalled();expect(job.enabled).toBe(true);expect(watcher.activeJobIds()).toEqual([]);
 expect(db.prepare('SELECT claim_id,state FROM thread_dispatch_claims').all()).toEqual([{claim_id:'incumbent',state:'UNKNOWN'}]);
 }finally{watcher.cancelAll();spawn.mockRestore();vi.unstubAllEnvs();db.close();rmSync(root,{recursive:true,force:true});}
});
