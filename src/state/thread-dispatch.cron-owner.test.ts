import {chmodSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {requireNodeSqlite} from '../infra/node-sqlite.js';
import {withCronDispatchOwner,bindCronDispatchSession,runCronDispatchAttempt,dispatchHash,admitDispatchChild} from './thread-dispatch.js';
const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function setup(){const root=mkdtempSync(join(tmpdir(),'cron-owner-'));roots.push(root);const databasePath=join(root,'db');
 const source=readFileSync(new URL('../agents/embedded-agent-runner/run.thread-dispatch.test.ts',import.meta.url),'utf8');
 const sql=JSON.parse(source.match(/const fenceSql =\s*("(?:[^"\\]|\\.)*");/)![1]);
 const db=new (requireNodeSqlite().DatabaseSync)(databasePath);db.exec(sql);chmodSync(databasePath,0o600);
 const scope='slack/C123/1788816064.061969',sessionKey='agent:main:slack:channel:c123:thread:1788816064.061969';
 db.prepare('INSERT INTO thread_fences VALUES (?,1,?,0)').run(scope,'OPEN');
 const cp=join(root,'config');writeFileSync(cp,JSON.stringify({databasePath,scopes:{[scope]:1},sessionScopes:{[sessionKey]:scope}}),{mode:0o600});vi.stubEnv('OPENCLAW_THREAD_DISPATCH_CONFIG',cp);
 return {db,scope,sessionKey};}
const execution='agent:main:cron:12345678-1234-4123-8123-123456789abc:run:abcdefab-1234-4123-8123-123456789abc';
const owner=(sessionKey:string,operationId:string,run:()=>Promise<string>)=>withCronDispatchOwner({sessionKey,operationId,identity:{job:'persisted'},run,completed:r=>r==='ok'});
it('persisted selected origin owns detached attempts and children, once across fallback',async()=>{const {db,sessionKey}=setup();try{
 await owner(sessionKey,'cron:one',async()=>{bindCronDispatchSession(execution);for(let i=0;i<2;i++)await runCronDispatchAttempt({sessionKey:execution,run:async()=>{if(i===0)admitDispatchChild({child:true})?.();return 'ok';},terminalReceipt:()=>dispatchHash('done')});return 'ok';});
 expect(db.prepare('SELECT kind,state FROM thread_dispatch_claims ORDER BY kind').all()).toEqual([{kind:'native',state:'TERMINAL'},{kind:'process_child',state:'UNKNOWN'}]);
 await expect(owner(sessionKey,'cron:one',async()=> 'ok')).rejects.toThrow('THREAD_DISPATCH_REFUSED');
 }finally{db.close();}});
it('selected BUSY refuses before preparation callback',async()=>{const {db,sessionKey}=setup();try{await owner(sessionKey,'incumbent',async()=> 'unknown');const effect=vi.fn(async()=> 'ok');await expect(owner(sessionKey,'successor',effect)).rejects.toThrow('NATIVE_BUSY');expect(effect).not.toHaveBeenCalled();}finally{db.close();}});
it('unrelated canonical thread retains private unconfigured child routing',async()=>{const {db,sessionKey}=setup();try{await owner(sessionKey.replace('c123','c999'),'other',async()=>{bindCronDispatchSession(execution);return runCronDispatchAttempt({sessionKey:execution,run:async()=>{expect(admitDispatchChild({})).toBeUndefined();return 'ok';},terminalReceipt:()=>dispatchHash('done')});});expect(db.prepare('SELECT count(*) n FROM thread_dispatch_claims').get()).toEqual({n:0});}finally{db.close();}});
it('wrong execution alias and a newly drained owner cannot start effects',async()=>{const {db,sessionKey,scope}=setup();try{await owner(sessionKey,'cron:guard',async()=>{bindCronDispatchSession(execution);const effect=vi.fn(async()=> 'ok');await expect(runCronDispatchAttempt({sessionKey:execution+'x',run:effect,terminalReceipt:()=>dispatchHash('x')})).rejects.toThrow('REFUSED');db.prepare("UPDATE thread_fences SET state='DRAINING' WHERE scope_key=?").run(scope);await expect(runCronDispatchAttempt({sessionKey:execution,run:effect,terminalReceipt:()=>dispatchHash('x')})).rejects.toThrow('REFUSED');expect(effect).not.toHaveBeenCalled();return 'unknown';});}finally{db.close();}});
it('late inherited attempt cannot act after outer completion',async()=>{const {db,sessionKey}=setup();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let late!:Promise<unknown>;try{await owner(sessionKey,'cron:late',async()=>{bindCronDispatchSession(execution);late=(async()=>{await gate;return runCronDispatchAttempt({sessionKey:execution,run:async()=> 'bad',terminalReceipt:()=>dispatchHash('x')});})();return runCronDispatchAttempt({sessionKey:execution,run:async()=> 'ok',terminalReceipt:()=>dispatchHash('done')});});const reject=expect(late).rejects.toThrow('REFUSED');release();await reject;}finally{db.close();}});

it('actual isolated cron entrypoint returns durable BUSY before invalid preparation inputs are touched',async()=>{const {db,sessionKey}=setup();try{await owner(sessionKey,'entry-incumbent',async()=> 'unknown');const {runCronIsolatedAgentTurn}=await import('../cron/isolated-agent/run.js');const notify=vi.fn();const result=await runCronIsolatedAgentTurn({cfg:{},deps:{} as never,job:{id:'12345678-1234-4123-8123-123456789abc',agentId:'main',sessionKey,sessionTarget:'isolated',state:{runningAtMs:123},payload:{kind:'agentTurn',message:'synthetic'}} as never,message:'synthetic',sessionKey:'cron:12345678-1234-4123-8123-123456789abc',agentId:'main',onExecutionStarted:notify});expect(result).toMatchObject({status:'skipped',error:'NATIVE_BUSY',executionStarted:false});expect(notify).not.toHaveBeenCalled();expect(db.prepare('SELECT count(*) n FROM thread_dispatch_claims').get()).toEqual({n:1});}finally{db.close();}},90000);
