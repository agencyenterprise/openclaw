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
 const config={databasePath,scopes:{[scope]:1},sessionScopes:{main:scope},automaticSessions:true};
 const configPath=join(dir,"config.json");writeFileSync(configPath,JSON.stringify(config),{mode:0o600});vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG",configPath);
 if(busy)admitThreadDispatch(config,{claimId:"incumbent",scopeKey:scope,epoch:1,kind:"native",fingerprint:dispatchHash("incumbent")});
 const ctx=createHookCtx({SessionKey:"main",Provider:"slack",Surface:"slack",To:"C123",MessageSid:"100.000001"});setChannelSourceTurnId(ctx,`channel-user:v1:${"a".repeat(64)}`);
 return {db,ctx,config,scope};
}

it("ordinary new Slack thread mints its source without durable ingress and executes under an automatic owner",async()=>{
 const {db,ctx}=fixture();
 ctx.SessionKey="agent:main:slack:channel:c999:thread:1788816999.000001";
 ctx.To="C999";ctx.OriginatingChannel="slack";ctx.OriginatingTo="C999";ctx.MessageSid="1788817000.000002";
 setChannelSourceTurnId(ctx,undefined);
 expect(readChannelSourceTurnId(ctx)).toBeUndefined();
 const resolver=vi.fn(async()=>withLogicalReplyDispatch({sessionKey:ctx.SessionKey,sourceTurnId:readChannelSourceTurnId(ctx),prompt:"host transformed prompt",run:async(complete)=>{
   expect(readChannelSourceTurnId(ctx)).toMatch(/^channel-user:v1:[a-f0-9]{64}$/);
   const {getProcessSupervisor}=await import("../../process/supervisor/index.js");
   const process=await getProcessSupervisor().spawn({mode:"child",argv:["/usr/bin/printf","ordinary-slack-route-ok"],cwd:"/tmp",timeoutMs:5000});
   const result=await process.wait();expect(result.stdout).toBe("ordinary-slack-route-ok");
   complete(dispatchHash("observed synthetic reply completion"));return {text:"fixture reply"};
 }}));
 try {
  await dispatchReplyFromConfig({ctx,cfg:emptyConfig,dispatcher:createDispatcher(),replyResolver:resolver});
  expect(resolver).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT scope_key,state FROM thread_dispatch_claims WHERE kind='native'").get()).toMatchObject({scope_key:"slack/C999/1788816999.000001",state:"TERMINAL"});
  expect(db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='process_child'").get()?.state).toBe("UNKNOWN");
 }finally{db.close();}
});
