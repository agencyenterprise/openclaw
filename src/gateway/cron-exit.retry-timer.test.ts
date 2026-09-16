import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCronExitWatchers } from "./cron-exit-watchers.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { createCronServiceState } from "../cron/service/state.js";
import { armTimer } from "../cron/service/timer.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { dispatchHash, admitThreadDispatch, settleThreadDispatch, NativeDispatchBusyError, readNativeAdmissionBusy, type DispatchConfig } from "../state/thread-dispatch.js";
import type { CronJob } from "../cron/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function fixture() {
 vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]});
 vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
 const root=mkdtempSync(join(tmpdir(),"exit-retry-")); cleanups.push(()=>rmSync(root,{recursive:true,force:true})); vi.stubEnv("OPENCLAW_STATE_DIR",root);
 const databasePath=join(root,"fence.sqlite"), configPath=join(root,"fence.json"), storePath=join(root,"cron","jobs.json");
 const sql=readFileSync(new URL("../state/thread-dispatch.test.ts",import.meta.url),"utf8").match(/const SQL =\s*("(?:[^"\\]|\\.)*");/s)?.[1];if(!sql)throw Error("SCHEMA");
 const db=new (requireNodeSqlite().DatabaseSync)(databasePath);db.exec(JSON.parse(sql));chmodSync(databasePath,0o600);cleanups.push(()=>db.close());
 const scope="slack/C123/100.000001",session="agent:main:slack:channel:c123:thread:100.000001";
 db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
 const config={databasePath,scopes:{[scope]:1},sessionScopes:{[session]:scope}} as DispatchConfig;
 writeFileSync(configPath,JSON.stringify(config),{mode:0o600});vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG",configPath);
 const owner={claimId:"existing-owner",scopeKey:scope,epoch:1,kind:"native",fingerprint:"a".repeat(64)};admitThreadDispatch(config,owner);
 const job={id:"12345678-1234-4123-8123-123456789abc",name:"original fixture",enabled:true,createdAtMs:1,updatedAtMs:2,schedule:{kind:"on-exit",command:"printf fixture"},sessionTarget:"isolated",sessionKey:session,wakeMode:"now",payload:{kind:"systemEvent",text:"fixture"},delivery:{mode:"none"},state:{}} as CronJob;
 await saveCronStore(storePath,{version:1,jobs:[job]});
 const supervisor=createProcessSupervisor(), spawn=vi.spyOn(supervisor,"spawn"), fire=vi.fn(), warn=vi.fn();
 const makeWatcher=(origin=()=>session)=>createCronExitWatchers({getProcessSupervisor:()=>supervisor,resolveDispatchOrigin:origin,persistCompletion:async()=>{const store=await loadCronStore(storePath);store.jobs[0]!.enabled=false;await saveCronStore(storePath,store);},fireOnExit:fire,logger:{info:vi.fn(),warn},shell:{command:"/usr/bin/printf",argsFor:()=>["fixture"]}});
 const watcher=makeWatcher();cleanups.push(()=>watcher.cancelAll());
 const maintenance=vi.fn(async()=>watcher.retryPending((await loadCronStore(storePath)).jobs));
 const state=createCronServiceState({storePath,cronEnabled:true,log:{debug:vi.fn(),info:vi.fn(),warn,error:vi.fn()},enqueueSystemEvent:vi.fn(),requestHeartbeat:vi.fn(),runIsolatedAgentJob:vi.fn(async()=>{throw Error("NO_PROVIDER");}),onMaintenance:maintenance});
 state.store=await loadCronStore(storePath);cleanups.push(()=>{state.stopped=true;if(state.timer)clearTimeout(state.timer);});
 return {root,db,config,owner,job,storePath,watcher,makeWatcher,maintenance,state,spawn,fire,warn};
}

it("actual maintenance timer retries original BUSY watcher once after owner terminal",async()=>{
 const f=await fixture();f.watcher.reconcile([f.job]);await vi.waitFor(()=>expect(f.warn).toHaveBeenCalledOnce());
 expect(f.spawn).not.toHaveBeenCalled();armTimer(f.state);
 await vi.advanceTimersByTimeAsync(59_999);expect(f.maintenance).not.toHaveBeenCalled();
 settleThreadDispatch(f.config,f.owner,"b".repeat(64));
 await vi.advanceTimersByTimeAsync(1);await vi.waitFor(()=>expect(f.fire).toHaveBeenCalledOnce(),{timeout:2000});
 expect(f.maintenance).toHaveBeenCalledOnce();expect(f.spawn).toHaveBeenCalledOnce();
 const stored=(await loadCronStore(f.storePath)).jobs[0]!;expect(stored.id).toBe(f.job.id);expect(stored.updatedAtMs).toBe(2);expect(stored.enabled).toBe(false);
 expect(f.db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims WHERE kind='native'").get()).toEqual({n:2});
 await vi.advanceTimersByTimeAsync(180_000);expect(f.spawn).toHaveBeenCalledOnce();
},15000);

it("UNKNOWN incumbent remains held across automatic minute ticks without spawning",async()=>{
 const f=await fixture();settleThreadDispatch(f.config,f.owner);f.watcher.reconcile([f.job]);await vi.waitFor(()=>expect(f.warn).toHaveBeenCalledOnce());armTimer(f.state);
 await vi.advanceTimersByTimeAsync(180_000);expect(f.maintenance).toHaveBeenCalledTimes(3);expect(f.warn).toHaveBeenCalledTimes(4);expect(f.spawn).not.toHaveBeenCalled();
 expect(f.db.prepare("SELECT claim_id,state FROM thread_dispatch_claims").all()).toEqual([{claim_id:"existing-owner",state:"UNKNOWN"}]);expect((await loadCronStore(f.storePath)).jobs[0]!.enabled).toBe(true);
},15000);

it("forged typed BUSY has no private admission receipt and is never auto-retried",async()=>{
 const f=await fixture();expect(readNativeAdmissionBusy(new NativeDispatchBusyError())).toBeUndefined();
 const origin=vi.fn(()=>{throw new NativeDispatchBusyError();});const watcher=f.makeWatcher(origin);cleanups.push(()=>watcher.cancelAll());watcher.reconcile([f.job]);await vi.waitFor(()=>expect(origin).toHaveBeenCalledOnce());
 f.state.deps.onMaintenance=async()=>watcher.retryPending((await loadCronStore(f.storePath)).jobs);armTimer(f.state);await vi.advanceTimersByTimeAsync(180_000);expect(origin).toHaveBeenCalledOnce();expect(f.spawn).not.toHaveBeenCalled();
},15000);

it("stop cancels automatic reconciliation without clearing durable pending job",async()=>{
 const f=await fixture();f.watcher.reconcile([f.job]);await vi.waitFor(()=>expect(f.warn).toHaveBeenCalledOnce());armTimer(f.state);f.state.stopped=true;f.watcher.cancelAll();
 settleThreadDispatch(f.config,f.owner,"b".repeat(64));await vi.advanceTimersByTimeAsync(180_000);expect(f.maintenance).not.toHaveBeenCalled();expect(f.spawn).not.toHaveBeenCalled();expect((await loadCronStore(f.storePath)).jobs[0]!.enabled).toBe(true);
},15000);

it("consumer crash before admission reopens same durable job and timer recovers it",async()=>{
 const f=await fixture();const pinnedJob=JSON.stringify((await loadCronStore(f.storePath)).jobs[0]);
 vi.useRealTimers();
 const child=spawnSync(process.execPath,["--import","tsx",fileURLToPath(new URL("../../test/fixtures/cron-watch-busy-crash.mts",import.meta.url)),f.storePath],{encoding:"utf8",env:process.env,timeout:20000,maxBuffer:65536});
 expect(child.error).toBeUndefined();expect(child.status).toBe(17);expect(child.signal).toBeNull();expect(child.stdout).toBe("ORIGINAL_BUSY_BEFORE_SPAWN\n");
 expect(JSON.stringify((await loadCronStore(f.storePath)).jobs[0])).toBe(pinnedJob);
 expect(f.db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()).toEqual({n:1});
 vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]});vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
 // Fresh consumer's ordinary startup reconciliation; recovery after owner exit
 // is performed ONLY by the subsequently armed actual scheduler timer.
 f.watcher.reconcile((await loadCronStore(f.storePath)).jobs);await vi.waitFor(()=>expect(f.warn).toHaveBeenCalledOnce());armTimer(f.state);
 settleThreadDispatch(f.config,f.owner,"b".repeat(64));await vi.advanceTimersByTimeAsync(60_000);await vi.waitFor(()=>expect(f.fire).toHaveBeenCalledOnce(),{timeout:2000});expect(f.spawn).toHaveBeenCalledOnce();
 expect((await loadCronStore(f.storePath)).jobs[0]!.id).toBe(f.job.id);
},30000);

it("a genuine receipt thrown by origin lookup cannot authorize watcher retry",async()=>{
 const f=await fixture();const command=f.job.schedule.kind==="on-exit"?f.job.schedule.command:"";
 const operationId=`cron-watch:${f.job.id}:${f.job.updatedAtMs}:${dispatchHash({command,cwd:null})}`;
 let captured:unknown;try{admitThreadDispatch(f.config,{...f.owner,claimId:operationId});}catch(error){captured=error;}
 expect(readNativeAdmissionBusy(captured)?.claimId).toBe(operationId);
 const origin=vi.fn(()=>{throw captured;});const watcher=f.makeWatcher(origin);cleanups.push(()=>watcher.cancelAll());watcher.reconcile([f.job]);await vi.waitFor(()=>expect(origin).toHaveBeenCalledOnce());
 f.state.deps.onMaintenance=async()=>watcher.retryPending((await loadCronStore(f.storePath)).jobs);armTimer(f.state);await vi.advanceTimersByTimeAsync(120_000);expect(origin).toHaveBeenCalledOnce();expect(f.spawn).not.toHaveBeenCalled();
},15000);
