// E2E tests for run-reply-agent execution and generated session artifacts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../../../src/config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import type { TypingMode } from "../../../../src/config/types.js";
import {
  HEARTBEAT_RUN_SCOPE,
  type ReplyOptionsWithHeartbeatRunScope,
} from "../../../../src/infra/heartbeat-run-scope.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../../../src/plugins/before-agent-reply.js";
import { createUserTurnTranscriptRecorder } from "../../../../src/sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../../../src/sessions/user-turn-transcript.test-support.js";
import type { TemplateContext } from "../../../../src/auto-reply/templating.js";
import type { GetReplyOptions } from "../../../../src/auto-reply/types.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../../../../src/auto-reply/reply/agent-runner-failure-copy.js";
import {
  enqueueFollowupRun,
  refreshQueuedFollowupSession,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "../../../../src/auto-reply/reply/queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "../../../../src/auto-reply/reply/reply-operation-run-state.js";
import { createReplyOperation, type ReplyOperation } from "../../../../src/auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../../../src/auto-reply/reply/reply-run-registry.test-support.js";
import { consumeReplyUsageState } from "../../../../src/auto-reply/reply/reply-usage-state.js";
import { buildChannelSourceTurnId, setChannelSourceTurnId } from "../../../../src/auto-reply/reply/source-turn-id.js";
import { createMockTypingController } from "../../../../src/auto-reply/reply/test-helpers.js";

type ReplyOptionsWithOperationRunState = {
  [REPLY_OPERATION_RUN_STATE]?: ReplyOperationRunState;
};

type AgentRunParams = {
  sessionId?: string;
  sessionFile?: string;
  onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
  onAssistantMessageStart?: () => Promise<void> | void;
  onReasoningStream?: (payload: { text?: string }) => Promise<void> | void;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    isReasoning?: boolean;
    isCommentary?: boolean;
  }) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  silentExpected?: boolean;
  trigger?: string;
  bootstrapContextRunKind?: string;
};

const state = vi.hoisted(() => ({
  beforeAgentReplyHasHooksMock: vi.fn(),
  beforeAgentReplyRunMock: vi.fn(),
  compactEmbeddedAgentSessionMock: vi.fn(),
  getChannelPluginMock: vi.fn(),
  queueEmbeddedAgentMessageMock: vi.fn(),
  runEmbeddedAgentMock: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function mockCallArgs(mock: ReturnType<typeof vi.fn>, label: string, callIndex = 0): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} mock call ${callIndex}`);
  }
  return call;
}

function requireStoredSessionEntry(storePath: string, sessionKey = "main"): SessionEntry {
  const entry = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
  if (!entry) {
    throw new Error(`expected stored session entry for ${sessionKey}`);
  }
  return entry;
}

async function createSessionStoreFile(entry: SessionEntry): Promise<string> {
  const dir = tempDirs.make("openclaw-agent-runner-");
  const storePath = join(dir, "sessions.json");
  await replaceSessionEntry({ storePath, sessionKey: "main" }, entry);
  return storePath;
}

async function readStoredMainSession(storePath: string): Promise<SessionEntry> {
  return requireStoredSessionEntry(storePath);
}

let modelFallbackModule: typeof import("../../../../src/agents/model-fallback.js");
let onAgentEvent: typeof import("../../../../src/infra/agent-events.js").onAgentEvent;

let runReplyAgentPromise:
  | Promise<(typeof import("../../../../src/auto-reply/reply/agent-runner.js"))["runReplyAgent"]>
  | undefined;

async function getRunReplyAgent() {
  if (!runReplyAgentPromise) {
    runReplyAgentPromise = import("../../../../src/auto-reply/reply/agent-runner.js").then((m) => m.runReplyAgent);
  }
  return await runReplyAgentPromise;
}

vi.mock("../../../../src/agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    outcome: "completed" as const,
    result: await run(provider, model),
    provider,
    model,
    attempts: [],
  }),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../../../src/plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: () => ({
    hasHooks: state.beforeAgentReplyHasHooksMock,
    runBeforeAgentReply: state.beforeAgentReplyRunMock,
  }),
}));

vi.mock("../../../../src/agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: (params: unknown) => state.compactEmbeddedAgentSessionMock(params),
  runEmbeddedAgent: (params: unknown) => state.runEmbeddedAgentMock(params),
}));

vi.mock("../../../../src/channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/channels/plugins/index.js")>()),
  getChannelPlugin: (channel: unknown) => state.getChannelPluginMock(channel),
}));

vi.mock("../../../../src/agents/embedded-agent-runner/runs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/agents/embedded-agent-runner/runs.js")>()),
  formatEmbeddedAgentQueueFailureSummary: () => "test queue rejection",
  queueEmbeddedAgentMessageWithOutcomeAsync: async (
    sessionId: string,
    prompt: string,
    options: unknown,
  ) => {
    const result = state.queueEmbeddedAgentMessageMock(sessionId, prompt, options);
    if (typeof result === "object") {
      return result;
    }
    return result
      ? {
          queued: true,
          sessionId,
          target: "embedded_run",
          gatewayHealth: "live",
          enqueuedAtMs: Date.now(),
        }
      : {
          queued: false,
          sessionId,
          reason: "no_active_run",
          target: "none",
          gatewayHealth: "live",
        };
  },
}));

vi.mock("../../../../src/auto-reply/reply/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/auto-reply/reply/queue.js")>()),
  enqueueFollowupRun: vi.fn(),
  refreshQueuedFollowupSession: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

beforeAll(async () => {
  // Avoid attributing the initial agent-runner import cost to the first test case.
  modelFallbackModule = await import("../../../../src/agents/model-fallback.js");
  ({ onAgentEvent } = await import("../../../../src/infra/agent-events.js"));
  await getRunReplyAgent();
});

beforeEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  state.compactEmbeddedAgentSessionMock.mockReset();
  state.compactEmbeddedAgentSessionMock.mockResolvedValue({
    ok: true,
    compacted: false,
    reason: "test-default",
  });
  state.runEmbeddedAgentMock.mockReset();
  state.runEmbeddedAgentMock.mockResolvedValue({
    payloads: [{ text: "final" }],
    meta: { agentMeta: { usage: { input: 1, output: 1 } } },
  });
  state.queueEmbeddedAgentMessageMock.mockReset();
  state.beforeAgentReplyHasHooksMock.mockReset().mockReturnValue(false);
  state.beforeAgentReplyRunMock.mockReset();
  state.queueEmbeddedAgentMessageMock.mockReturnValue(false);
  state.getChannelPluginMock.mockReset();
  vi.mocked(enqueueFollowupRun).mockReset().mockReturnValue(true);
  vi.mocked(refreshQueuedFollowupSession).mockReset();
  vi.mocked(scheduleFollowupDrain).mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

function createMinimalRun(params?: {
  opts?: GetReplyOptions & ReplyOptionsWithOperationRunState & ReplyOptionsWithHeartbeatRunScope;
  resolvedVerboseLevel?: "off" | "on";
  sessionStore?: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  typingMode?: TypingMode;
  blockStreamingEnabled?: boolean;
  isActive?: boolean;
  isRunActive?: () => boolean;
  isStreaming?: boolean;
  shouldSteer?: boolean;
  shouldFollowup?: boolean;
  resolvedQueueMode?: string;
  replyOperation?: ReplyOperation;
  currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
  sessionCtx?: Partial<TemplateContext>;
  sourceTurnId?: string;
  runOverrides?: Partial<FollowupRun["run"]>;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
    ...params?.sessionCtx,
  } as unknown as TemplateContext;
  const sourceTurnId =
    params?.sourceTurnId ??
    buildChannelSourceTurnId({
      provider: sessionCtx.Provider,
      accountId: sessionCtx.AccountId,
      conversationId: sessionCtx.OriginatingTo,
      messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    });
  setChannelSourceTurnId(sessionCtx, sourceTurnId);
  const resolvedQueue = {
    mode: params?.resolvedQueueMode ?? "interrupt",
  } as unknown as QueueSettings;
  const sessionKey = params?.sessionKey ?? "main";
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    currentInboundEventKind: params?.currentInboundEventKind,
    originatingChannel: sessionCtx.OriginatingChannel ?? sessionCtx.Provider,
    originatingTo: sessionCtx.OriginatingTo,
    originatingChatId: sessionCtx.NativeChannelId ?? sessionCtx.ChatId,
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: params?.resolvedVerboseLevel ?? "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: process.env.OPENCLAW_TEST_FAST === "1",
      ...params?.runOverrides,
    },
  } as unknown as FollowupRun;

  return {
    followupRun,
    sourceTurnId,
    typing,
    opts,
    run: async () => {
      const runReplyAgent = await getRunReplyAgent();
      return runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: params?.shouldSteer ?? false,
        shouldFollowup: params?.shouldFollowup ?? false,
        isActive: params?.isActive ?? false,
        isRunActive: params?.isRunActive,
        isStreaming: params?.isStreaming ?? false,
        opts,
        typing,
        sessionEntry: params?.sessionEntry,
        sessionStore: params?.sessionStore,
        sessionKey,
        storePath: params?.storePath,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-6",
        resolvedVerboseLevel: params?.resolvedVerboseLevel ?? "off",
        isNewSession: false,
        blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: params?.typingMode ?? "instant",
        replyOperation: params?.replyOperation,
      });
    },
  };
}


import type { ReplyPayload } from "../../../../src/auto-reply/types.js";
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
vi.mock("./message-handler/pipeline.runtime.js",()=>({prepareSlackMessage:slackPipeline.prepare,dispatchPreparedSlackMessage:slackPipeline.dispatch}));
vi.mock("./thread-resolution.js",()=>({createSlackThreadTsResolver:()=>({resolve:async({message}:{message:object})=>message})}));
vi.mock("./inbound-delivery-state.js",()=>({hasSlackInboundMessageDelivery:async()=>false,recordSlackInboundMessageDeliveries:slackPipeline.delivered}));
afterEach(()=>{closeOpenClawAgentDatabasesForTest();closeOpenClawStateDatabaseForTest();vi.unstubAllEnvs();vi.unstubAllGlobals();});

it("actual Bolt listener reaches genuine runReplyAgent admission before queue completion",async()=>{
 const dir=tempDirs.make("bolt-source-adoption-");vi.stubEnv("OPENCLAW_STATE_DIR",dir);
 const network=vi.fn(()=>{throw new Error("NO_NETWORK_IN_FIXTURE");});vi.stubGlobal("fetch",network);
 const agentDb=openOpenClawAgentDatabase({agentId:"main",env:{...process.env,OPENCLAW_STATE_DIR:dir}});
 const sessionKey="agent:main:slack:channel:c123:thread:100.000001";const sessionId="session";const storePath=agentDb.path;
 const entry={sessionId,updatedAt:1,sessionFile:join(dir,"session.jsonl"),lastChannel:"slack",lastTo:"channel:C123",lastAccountId:"fixture"};
 await replaceSessionEntry({storePath,sessionKey},entry);const sessionStore={[sessionKey]:entry};
 const schemaSource=readFileSync(new URL("../../../../src/state/thread-dispatch.test.ts",import.meta.url),"utf8");
 const sql=JSON.parse(schemaSource.match(/const SQL =\s*("(?:[^"\\]|\\.)*");/s)![1]) as string;
 const databasePath=join(dir,"fence.sqlite");const fence=new (requireNodeSqlite().DatabaseSync)(databasePath);fence.exec(sql);chmodSync(databasePath,0o600);
 const scopeKey="slack/C123/100.000001";fence.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scopeKey);
 const configPath=join(dir,"fence.json");writeFileSync(configPath,JSON.stringify({databasePath,scopes:{[scopeKey]:1},sessionScopes:{[sessionKey]:scopeKey}}),{mode:0o600});vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG",configPath);
 const cfg={session:{store:storePath},agents:{defaults:{workspace:dir}},messages:{inbound:{debounceMs:60000}}};
 const ctxPayload={Body:"synthetic research message",RawBody:"synthetic research message",BodyForAgent:"synthetic research message",BodyForCommands:"synthetic research message",From:"slack:user:U123",To:"channel:C123",Provider:"slack",Surface:"slack",AccountId:"fixture",SessionKey:sessionKey,MessageSid:"101.000001",MessageSidFull:"101.000001",ChatType:"group",OriginatingChannel:"slack",OriginatingTo:"channel:C123",SenderId:"U123"};
 const receiver={init:vi.fn(),start:vi.fn(async()=>{}),stop:vi.fn(async()=>{})};
 const logger={debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn(),getLevel:()=>"ERROR",setLevel:vi.fn()};
 const app=new App({receiver:receiver as never,authorize:async()=>({teamId:"T123",botId:"B123",botUserId:"U999",botToken:"xoxb-synthetic-not-a-credential"}),logger:logger as never,ignoreSelf:true});
 app.error(async(error)=>{ process.stderr.write(JSON.stringify({phase:"BOLT_ERROR",name:error.name,code:(error as {code?:string}).code,frames:error.stack?.split("\n").slice(1,5)})+"\n"); });
 const context={cfg,accountId:"fixture",teamId:"T123",botUserId:"U999",botId:"B123",app,installationIdentity:{kind:"workspace",teamId:"T123",apiAppId:"A123"},runtime:{error:vi.fn()},markMessageSeen:()=>false,releaseSeenMessage:vi.fn(),rememberSlackChannelType:()=>{},shouldDropMismatchedSlackEvent:()=>false,channelHistories:new Map()};
 const handler=createSlackMessageHandler({ctx:context as never,account:{accountId:"fixture",config:{}} as never});registerSlackMessageEvents({ctx:context as never,handleSlackMessage:handler});
 slackPipeline.prepare.mockResolvedValue({ctxPayload,turn:{storePath},route:{sessionKey}});
 const queue=createChannelIngressQueue<SlackIngressPayload,SlackIngressMetadata,SlackIngressMetadata>({channelId:"slack",accountId:"fixture",stateDir:dir});
 const journal=createSlackDurableIngress({scope:{accountId:"fixture",teamId:"T123",appId:"A123",channelId:"C123",threadTs:"100.000001"},queue,delegate:async()=>{throw new Error("NO_DELEGATE");}});
 const body={type:"event_callback",team_id:"T123",api_app_id:"A123",event_id:"Ev123",event:{type:"message",channel:"C123",channel_type:"channel",user:"U123",ts:"101.000001",thread_ts:"100.000001",text:"synthetic research message"}};
 let realAck=0;await journal.receive({body,ack:async()=>{realAck++;expect(await queue.listPending()).toHaveLength(1);}});expect(realAck).toBe(1);
 const claim=(await journal.claimOne("bolt-fixture"))!;
 const {dispatchReplyFromConfig}=await import("../../../../src/auto-reply/reply/dispatch-from-config.js");
 const sourceCallbacks:unknown[]=[];const dispatcher=createReplyDispatcher({deliver:async()=>{}});
 slackPipeline.dispatch.mockImplementation(async()=>{process.stderr.write("PHASE_CORE_START\n");return dispatchReplyFromConfig({ctx:ctxPayload,cfg,dispatcher,fastAbortResolver:async()=>({handled:false,aborted:false}),formatAbortReplyTextResolver:()=>"synthetic abort reply",replyResolver:async(resolverCtx,resolverOpts)=>{
   process.stderr.write("PHASE_REPLY_RESOLVER\n");
   const source=readChannelSourceTurnId(ctxPayload);expect(source).toMatch(/^channel-user:v1:[a-f0-9]{64}$/);
   const adoption=getSlackIngressAdoptionCallback(ctxPayload)!;
   const run=createMinimalRun({replyOperation:resolverOpts?.replyOperation,storePath,sessionKey,sessionEntry:entry,sessionStore,sourceTurnId:source,sessionCtx:resolverCtx,opts:{...resolverOpts,onTurnAdopted:async target=>{sourceCallbacks.push(target);process.stderr.write("PHASE_GENUINE_ADOPTION\n");await adoption(target);}},runOverrides:{sessionFile:entry.sessionFile,workspaceDir:dir,config:cfg,messageProvider:"slack"}});
   run.followupRun.userTurnTranscriptRecorder=createUserTurnTranscriptRecorder({input:{text:"synthetic research message",idempotencyKey:source},target:{agentId:"main",config:cfg,cwd:dir,sessionEntry:entry,sessionId,sessionKey,sessionStore,storePath}});
   process.stderr.write("PHASE_REAL_RUN_START\n");return run.run().finally(()=>process.stderr.write("PHASE_REAL_RUN_END\n"));
 }}).catch(error=>{process.stderr.write(JSON.stringify({phase:"CORE_ERROR",name:error.name,frames:error.stack?.split("\n").slice(1,7)})+"\n");throw error;});});
 state.runEmbeddedAgentMock.mockImplementation(async()=>{expect(sourceCallbacks).toHaveLength(1);expect(await queue.listClaims()).toHaveLength(0);return {payloads:[{text:"synthetic provider fixture result"}],meta:{stopReason:"stop",durationMs:1,agentMeta:{usage:{input:1,output:1}}}};});
 try {
  const result=await dispatchSlackIngressClaim({claim,queue,dispatch:envelope=>app.processEvent(envelope as never)});
  process.stderr.write(JSON.stringify({phase:"RESULT",result,prepared:slackPipeline.prepare.mock.calls.length,dispatched:slackPipeline.dispatch.mock.calls.length,adopted:sourceCallbacks.length,provider:state.runEmbeddedAgentMock.mock.calls.length})+"\n");
  expect(result).toMatchObject({status:"ADOPTED"});expect(sourceCallbacks).toHaveLength(1);expect(sourceCallbacks[0]).toMatchObject({sessionId,sessionKey,storePath,sourceTurnId:readChannelSourceTurnId(ctxPayload)});
  expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();expect(await queue.listClaims()).toHaveLength(0);expect(network).not.toHaveBeenCalled();
 } finally {fence.close();}
},60000);
