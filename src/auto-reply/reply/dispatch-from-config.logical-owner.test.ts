import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { withNativeControlProbe, admitThreadDispatch, dispatchHash, readNativePreAdmissionRefusal, withLogicalReplyDispatch, runLogicalDispatchAttempt, NativeDispatchBusyError } from "../../state/thread-dispatch.js";
import { readChannelSourceTurnId, setChannelSourceTurnId } from "./source-turn-id.js";
import { createDispatcher, emptyConfig, hookMocks, mocks, internalHookMocks, runtimePluginMocks, threadInfoMocks, parseGenericThreadSessionInfo } from "./dispatch-from-config.shared.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
beforeAll(async()=>{ ({dispatchReplyFromConfig}=await import("./dispatch-from-config.js")); });
beforeEach(()=>{
 vi.clearAllMocks(); threadInfoMocks.parseSessionThreadInfo.mockImplementation(parseGenericThreadSessionInfo); resetInboundDedupe(); replyRunTesting.resetReplyRunRegistry();
 mocks.tryFastAbortFromMessage.mockResolvedValue({handled:false,aborted:false});
 hookMocks.runner.hasHooks.mockReturnValue(false);
 hookMocks.runner.runMessageReceived.mockResolvedValue(undefined);
 hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
 hookMocks.runner.runReplyDispatch.mockResolvedValue(undefined);
 internalHookMocks.triggerInternalHook.mockResolvedValue(undefined);
 mocks.routeReply.mockResolvedValue({ok:true,messageId:"fixture"});
});
const createHookCtx=(extra:object)=>buildTestCtx({Body:"hello",RawBody:"hello",BodyForAgent:"hello",BodyForCommands:"hello",From:"user1",ChatType:"private",...extra});
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
const fenceSql =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";

function fixture(busy = false) {
 const dir=mkdtempSync(join(tmpdir(),"higher-owner-"));dirs.push(dir);
 const databasePath=join(dir,"claims.sqlite");const db=new (requireNodeSqlite().DatabaseSync)(databasePath);db.exec(fenceSql);chmodSync(databasePath,0o600);
 const scope="slack/C123/1788816064.061969"; db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
 const config={databasePath,scopes:{[scope]:1},sessionScopes:{main:scope}};
 const configPath=join(dir,"config.json");writeFileSync(configPath,JSON.stringify(config),{mode:0o600});vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG",configPath);
 if(busy)admitThreadDispatch(config,{claimId:"incumbent",scopeKey:scope,epoch:1,kind:"native",fingerprint:dispatchHash("incumbent")});
 const ctx=createHookCtx({SessionKey:"main",Provider:"slack",Surface:"slack",To:"C123",MessageSid:"100.000001"});setChannelSourceTurnId(ctx,`channel-user:v1:${"a".repeat(64)}`);
 return {db,ctx,config,scope};
}
it("higher BUSY has private preadmission proof and runs zero initialization/hooks/adoption/provider", async()=>{
 const {db,ctx,scope}=fixture(true);const replyResolver=vi.fn();const adopted=vi.fn();
 hookMocks.runner.hasHooks.mockReturnValue(true);
 try {
  const error=await dispatchReplyFromConfig({ctx,cfg:emptyConfig,dispatcher:createDispatcher(),replyResolver,replyOptions:{onTurnAdopted:adopted}}).catch(e=>e);
  expect(error).toBeInstanceOf(NativeDispatchBusyError);
  expect(readNativePreAdmissionRefusal(error)).toMatchObject({sourceTurnId:readChannelSourceTurnId(ctx),sessionKey:"main",scopeKey:scope,epoch:1});
  expect(readNativePreAdmissionRefusal(new NativeDispatchBusyError())).toBeUndefined();
  expect(runtimePluginMocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();
  expect(hookMocks.runner.runMessageReceived).not.toHaveBeenCalled();expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  expect(hookMocks.runner.runBeforeDispatch).not.toHaveBeenCalled();expect(hookMocks.runner.runReplyDispatch).not.toHaveBeenCalled();expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
  expect(adopted).not.toHaveBeenCalled();expect(replyResolver).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(1);
 } finally {db.close();}
});
it("handled control abort stays available while BUSY without scientific hooks or another native claim",async()=>{
 const {db,ctx}=fixture(true);mocks.tryFastAbortFromMessage.mockResolvedValue({handled:true,aborted:true,stoppedSubagents:0});const resolver=vi.fn();
 try {
  await dispatchReplyFromConfig({ctx,cfg:emptyConfig,dispatcher:createDispatcher(),replyResolver:resolver});
  expect(mocks.tryFastAbortFromMessage).toHaveBeenCalledTimes(1);expect(resolver).not.toHaveBeenCalled();
  expect(runtimePluginMocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();expect(hookMocks.runner.runMessageReceived).not.toHaveBeenCalled();expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(1);
 } finally {db.close();}
});
it.each([false,true])("higher owner waits for actual received-hook settlement (reject=%s)",async(rejectHook)=>{
 const {db,ctx}=fixture();let release!:()=>void;let entered!:()=>void;const reached=new Promise<void>(r=>entered=r);
 hookMocks.runner.hasHooks.mockImplementation((name)=>name==="message_received");
 hookMocks.runner.runMessageReceived.mockImplementation(()=>new Promise<void>((resolve,reject)=>{release=()=>rejectHook?reject(new Error("private hook payload")):resolve();}));
 const replyResolver=vi.fn(async()=>withLogicalReplyDispatch({sessionKey:"main",sourceTurnId:readChannelSourceTurnId(ctx),prompt:"transformed prompt",run:async(complete)=>{
  const { runWithModelFallback } = await import("../../agents/model-fallback.js");
  const { FailoverError } = await import("../../agents/failover-error.js");
  const { makeModelFallbackCfg } = await import("../../agents/test-helpers/model-fallback-config-fixture.js");
  let attempts=0;
  await runWithModelFallback({cfg:makeModelFallbackCfg(),provider:"openai",model:"gpt-4.1-mini",run:()=>runLogicalDispatchAttempt({sessionKey:"main",run:async()=>{
    attempts++;expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims WHERE kind='native'").get()?.n).toBe(1);
    if(attempts===1)throw new FailoverError("fixture rate limited before provider effect",{reason:"rate_limit",provider:"openai",model:"gpt-4.1-mini"});
    return "fixture final";
  },refused:()=>"refused"})!});
  expect(attempts).toBe(2);
  complete(dispatchHash("actual nested final observer"));entered();return {text:"final"};
 }}));
 let settled=false;const running=dispatchReplyFromConfig({ctx,cfg:emptyConfig,dispatcher:createDispatcher(),replyResolver}).then(v=>{settled=true;return v;},e=>{settled=true;throw e;});
 try {
  await Promise.race([reached, running.then(()=>{throw new Error("reply-returned-before-fixture");})]);await new Promise(r=>setTimeout(r,20));expect(settled).toBe(false);expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe("STARTING");
  release();if(rejectHook)await expect(running).rejects.toThrow("THREAD_DISPATCH_HOOK_FAILED");else await running;
  expect(db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state).toBe(rejectHook?"UNKNOWN":"TERMINAL");expect(replyResolver).toHaveBeenCalledTimes(1);
 } finally {db.close();}
});

it("configured cross-session command target refuses before plugin initialization",async()=>{
 const {db,ctx}=fixture();ctx.CommandTargetSessionKey="other-session";const replyResolver=vi.fn();
 try {
  await expect(dispatchReplyFromConfig({ctx,cfg:emptyConfig,dispatcher:createDispatcher(),replyResolver})).rejects.toThrow("THREAD_DISPATCH_TARGET_REFUSED");
  expect(runtimePluginMocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();expect(hookMocks.runner.runMessageReceived).not.toHaveBeenCalled();expect(replyResolver).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(0);
 }finally{db.close();}
});

it("private unhandled probe latches despite swallowed sentinel and runs no science", async () => {
 const {db,ctx}=fixture(true); const resolver=vi.fn();
 try {
  const result=await withNativeControlProbe(async()=>{ await dispatchReplyFromConfig({ctx,cfg:emptyConfig,dispatcher:createDispatcher(),replyResolver:resolver}).catch(()=>undefined); });
  expect(result).toMatchObject({disposition:"NOT_HANDLED",responseCompleted:false,receipt:{sessionKey:"main",sourceTurnId:readChannelSourceTurnId(ctx)}});
  expect(runtimePluginMocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();expect(resolver).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(1);
 }finally{db.close();}
});
it("handled control stays handled after delivery throws, even when Bolt swallows error",async()=>{
 const {db,ctx}=fixture(true); mocks.tryFastAbortFromMessage.mockResolvedValue({handled:true,aborted:true,stoppedSubagents:0});
 try {
  const dispatcher=createDispatcher(); vi.mocked(dispatcher.sendFinalReply).mockImplementation(()=>{throw new Error("private delivery failure");});
  const result=await withNativeControlProbe(async()=>{ await dispatchReplyFromConfig({ctx,cfg:emptyConfig,dispatcher}).catch(()=>undefined); });
  expect(result).toMatchObject({disposition:"HANDLED",responseCompleted:false});expect(runtimePluginMocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();
 }finally{db.close();}
});
it("closed probe rejects late inherited core before abort or scientific effects",async()=>{
 const {db,ctx}=fixture();let release!:()=>void;let late!:Promise<unknown>;
 try {
  const result=await withNativeControlProbe(async()=>{
   late=(async()=>{await new Promise<void>(r=>release=r);return dispatchReplyFromConfig({ctx,cfg:emptyConfig,dispatcher:createDispatcher()});})();
  });
  expect(result.disposition).toBe("UNVERIFIED");release();await expect(late).rejects.toThrow("THREAD_CONTROL_PROBE_CLOSED");
  expect(mocks.tryFastAbortFromMessage).not.toHaveBeenCalled();expect(runtimePluginMocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();
 }finally{db.close();}
});
it("unconfigured control probe never takes default-off scientific fallback",async()=>{
 const {db,ctx}=fixture();vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG","");
 try {
  const result=await withNativeControlProbe(()=>dispatchReplyFromConfig({ctx,cfg:emptyConfig,dispatcher:createDispatcher()}));
  expect(result.disposition).toBe("UNVERIFIED");expect(mocks.tryFastAbortFromMessage).not.toHaveBeenCalled();expect(runtimePluginMocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();
 }finally{db.close();}
});
