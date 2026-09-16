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
describe("private Slack adoption bridge", () => {
  it("completes only after actual durable source readback", async () => {
    const f = await setup(); const result = await dispatchSlackIngressClaim({ ...f, dispatch: async ({ body }) => { const p = f.prepare(body); await f.persist(); await p.adopted(f.target); } });
    expect(result.status).toBe("ADOPTED"); expect(await f.queue.listClaims()).toEqual([]);
    const duplicate = await f.queue.enqueue(f.claim.id, f.claim.payload); expect(duplicate.kind).toBe("completed");
    expect(duplicate.record).toMatchObject({ metadata: { digest: f.claim.payload.digest, logicalSourceId: source } });
  });
  it("callback timing without persisted source stays held", async () => {
    const f = await setup(); const result = await dispatchSlackIngressClaim({ ...f, dispatch: async ({ body }) => { await f.prepare(body).adopted(f.target); } });
    expect(result).toMatchObject({ status: "HELD_UNCERTAIN", reason: "ADOPTION_UNVERIFIED" }); expect(await f.queue.listClaims()).toHaveLength(1);
  });
  it("undefined target/untracked adoption cannot complete", async () => {
    const f = await setup(); const result = await dispatchSlackIngressClaim({ ...f, dispatch: async ({ body }) => { await f.prepare(body).adopted(); } });
    expect(result.status).toBe("HELD_UNCERTAIN");
  });
  it("swallowed completion failure after actual admission never becomes retry", async () => {
    const f = await setup(); vi.spyOn(f.queue, "complete").mockRejectedValue(new Error("PRIVATE_STORAGE_FAILURE"));
    const result = await dispatchSlackIngressClaim({ ...f, dispatch: async ({ body }) => { const p = f.prepare(body); await f.persist(); try { await p.adopted(f.target); } catch { /* matches irreversible steering catch */ } } });
    expect(result).toMatchObject({ status: "HELD_UNCERTAIN", reason: "ADOPTION_UNVERIFIED" }); expect(JSON.stringify(result)).not.toContain("PRIVATE"); expect(await f.queue.listPending()).toEqual([]);
  });
  it("plain typed BUSY has no private pre-admission proof", async () => {
    const f = await setup(); const result = await dispatchSlackIngressClaim({ ...f, dispatch: async ({ body }) => { f.prepare(body); throw new NativeDispatchBusyError(); } });
    expect(result.status).toBe("HELD_UNCERTAIN"); expect(await f.queue.listClaims()).toHaveLength(1);
  });
  it("actual higher-owner refusal plus historical absence releases exact claim", async () => {
    const f = await setup(); const result = await dispatchSlackIngressClaim({ ...f, dispatch: async ({ body }) => { f.prepare(body); await f.busy(); } });
    expect(result.status).toBe("RETRY_PRE_ADMISSION"); expect(await f.queue.listClaims()).toEqual([]); expect(await f.queue.listPending()).toHaveLength(1);
  });
  it("private BUSY proof never overrides prior transcript adoption", async () => {
    const f = await setup(); await f.persist(); const result = await dispatchSlackIngressClaim({ ...f, dispatch: async ({ body }) => { f.prepare(body); await f.busy(); } });
    expect(result).toMatchObject({ status: "HELD_UNCERTAIN", reason: "HISTORICAL_SOURCE_UNCERTAIN" }); expect(await f.queue.listClaims()).toHaveLength(1);
  });
  it("normal ignored/null return is not a positive disposition", async () => {
    const f = await setup(); const result = await dispatchSlackIngressClaim({ ...f, dispatch: async () => undefined }); expect(result.status).toBe("HELD_UNCERTAIN");
  });
  it("JSON participant and late callbacks cannot manufacture completion", async () => {
    expect(withSlackIngressOptions({ participant: { claimToken: "fake" } }, {})).toEqual({});
    const f = await setup(); let late: ReturnType<typeof getSlackIngressAdoptionCallback>;
    await dispatchSlackIngressClaim({ ...f, dispatch: async ({ body }) => { late = f.prepare(body).adopted; } });
    await f.persist(); await expect(late!(f.target)).rejects.toThrow("HELD"); expect(await f.queue.listClaims()).toHaveLength(1);
  });
});
