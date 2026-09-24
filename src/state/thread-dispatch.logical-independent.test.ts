import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { requireNodeSqlite } from '../infra/node-sqlite.js';
import { dispatchHash, runLogicalDispatchAttempt, withLogicalReplyDispatch, type DispatchConfig } from './thread-dispatch.js';
const roots: string[]=[];
afterEach(()=> {vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'logical-independent-'));roots.push(root);
 const databasePath=join(root,'state.sqlite');
 // Reuse frozen V2 schema fixture, rather than invent a relaxed test schema.
 const fixtureSource=readFileSync(new URL('../agents/embedded-agent-runner/run.thread-dispatch.test.ts',import.meta.url),'utf8');
 const schema=JSON.parse(fixtureSource.match(/const fenceSql =\s*("(?:[^"\\]|\\.)*");/)![1]);
 const db=new (requireNodeSqlite().DatabaseSync)(databasePath);db.exec(schema);chmodSync(databasePath,0o600);
 const scope='slack/C123/1788816064.061969'; const other='slack/C456/1788816064.061969';
 db.prepare('INSERT INTO thread_fences VALUES (?,1,?,0)').run(scope,'OPEN');db.prepare('INSERT INTO thread_fences VALUES (?,1,?,0)').run(other,'OPEN');
 const config:DispatchConfig={databasePath,scopes:{[scope]:1,[other]:1},sessionScopes:{session:scope,other}};
 const args={config,sessionKey:'session',sourceTurnId:'channel-user:v1:'+'a'.repeat(64),prompt:'original'};
 return {db,args,config,scope};
}
it('two trusted attempts share exactly one logical claim; same source cannot replay',async()=>{
 const {db,args}=fixture();let effects=0;
 try{
 await withLogicalReplyDispatch({...args,run:async(done)=>{
  for(let i=0;i<2;i++)await runLogicalDispatchAttempt({sessionKey:'session',run:async()=>{effects++;},refused:()=>undefined});
  done(dispatchHash('done'));return 'answer';
 }});
 expect(effects).toBe(2);expect(db.prepare('SELECT state FROM thread_dispatch_claims').all()).toEqual([{state:'TERMINAL'}]);
 await expect(withLogicalReplyDispatch({...args,run:async()=>{effects++;}})).rejects.toThrow('THREAD_DISPATCH_REFUSED');expect(effects).toBe(2);
 }finally{db.close();}
});
it('late inherited asynchronous context is refused without launching after outer terminal',async()=>{
 const {db,args}=fixture();let release!:()=>void;const barrier=new Promise<void>(r=>release=r);let late!:Promise<unknown>;let effects=0;
 try{
 await withLogicalReplyDispatch({...args,run:async(done)=>{
  late=(async()=>{await barrier;return runLogicalDispatchAttempt({sessionKey:'session',run:async()=>{effects++;return 'ran';},refused:()=>'refused'});})();
  done(dispatchHash('done'));
 }});
 release();await expect(late).resolves.toBe('refused');expect(effects).toBe(0);
 }finally{db.close();}
});
it('scope mismatch and drained fence reject inside otherwise valid private context',async()=>{
 const {db,args,scope}=fixture();let effects=0;
 try{await withLogicalReplyDispatch({...args,run:async()=>{
  expect(()=>runLogicalDispatchAttempt({sessionKey:'other',run:async()=>{effects++;},refused:()=>undefined})).toThrow('THREAD_DISPATCH_REFUSED');
  db.prepare("UPDATE thread_fences SET state='DRAINING' WHERE scope_key=?").run(scope);
  expect(()=>runLogicalDispatchAttempt({sessionKey:'session',run:async()=>{effects++;},refused:()=>undefined})).toThrow('THREAD_DISPATCH_REFUSED');
 }});expect(effects).toBe(0);expect(db.prepare('SELECT state FROM thread_dispatch_claims').get()).toEqual({state:'UNKNOWN'});
 }finally{db.close();}
});
it('completion callback followed by outer failure never settles terminal',async()=>{
 const {db,args}=fixture();try{
 await expect(withLogicalReplyDispatch({...args,run:async(done)=>{done(dispatchHash('done'));throw new Error('outer failure');}})).rejects.toThrow('outer failure');
 expect(db.prepare('SELECT state FROM thread_dispatch_claims').get()).toEqual({state:'UNKNOWN'});
 }finally{db.close();}
});
it('plain caller fields cannot forge inherited capability',()=>{
 const fake={sessionKey:'session',owner:{claimId:'fake'},sourceTurnId:'channel-user:v1:'+'a'.repeat(64),run:async()=>{throw new Error('must not execute');},refused:()=>{throw new Error('must not execute');}};
 expect(runLogicalDispatchAttempt(fake)).toBeUndefined();
});
it('source shape rejected before any effects; source identity cannot change replay fingerprint',async()=>{
 const {db,args}=fixture();let effects=0;try{
 await expect(withLogicalReplyDispatch({...args,sourceTurnId:'rpc-fresh-id',run:async()=>{effects++;}})).rejects.toThrow('THREAD_DISPATCH_REFUSED');
 expect(db.prepare('SELECT count(*) AS n FROM thread_dispatch_claims').get()).toEqual({n:0});
 await withLogicalReplyDispatch({...args,run:async()=>{}});
 await expect(withLogicalReplyDispatch({...args,prompt:'changed',run:async()=>{effects++;}})).rejects.toThrow('THREAD_DISPATCH_REFUSED');expect(effects).toBe(0);
 }finally{db.close();}
});
