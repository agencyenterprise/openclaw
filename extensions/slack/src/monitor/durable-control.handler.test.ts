import { resetInboundDedupe } from "../../../../src/auto-reply/reply/inbound-dedupe.js";
import { testing as replyRunTesting } from "../../../../src/auto-reply/reply/reply-run-registry.test-support.js";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createChannelIngressQueue } from "../../../../src/channels/message/ingress-queue.js";
import { requireNodeSqlite } from "../../../../src/infra/node-sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { buildChannelSourceTurnId, setChannelSourceTurnId } from "../../../../src/auto-reply/reply/source-turn-id.js";
import { createSlackDurableIngress, type SlackIngressPayload, type SlackIngressMetadata } from "./durable-ingress.js";
import { dispatchSlackControlProbe, withSlackIngressOptions } from "./durable-adoption.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(()=>closeOpenClawStateDatabaseForTest());
const source = buildChannelSourceTurnId({provider:"slack", accountId:"fixture",conversationId:"channel:C123",messageId:"101.000001"})!;
async function setup() {
 const stateDir=dirs.make("control-queue-");
 const target={sessionKey:"agent:main:slack:channel:c123:thread:100.000001",storePath:join(stateDir,"unused.sqlite")};
 const queue=createChannelIngressQueue<SlackIngressPayload,SlackIngressMetadata,SlackIngressMetadata>({channelId:"slack",accountId:"fixture",stateDir});
 const journal=createSlackDurableIngress({scope:{accountId:"fixture",teamId:"T123",appId:"A123",channelId:"C123",threadTs:"100.000001"},queue,delegate:async()=>{throw new Error("NO_DELEGATE");}});
 await journal.receive({body:{type:"event_callback",team_id:"T123",api_app_id:"A123",event_id:"Ev123",event:{type:"message",channel:"C123",user:"U123",ts:"101.000001",thread_ts:"100.000001",text:"stop"}},ack:async()=>{}});
 const claim=(await journal.claimOne("fixture-owner"))!;
 return {queue,claim,target};
}
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), dispatch: vi.fn(), delivered: vi.fn(async () => {}) }));
vi.mock("./message-handler/pipeline.runtime.js", () => ({ prepareSlackMessage: mocks.prepare, dispatchPreparedSlackMessage: mocks.dispatch }));
vi.mock("./thread-resolution.js", () => ({ createSlackThreadTsResolver: () => ({ resolve: async ({message}: {message:object}) => message }) }));
vi.mock("./inbound-delivery-state.js", () => ({ hasSlackInboundMessageDelivery: async () => false, recordSlackInboundMessageDeliveries: mocks.delivered }));
const { createSlackMessageHandler } = await import("./message-handler.js");
function handlerFor(f: Awaited<ReturnType<typeof setup>>) {
  const context = {}; const releaseSeen = vi.fn(); const logs: string[] = [];
  const handler = createSlackMessageHandler({
    ctx: { cfg: { messages: { inbound: { debounceMs: 60000 } } }, accountId: "fixture", botUserId: "U999",
      app: { client: {} }, runtime: { error: (line:string) => logs.push(line) },
      markMessageSeen: () => false, releaseSeenMessage: releaseSeen, rememberSlackChannelType: () => {},
      channelHistories: new Map(),
    } as never, account: { accountId: "fixture", config: {} } as never,
  });
  mocks.prepare.mockResolvedValue({ ctxPayload: context, turn: {storePath:f.target.storePath}, route:{ sessionKey:f.target.sessionKey } });
  mocks.delivered.mockClear();
  const dispatch = async ({body}: {body:unknown}) => {
    const event = (body as {event:object}).event;
    await handler(event as never, withSlackIngressOptions(event, {source:"message" as const}));
  };
  return { context, handler, dispatch, releaseSeen, logs };
}
// Actual core dispatcher and actual Slack handler; only the existing abort resolver
// and outbound delivery are synthetic. No private proof is fabricated by this test.
import { createDispatcher, emptyConfig, mocks as coreMocks, runtimePluginMocks, hookMocks } from "../../../../src/auto-reply/reply/dispatch-from-config.shared.test-harness.js";
import { buildTestCtx } from "../../../../src/auto-reply/reply/test-ctx.js";
let dispatchReplyFromConfig: typeof import("../../../../src/auto-reply/reply/dispatch-from-config.js").dispatchReplyFromConfig;
beforeAll(async()=>{({dispatchReplyFromConfig}=await import("../../../../src/auto-reply/reply/dispatch-from-config.js"));});
afterEach(() => vi.unstubAllEnvs());
it.each(["HANDLED", "NOT_HANDLED", "DELIVERY_FAILED"] as const)("control %s crosses actual handler and core without queue settlement or science", async (kind) => {
  vi.clearAllMocks(); resetInboundDedupe(); replyRunTesting.resetReplyRunRegistry();
  const f = await setup(); const h = handlerFor(f);
  const before = await f.queue.listClaims();
  Object.assign(h.context, buildTestCtx({Body:"stop", RawBody:"stop", BodyForAgent:"stop", BodyForCommands:"stop", SessionKey:f.target.sessionKey, Provider:"slack", Surface:"slack", From:"U123", To:"C123", MessageSid:"101.000001", ChatType:"group"}));
  setChannelSourceTurnId(h.context, source);
  const root = dirs.make("control-fence-");
  const schemaSource = readFileSync(new URL("../../../../src/state/thread-dispatch.test.ts", import.meta.url), "utf8");
  const sql = JSON.parse(schemaSource.match(/const SQL =\s*("(?:[^"\\]|\\.)*");/s)![1]) as string;
  const databasePath = join(root,"fence.sqlite"); const db = new (requireNodeSqlite().DatabaseSync)(databasePath); db.exec(sql); chmodSync(databasePath,0o600);
  const scopeKey="slack/C123/100.000001";
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scopeKey);
  db.prepare("INSERT INTO thread_dispatch_claims VALUES ('incumbent',?,1,?,'native','UNKNOWN',0,0,NULL)").run(scopeKey,"c".repeat(64));
  const configPath=join(root,"config.json"); writeFileSync(configPath,JSON.stringify({databasePath,scopes:{[scopeKey]:1},sessionScopes:{[f.target.sessionKey]:scopeKey}}),{mode:0o600});
  vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG",configPath);
  coreMocks.tryFastAbortFromMessage.mockResolvedValue({handled:kind!=="NOT_HANDLED",aborted:kind!=="NOT_HANDLED",stoppedSubagents:0});
  coreMocks.routeReply.mockResolvedValue({ok:true,messageId:"fixture"});
  const dispatcher=createDispatcher(); const resolver=vi.fn();
  const deliveryFailure=()=>{throw new Error("private synthetic delivery failure");};
  if(kind==="DELIVERY_FAILED") { vi.mocked(dispatcher.sendFinalReply).mockImplementation(deliveryFailure); coreMocks.routeReply.mockImplementation(deliveryFailure); }
  mocks.dispatch.mockReset().mockImplementation(async()=>dispatchReplyFromConfig({ctx:h.context as never,cfg:emptyConfig,dispatcher,replyResolver:resolver}));
  try {
    const started=Date.now();
    const result=await dispatchSlackControlProbe(structuredClone(f.claim.payload.body), async envelope => { await h.dispatch(envelope).catch(()=>undefined); });
    expect(Date.now()-started).toBeLessThan(5000);
    expect(result.disposition).toBe(kind==="NOT_HANDLED"?"NOT_HANDLED":"HANDLED");
    if(kind==="DELIVERY_FAILED") expect(coreMocks.routeReply.mock.calls.length + vi.mocked(dispatcher.sendFinalReply).mock.calls.length).toBeGreaterThan(0);
    expect(result.responseCompleted).toBe(kind==="HANDLED");
    if(kind==="DELIVERY_FAILED") expect(coreMocks.routeReply.mock.calls.length + vi.mocked(dispatcher.sendFinalReply).mock.calls.length).toBeGreaterThan(0);
    expect(coreMocks.tryFastAbortFromMessage).toHaveBeenCalledOnce();
    expect(resolver).not.toHaveBeenCalled(); expect(runtimePluginMocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled(); expect(hookMocks.runner.runMessageReceived).not.toHaveBeenCalled();
    expect(mocks.delivered).not.toHaveBeenCalled();
    expect(h.releaseSeen).toHaveBeenCalledTimes(kind==="NOT_HANDLED"?1:0);
    expect(await f.queue.listClaims()).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims").get()?.n).toBe(1);
  } finally {db.close();}
});
it("handler return without actual core control proof remains unverified",async()=>{
 const f=await setup();const h=handlerFor(f);mocks.dispatch.mockReset().mockResolvedValue(undefined);
 const result=await dispatchSlackControlProbe(structuredClone(f.claim.payload.body),h.dispatch);
 expect(result.disposition).toBe("UNVERIFIED");expect(h.releaseSeen).not.toHaveBeenCalled();expect(mocks.delivered).not.toHaveBeenCalled();expect(await f.queue.listClaims()).toHaveLength(1);
});
