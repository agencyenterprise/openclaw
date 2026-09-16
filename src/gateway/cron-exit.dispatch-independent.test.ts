import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {createCronExitWatchers} from './cron-exit-watchers.js';
import {createProcessSupervisor} from '../process/supervisor/supervisor.js';
import type {CronJob} from '../cron/types.js';
it('actual startup watcher is refused without ALS despite exact registered cron allowlist',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watcher-no-als-'));const cfg=join(root,'config.json');
 const jobId='12345678-1234-4123-8123-123456789abc';
 writeFileSync(cfg,JSON.stringify({databasePath:join(root,'never-opened.sqlite'),scopes:{'slack/C123/100.000001':1},sessionScopes:{},unscopedCronSessionKeys:['agent:main:cron:'+jobId]}),{mode:0o600});
 vi.stubEnv('OPENCLAW_THREAD_DISPATCH_CONFIG',cfg);
 const warning=vi.fn(),fire=vi.fn(),persist=vi.fn();const supervisor=createProcessSupervisor();
 const watcher=createCronExitWatchers({getProcessSupervisor:()=>supervisor,persistCompletion:persist,fireOnExit:fire,logger:{info:vi.fn(),warn:warning},shell:{command:'/bin/sh',argsFor:()=>['-c','exit 0']}});
 try{
 watcher.reconcile([{id:jobId,name:'synthetic watcher',enabled:true,createdAtMs:1,updatedAtMs:1,schedule:{kind:'on-exit',command:'true'},sessionTarget:'main',wakeMode:'now',payload:{kind:'systemEvent',text:'synthetic'},delivery:{mode:'none'},state:{}} as CronJob]);
 await vi.waitFor(()=>expect(warning).toHaveBeenCalledOnce(),{timeout:1500});
 expect(warning.mock.calls[0]?.[0]).toMatchObject({err:'Error: THREAD_DISPATCH_REFUSED',jobId});
 expect(watcher.activeJobIds()).toEqual([]);expect(fire).not.toHaveBeenCalled();expect(persist).not.toHaveBeenCalled();
 }finally{watcher.cancelAll();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}
});
