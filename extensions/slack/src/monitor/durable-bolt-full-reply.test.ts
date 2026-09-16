import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../../../src/config/sessions/session-accessor.js";
import { resetInboundDedupe } from "../../../../src/auto-reply/reply/inbound-dedupe.js";
import { testing as replyRunTesting } from "../../../../src/auto-reply/reply/reply-run-registry.test-support.js";
process.stderr.write("FULL_STATIC_IMPORTS_COMPLETE\n");
const tempDirs=useAutoCleanupTempDirTracker(afterEach);
vi.hoisted(()=>process.stderr.write("FULL_IMPORT_HOISTED\n"));
const state=vi.hoisted(()=>({runEmbeddedAgentMock:vi.fn(),compactEmbeddedAgentSessionMock:vi.fn()}));
vi.mock("../../../../src/agents/embedded-agent.js",async()=>({...await import("../../../../src/agents/embedded-agent-runner/runs.js"),...await import("../../../../src/agents/embedded-agent-runner/lanes.js"),runEmbeddedAgent:(params:unknown)=>state.runEmbeddedAgentMock(params),compactEmbeddedAgentSession:(params:unknown)=>state.compactEmbeddedAgentSessionMock(params)}));
beforeEach(()=>{replyRunTesting.resetReplyRunRegistry();state.runEmbeddedAgentMock.mockReset();state.compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({ok:true,compacted:false,reason:"test-default"});vi.stubEnv("OPENCLAW_TEST_FAST","1");});
import { App } from "@slack/bolt";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createChannelIngressQueue } from "../../../../src/channels/message/ingress-queue.js";
import { requireNodeSqlite } from "../../../../src/infra/node-sqlite.js";
import { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { readChannelSourceTurnId } from "../../../../src/auto-reply/reply/source-turn-id.js";
import { createReplyDispatcher } from "../../../../src/auto-reply/reply/reply-dispatcher.js";
import { dispatchSlackIngressClaim, getSlackIngressAdoptionCallback } from "./durable-adoption.js";
import { createSlackDurableIngress, type SlackIngressPayload, type SlackIngressMetadata } from "./durable-ingress.js";
import { createSlackMessageHandler } from "./message-handler.js";
import { registerSlackMessageEvents } from "./events/messages.js";
const slackPipeline = vi.hoisted(()=>({prepare:vi.fn(),dispatch:vi.fn(),delivered:vi.fn(async()=>{})}));
const nativeResolver=vi.hoisted(()=>({adopted:vi.fn()}));
vi.mock("./reply.runtime.js", async()=>{const actual=await import("../../../../src/auto-reply/reply/provider-dispatcher.js");return {dispatchReplyWithBufferedBlockDispatcher:(params:Parameters<typeof actual.dispatchReplyWithBufferedBlockDispatcher>[0])=>(process.stderr.write("FULL_PROVIDER_DISPATCH_START\n"),actual.dispatchReplyWithBufferedBlockDispatcher({...params,replyOptions:{...params.replyOptions,onTurnAdopted:async(target)=>{if(typeof params.replyOptions?.onTurnAdopted!=="function")throw new Error("MISSING_ORIGINAL_ADOPTION");await params.replyOptions.onTurnAdopted(target);nativeResolver.adopted(target);}}}))};});
vi.mock("./replies.js",async(importOriginal)=>({...await importOriginal<typeof import("./replies.js")>(),deliverReplies:vi.fn(async()=>({messageId:"102.000001",channelId:"C123"}))}));
vi.mock("./message-handler/pipeline.runtime.js",()=>({prepareSlackMessage:slackPipeline.prepare,dispatchPreparedSlackMessage:slackPipeline.dispatch}));
vi.mock("./thread-resolution.js",()=>({createSlackThreadTsResolver:()=>({resolve:async({message}:{message:object})=>message})}));
vi.mock("./inbound-delivery-state.js",()=>({hasSlackInboundMessageDelivery:async()=>false,recordSlackInboundMessageDeliveries:slackPipeline.delivered}));
afterEach(()=>{closeOpenClawAgentDatabasesForTest();closeOpenClawStateDatabaseForTest();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});

process.stderr.write("FULL_MODULE_COMPLETE\n");
it.each(["message","app_mention"] as const)("actual getReplyFromConfig reaches genuine adoption through Bolt %s",async(eventType)=>{
 process.stderr.write("FULL_TEST_START\n");
 resetInboundDedupe();
 const slackApi=vi.spyOn(WebClient.prototype,"apiCall").mockRejectedValue(new Error("NO_SLACK_API_IN_FIXTURE"));
 const dir=tempDirs.make("bolt-source-adoption-");vi.stubEnv("OPENCLAW_STATE_DIR",dir);
 const network=vi.fn(()=>{throw new Error("NO_NETWORK_IN_FIXTURE");});vi.stubGlobal("fetch",network);
 const agentDb=openOpenClawAgentDatabase({agentId:"main",env:{...process.env,OPENCLAW_STATE_DIR:dir}});
 const sessionKey="agent:main:slack:channel:c123:thread:100.000001";const sessionId="session";const storePath=agentDb.path;
 const entry={sessionId,thinkingLevel:"off",reasoningLevel:"off",updatedAt:Date.now(),sessionFile:join(dir,"session.jsonl"),lastChannel:"slack",lastTo:"channel:C123",lastAccountId:"fixture"};
 await replaceSessionEntry({storePath,sessionKey},entry);const sessionStore={[sessionKey]:entry};
 const schemaSource=readFileSync(new URL("../../../../src/state/thread-dispatch.test.ts",import.meta.url),"utf8");
 const sql=JSON.parse(schemaSource.match(/const SQL =\s*("(?:[^"\\]|\\.)*");/s)![1]) as string;
 const databasePath=join(dir,"fence.sqlite");const fence=new (requireNodeSqlite().DatabaseSync)(databasePath);fence.exec(sql);chmodSync(databasePath,0o600);
 const scopeKey="slack/C123/100.000001";fence.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scopeKey);
 const configPath=join(dir,"fence.json");writeFileSync(configPath,JSON.stringify({databasePath,scopes:{[scopeKey]:1},sessionScopes:{[sessionKey]:scopeKey}}),{mode:0o600});vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG",configPath);
 const cfg={channels:{slack:{streaming:"off"}},session:{store:storePath},agents:{defaults:{workspace:dir}},messages:{inbound:{debounceMs:60000}}};
 const ctxPayload={Body:"synthetic research message <@U999>",RawBody:"synthetic research message <@U999>",BodyForAgent:"synthetic research message <@U999>",BodyForCommands:"synthetic research message <@U999>",From:"slack:user:U123",To:"channel:C123",Provider:"slack",Surface:"slack",AccountId:"fixture",SessionKey:sessionKey,MessageSid:"101.000001",MessageSidFull:"101.000001",ChatType:"group",OriginatingChannel:"slack",OriginatingTo:"channel:C123",SenderId:"U123"};
 const receiver={init:vi.fn(),start:vi.fn(async()=>{}),stop:vi.fn(async()=>{})};
 const logger={debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn(),getLevel:()=>"ERROR",setLevel:vi.fn()};
 const app=new App({receiver:receiver as never,authorize:async()=>({teamId:"T123",botId:"B123",botUserId:"U999",botToken:"xoxb-synthetic-not-a-credential"}),logger:logger as never,ignoreSelf:true});
 app.error(async(error)=>{ process.stderr.write(JSON.stringify({phase:"BOLT_ERROR",name:error.name,code:(error as {code?:string}).code,frames:error.stack?.split("\n").slice(1,5)})+"\n"); });
 const context={cfg,accountId:"fixture",teamId:"T123",botUserId:"U999",botId:"B123",app,installationIdentity:{kind:"workspace",teamId:"T123",apiAppId:"A123"},runtime:{error:vi.fn()},markMessageSeen:()=>false,releaseSeenMessage:vi.fn(),rememberSlackChannelType:()=>{},shouldDropMismatchedSlackEvent:()=>false,channelHistories:new Map(),botToken:"xoxb-synthetic-fixture",textLimit:4000,typingReaction:"",removeAckAfterReply:false,historyLimit:0,allowFrom:[],setSlackThreadStatus:async()=>{}};
 const handler=createSlackMessageHandler({ctx:context as never,account:{accountId:"fixture",config:{}} as never});registerSlackMessageEvents({ctx:context as never,handleSlackMessage:handler});

 const queue=createChannelIngressQueue<SlackIngressPayload,SlackIngressMetadata,SlackIngressMetadata>({channelId:"slack",accountId:"fixture",stateDir:dir});
 const journal=createSlackDurableIngress({scope:{accountId:"fixture",teamId:"T123",appId:"A123",channelId:"C123",threadTs:"100.000001"},queue,delegate:async()=>{throw new Error("NO_DELEGATE");}});
 const body={type:"event_callback",team_id:"T123",api_app_id:"A123",event_id:"Ev123",event:{type:eventType,channel:"C123",channel_type:"channel",user:"U123",ts:"101.000001",thread_ts:"100.000001",event_ts:"101.000001",client_msg_id:"12345678-1234-4123-8123-123456789abc",parent_user_id:"U789",blocks:[{type:"rich_text",block_id:"fixture",elements:[{type:"rich_text_section",elements:[{type:"text",text:"synthetic research message "},{type:"user",user_id:"U999"}]}]}],text:"synthetic research message <@U999>"}};
 const prepared={ctx:context,account:{accountId:"fixture",config:{streaming:"off"}},message:body.event,route:{agentId:"main",accountId:"fixture",sessionKey,mainSessionKey:"agent:main:main",lastRoutePolicy:"session"},channelConfig:null,replyTarget:"channel:C123",ctxPayload,turn:{storePath,record:{}},replyToMode:"all",isDirectMessage:false,isRoomish:false,requireMention:false,historyKey:"fixture",preview:"",ackReactionValue:"",ackReactionPromise:null};
 slackPipeline.prepare.mockResolvedValue(prepared);
 process.stderr.write("FULL_BEFORE_PREPARED_IMPORT\n");
 const {dispatchPreparedSlackMessage}=await import("./message-handler/dispatch.js");slackPipeline.dispatch.mockImplementation(dispatchPreparedSlackMessage);
 process.stderr.write("FULL_PREPARED_IMPORTED\n");
 let realAck=0;await journal.receive({body,ack:async()=>{realAck++;expect(await queue.listPending()).toHaveLength(1);}});expect(realAck).toBe(1);
 process.stderr.write("FULL_JOURNALED\n");
 const claim=(await journal.claimOne("bolt-fixture"))!;
 expect(claim.payload.body.event).toMatchObject({client_msg_id:body.event.client_msg_id,parent_user_id:body.event.parent_user_id,blocks:body.event.blocks,text:body.event.text});
 process.stderr.write("FULL_CLAIMED\n");
 const {dispatchReplyFromConfig}=await import("../../../../src/auto-reply/reply/dispatch-from-config.js");
 process.stderr.write("FULL_CORE_IMPORTED\n");
 const sourceCallbacks:unknown[]=[];const dispatcher=createReplyDispatcher({deliver:async()=>{}});
 nativeResolver.adopted.mockReset().mockImplementation(target=>sourceCallbacks.push(target));
 state.runEmbeddedAgentMock.mockImplementation(async()=>{expect(sourceCallbacks).toHaveLength(1);expect(await queue.listClaims()).toHaveLength(0);return {payloads:[{text:"synthetic provider fixture result"}],meta:{stopReason:"stop",durationMs:1,agentMeta:{usage:{input:1,output:1}}}};});
 try {
  process.stderr.write("FULL_BRIDGE_START\n");
  const result=await dispatchSlackIngressClaim({claim,queue,dispatch:envelope=>app.processEvent(envelope as never)});
  process.stderr.write(JSON.stringify({phase:"RESULT",result,prepared:slackPipeline.prepare.mock.calls.length,dispatched:slackPipeline.dispatch.mock.calls.length,adopted:sourceCallbacks.length,provider:state.runEmbeddedAgentMock.mock.calls.length})+"\n");
  expect(result).toMatchObject({status:"ADOPTED"});expect(sourceCallbacks).toHaveLength(1);expect(sourceCallbacks[0]).toMatchObject({sessionId,sessionKey,storePath,sourceTurnId:readChannelSourceTurnId(ctxPayload)});
  expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();expect(await queue.listClaims()).toHaveLength(0);expect(network).not.toHaveBeenCalled();expect(slackApi).not.toHaveBeenCalled();expect(receiver.start).not.toHaveBeenCalled();
 } finally {fence.close();}
},150000);

vi.mock("../../../../src/auto-reply/reply/dispatch-from-config.runtime-loaders.js",async(importOriginal)=>{const actual=await importOriginal<typeof import("../../../../src/auto-reply/reply/dispatch-from-config.runtime-loaders.js")>();return {...actual,loadGetReplyFromConfigRuntime:async()=>{process.stderr.write("FULL_DEFAULT_LOAD_START\n");const result=await actual.loadGetReplyFromConfigRuntime();process.stderr.write("FULL_DEFAULT_LOAD_DONE\n");return result;}};});

vi.mock("../../../../src/infra/diagnostics-timeline.js",async(importOriginal)=>{const actual=await importOriginal<typeof import("../../../../src/infra/diagnostics-timeline.js")>();let count=0;return {...actual,measureDiagnosticsTimelineSpan:async(name,run,options)=>{const logged=count++<80;if(logged)process.stderr.write(`PHASE_START ${name}\n`);try{return await actual.measureDiagnosticsTimelineSpan(name,run,options);}finally{if(logged)process.stderr.write(`PHASE_END ${name}\n`);}}};});

vi.mock('../../../../src/auto-reply/reply/groups.js',async(importOriginal)=>{const actual=await importOriginal<typeof import('../../../../src/auto-reply/reply/groups.js')>();return {...actual,resolveGroupRequireMention:async(...args)=>{process.stderr.write("CALL_START resolveGroupRequireMention\n");try{return await actual.resolveGroupRequireMention(...args);}finally{process.stderr.write("CALL_END resolveGroupRequireMention\n");}}};});

vi.mock('../../../../src/auto-reply/reply/model-selection.js',async(importOriginal)=>{const actual=await importOriginal<typeof import('../../../../src/auto-reply/reply/model-selection.js')>();return {...actual,createModelSelectionState:async(...args)=>{process.stderr.write("CALL_START createModelSelectionState\n");try{return await actual.createModelSelectionState(...args);}finally{process.stderr.write("CALL_END createModelSelectionState\n");}}};});

vi.mock('../../../../src/auto-reply/reply/get-reply-directives-apply.js',async(importOriginal)=>{const actual=await importOriginal<typeof import('../../../../src/auto-reply/reply/get-reply-directives-apply.js')>();return {...actual,applyInlineDirectiveOverrides:async(...args)=>{process.stderr.write("CALL_START applyInlineDirectiveOverrides\n");try{return await actual.applyInlineDirectiveOverrides(...args);}finally{process.stderr.write("CALL_END applyInlineDirectiveOverrides\n");}}};});
