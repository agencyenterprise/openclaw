import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createChannelIngressQueue } from "../../../../src/channels/message/ingress-queue.js";
import { persistSessionTranscriptTurn, upsertSessionEntry } from "../../../../src/config/sessions/session-accessor.js";
import { requireNodeSqlite } from "../../../../src/infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesForTest, openOpenClawAgentDatabase } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { NativeDispatchBusyError, withLogicalChannelDispatch, type DispatchConfig } from "../../../../src/state/thread-dispatch.js";
import { buildChannelSourceTurnId, setChannelSourceTurnId } from "../../../../src/auto-reply/reply/source-turn-id.js";
import { createSlackDurableIngress, type SlackIngressPayload, type SlackIngressMetadata } from "./durable-ingress.js";
import { attachSlackPreparedIngress, dispatchSlackIngressClaim, getSlackIngressAdoptionCallback, withSlackIngressOptions } from "./durable-adoption.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => { closeOpenClawAgentDatabasesForTest(); closeOpenClawStateDatabaseForTest(); });
const scope = { accountId: "fixture", teamId: "T123", appId: "A123", channelId: "C123", threadTs: "100.000001" };
const source = buildChannelSourceTurnId({ provider: "slack", accountId: "fixture", conversationId: "channel:C123", messageId: "101.000001" })!;
async function setup() {
  const stateDir = dirs.make("slack-adoption-"); const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const target = { sessionId: "session-fixture", sessionKey: "agent:main:slack:channel:c123:thread:100.000001", storePath: database.path, sourceTurnId: source };
  await upsertSessionEntry({ ...target, agentId: "main", env }, { sessionId: target.sessionId, updatedAt: 1 });
  const queue = createChannelIngressQueue<SlackIngressPayload, SlackIngressMetadata, SlackIngressMetadata>({ channelId: "slack", accountId: "fixture", stateDir });
  const journal = createSlackDurableIngress({ scope, queue, delegate: async () => { throw new Error("UNEXPECTED_DELEGATE"); } });
  await journal.receive({ body: { type: "event_callback", team_id: "T123", api_app_id: "A123", event_id: "Ev123", event: { type: "message", channel: "C123", user: "U123", ts: "101.000001", thread_ts: "100.000001", text: "synthetic" } }, ack: async () => {} });
  const claim = (await journal.claimOne("fixture-owner"))!;
  const prepare = (body: unknown) => {
    const event = (body as { event: object }).event;
    const opts = withSlackIngressOptions(event, { source: "message" });
    expect(opts.awaitDispatch).toBe(true);
    const context = {}; setChannelSourceTurnId(context, source);
    attachSlackPreparedIngress(opts, context, target);
    return { context, adopted: getSlackIngressAdoptionCallback(context)! };
  };
  const persist = () => persistSessionTranscriptTurn({ ...target, agentId: "main", env }, {
    expectedSessionId: target.sessionId,
    sessionLifecyclePatch: { restartRecoveryDeliveryRunId: "run-fixture", restartRecoveryDeliverySourceRunId: source, restartRecoverySourceIngress: "channel", status: "running", updatedAt: 2 },
    messages: [{ eventId: "user-fixture", message: { role: "user", content: "PRIVATE_SYNTHETIC", idempotencyKey: source } }],
  });
  const busy = async () => {
    const schemaSource = readFileSync(new URL("../../../../src/state/thread-dispatch.test.ts", import.meta.url), "utf8");
    const sql = JSON.parse(schemaSource.match(/const SQL =\s*("(?:[^"\\]|\\.)*");/s)![1]) as string;
    const databasePath = join(stateDir, "fence.sqlite"); const db = new (requireNodeSqlite().DatabaseSync)(databasePath); db.exec(sql); chmodSync(databasePath, 0o600);
    const scopeKey = "slack/C123/100.000001";
    db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scopeKey);
    db.prepare("INSERT INTO thread_dispatch_claims VALUES ('incumbent',?,1,?,'native','UNKNOWN',0,0,NULL)").run(scopeKey,"c".repeat(64)); db.close();
    const config: DispatchConfig = { databasePath, scopes: { [scopeKey]: 1 }, sessionScopes: { [target.sessionKey]: scopeKey } };
    await withLogicalChannelDispatch({ config, sessionKey: target.sessionKey, sourceTurnId: source, prompt: "synthetic", run: async () => { throw new Error("UNEXPECTED_NATIVE_ENTRY"); } });
  };
  return { queue, claim, target, prepare, persist, busy };
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
describe("trusted Slack handler participation", () => {
  it("private BUSY crosses real handler without delivery tombstone, timer retry, or debounce delay", async () => {
    const f = await setup(); const h = handlerFor(f);
    mocks.dispatch.mockImplementation(async () => { setChannelSourceTurnId(h.context, source); await f.busy(); });
    const started = Date.now(); const result = await dispatchSlackIngressClaim({...f,dispatch:h.dispatch});
    expect(Date.now()-started).toBeLessThan(5000); // configured debounce is60s, capability must bypass it
    expect(result.status).toBe("RETRY_PRE_ADMISSION"); expect(mocks.delivered).not.toHaveBeenCalled();
    expect(h.releaseSeen).toHaveBeenCalledOnce(); expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(await f.queue.listPending()).toHaveLength(1);
  });
  it("normal handler completion without adoption neither completes nor records delivery", async () => {
    const f = await setup(); const h = handlerFor(f); mocks.dispatch.mockReset().mockResolvedValue(undefined);
    const result = await dispatchSlackIngressClaim({...f,dispatch:h.dispatch});
    expect(result.status).toBe("HELD_UNCERTAIN"); expect(mocks.delivered).not.toHaveBeenCalled(); expect(await f.queue.listClaims()).toHaveLength(1);
  });
  it("actual source adoption completes through prepared context capability", async () => {
    const f = await setup(); const h = handlerFor(f);
    mocks.dispatch.mockReset().mockImplementation(async () => { setChannelSourceTurnId(h.context, source); await f.persist(); await getSlackIngressAdoptionCallback(h.context)!(f.target); });
    const result = await dispatchSlackIngressClaim({...f,dispatch:h.dispatch});
    expect(result.status).toBe("ADOPTED"); expect(mocks.delivered).toHaveBeenCalledOnce(); expect(await f.queue.listClaims()).toEqual([]);
  });
});
