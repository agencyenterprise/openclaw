// Opt-in text-only Slack receiver journal. No autonomous replay/adoption claims.
import { createHash } from "node:crypto";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
} from "../../../../src/channels/message/ingress-queue.js";

export type SlackIngressScope = Readonly<{
  accountId: string;
  teamId: string;
  appId: string;
  channelId: string;
  threadTs: string;
}>;
export type SlackIngressPayload = {
  version: 1;
  sourceId: string;
  digest: string;
  body: Record<string, unknown>;
};
export type SlackIngressMetadata = { digest: string };
export type SlackIngressQueue = ChannelIngressQueue<
  SlackIngressPayload,
  SlackIngressMetadata,
  SlackIngressMetadata
>;
export type SlackIngressControlProbe = (body: Record<string, unknown>) => Promise<"HANDLED" | "NOT_HANDLED" | "UNVERIFIED" | "NOT_CONTROL">;
export type SlackIgnoredBotIdentity = Readonly<{ botUserId?: string; botId?: string }>;
export type SlackIngressEnvelope = { body: unknown; ack: () => Promise<unknown> };
export type SlackIngressParticipant = Readonly<{
  sourceId: string;
  digest: string;
  claimId: string;
  claimToken: string;
  ownerId: string;
}>;

class SlackIngressRefusal extends Error {}
function refusal(code: string): never {
  throw new SlackIngressRefusal(`SLACK_INGRESS_${code}`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refusal("SHAPE");
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value || value.length > maximum) return refusal("FIELD");
  return value;
}
function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const EVENT_FIELDS = new Set([
  "type",
  "channel",
  "channel_type",
  "user",
  "text",
  "ts",
  "thread_ts",
  "event_ts",
  "team",
  "client_msg_id", "parent_user_id", "app_id", "blocks", "is_starred", "pinned_to", "reactions",
]);
const BLOCK_TYPES = new Set(["rich_text", "rich_text_section", "rich_text_list", "rich_text_preformatted", "rich_text_quote", "context", "text", "link", "emoji", "user", "channel", "usergroup", "broadcast", "date", "color", "mrkdwn", "plain_text"]);
const BLOCK_FIELDS = new Set(["type", "block_id", "elements", "text", "url", "name", "user_id", "channel_id", "usergroup_id", "range", "value", "style", "border", "indent", "offset", "timestamp", "format", "fallback", "verbatim", "emoji", "unicode", "skin_tone"]);
function cleanBlocks(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 32) return refusal("BLOCKS");
  let nodes=0;
  const visit=(input: unknown, depth: number): Record<string,unknown> => {
    if (++nodes>1024 || depth>12) return refusal("BLOCK_LIMIT");
    const item=object(input); const type=string(item.type);
    if (!BLOCK_TYPES.has(type)) return refusal("BLOCK_TYPE");
    const clean:Record<string,unknown>={};
    for(const key of Object.keys(item).sort()) {
      if(!BLOCK_FIELDS.has(key)) return refusal("BLOCK_FIELD");
      const v=item[key];
      if(key==='elements') { if(!Array.isArray(v)||v.length>256)return refusal("BLOCK_ELEMENTS");clean[key]=v.map(x=>visit(x,depth+1)); }
      else if(key==='style' && typeof v==='object') {
        const style=object(v); const result:Record<string,boolean>={};
        for(const flag of Object.keys(style).sort()){if(!['bold','italic','strike','code','highlight','client_highlight','unlink'].includes(flag)||typeof style[flag]!=='boolean')return refusal("BLOCK_STYLE");result[flag]=style[flag] as boolean;}clean[key]=result;
      } else if(typeof v==='string') {if(v.length>48*1024)return refusal("BLOCK_STRING");clean[key]=v;}
      else if(typeof v==='boolean') clean[key]=v;
      else if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)clean[key]=v;
      else return refusal("BLOCK_VALUE");
    }
    return clean;
  };
  return value.map(v=>{const b=object(v);if(b.type!=='rich_text'&&b.type!=='context')return refusal("BLOCK_TOP_LEVEL");return visit(b,0);});
}
function cleanMetadata(key:string,value:unknown):unknown {
  if(key==='blocks')return cleanBlocks(value);
  if(key==='is_starred'){if(typeof value!=='boolean')return refusal('METADATA');return value;}
  if(key==='pinned_to'){if(!Array.isArray(value)||value.length>32)return refusal('METADATA');return value.map(v=>string(v));}
  if(key==='reactions'){
    if(!Array.isArray(value)||value.length>64)return refusal('METADATA');
    return value.map(v=>{const r=object(v);if(Object.keys(r).some(k=>!['name','count','users'].includes(k))||!Number.isSafeInteger(r.count)||Number(r.count)<0||!Array.isArray(r.users)||r.users.length>256)return refusal('METADATA');return {name:string(r.name),count:r.count,users:r.users.map(u=>string(u))};});
  }
  return string(value);
}
function isIgnoredBot(bodyValue:unknown,scope:SlackIngressScope,identity:SlackIgnoredBotIdentity|undefined):boolean {
  if(!identity)return false;
  const body=object(bodyValue);if(body.type!=='event_callback')return false;
  const event=object(body.event);
  if((event.type!=='message'&&event.type!=='app_mention')||event.channel!==scope.channelId||(event.thread_ts??event.ts)!==scope.threadTs)return false;
  if(body.team_id!==scope.teamId||body.api_app_id!==scope.appId)return refusal('IDENTITY');
  if(body.authorizations!==undefined){if(!Array.isArray(body.authorizations)||body.authorizations.length>8)return refusal('AUTHORIZATIONS');for(const v of body.authorizations){const a=object(v);if(a.team_id!==scope.teamId||a.is_enterprise_install===true)return refusal('AUTHORIZATION_SCOPE');}}
  return Boolean((identity.botUserId&&event.user===identity.botUserId)||(identity.botId&&event.bot_id===identity.botId));
}
const BODY_FIELDS = new Set([
  "type",
  "team_id",
  "api_app_id",
  "event_id",
  "event_time",
  "event",
  "authorizations",
  "event_context",
  "is_ext_shared_channel",
  "token",
  "response_url",
  "response_urls",
]);

export function normalizeSlackIngress(
  bodyValue: unknown,
  scope: SlackIngressScope,
): SlackIngressPayload | null {
  const body = object(bodyValue);
  if (body.type !== "event_callback") return null;
  const event = object(body.event);
  if (event.type !== "message" && event.type !== "app_mention") return null;
  // Match the thread first: malformed or foreign identity inside it cannot bypass into direct dispatch.
  if (event.channel !== scope.channelId || (event.thread_ts ?? event.ts) !== scope.threadTs)
    return null;
  if (body.team_id !== scope.teamId || body.api_app_id !== scope.appId) return refusal("IDENTITY");
  for (const key of Object.keys(body))
    if (!BODY_FIELDS.has(key)) return refusal("UNSUPPORTED_BODY");
  for (const key of Object.keys(event))
    if (!EVENT_FIELDS.has(key)) return refusal("UNSUPPORTED_EVENT");
  const cleanEvent: Record<string, unknown> = {};
  for (const key of Object.keys(event).sort()) {
    cleanEvent[key] = key === "text" ? string(event[key], 48 * 1024) : cleanMetadata(key,event[key]);
  }
  string(event.user);
  string(event.ts);
  string(event.text, 48 * 1024);
  if (!/^U[A-Z0-9]+$/.test(event.user as string)) return refusal("USER_ID");
  for (const key of ["ts", "thread_ts", "event_ts"]) {
    if (event[key] !== undefined && !/^\d+\.\d{6}$/.test(event[key] as string))
      return refusal("TIMESTAMP");
  }
  const clean: Record<string, unknown> = {
    type: "event_callback",
    team_id: scope.teamId,
    api_app_id: scope.appId,
    event_id: string(body.event_id),
    event: cleanEvent,
  };
  if (body.event_time !== undefined) {
    if (!Number.isSafeInteger(body.event_time) || (body.event_time as number) < 0)
      return refusal("EVENT_TIME");
    clean.event_time = body.event_time;
  }
  if (body.event_context !== undefined) clean.event_context = string(body.event_context, 1024);
  if (body.is_ext_shared_channel !== undefined) {
    if (typeof body.is_ext_shared_channel !== "boolean") return refusal("SHARED_FLAG");
    clean.is_ext_shared_channel = body.is_ext_shared_channel;
  }
  if (body.authorizations !== undefined) {
    if (!Array.isArray(body.authorizations) || body.authorizations.length > 8)
      return refusal("AUTHORIZATIONS");
    clean.authorizations = body.authorizations.map((value: unknown) => {
      const auth = object(value);
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(auth).sort()) {
        if (["team_id", "enterprise_id", "user_id"].includes(key))
          result[key] = auth[key] === null ? null : string(auth[key]);
        else if (
          ["is_bot", "is_enterprise_install"].includes(key) &&
          typeof auth[key] === "boolean"
        )
          result[key] = auth[key];
        else return refusal("AUTHORIZATION_FIELD");
      }
      // Bolt buildSource prefers authorization.team_id over the top-level team.
      if (result.team_id !== scope.teamId || result.is_enterprise_install === true)
        return refusal("AUTHORIZATION_SCOPE");
      return result;
    });
  }
  // Only explicitly allowed fields survive; token and response URL capabilities never persist.
  const encoded = canonical(clean);
  if (Buffer.byteLength(encoded) > 64 * 1024) return refusal("PAYLOAD_LIMIT");
  const sourceId = sha(canonical([scope.accountId, scope.teamId, scope.appId, body.event_id]));
  return { version: 1, sourceId, digest: sha(encoded), body: clean };
}

export function createSlackDurableIngress(params: {
  scope: SlackIngressScope;
  queue: SlackIngressQueue;
  delegate: (event: SlackIngressEnvelope) => Promise<unknown>;
  probeControl?: SlackIngressControlProbe;
  getIgnoredBotIdentity?: () => SlackIgnoredBotIdentity | undefined;
}) {
  const scope = Object.freeze({ ...params.scope });
  for (const value of Object.values(scope)) string(value);
  if (
    !/^T[A-Z0-9]+$/.test(scope.teamId) ||
    !/^A[A-Z0-9]+$/.test(scope.appId) ||
    !/^[CDG][A-Z0-9]+$/.test(scope.channelId) ||
    !/^\d+\.\d{6}$/.test(scope.threadTs)
  )
    return refusal("SCOPE");
  return {
    async receive(event: SlackIngressEnvelope): Promise<void> {
      if (isIgnoredBot(event.body,scope,params.getIgnoredBotIdentity?.())) {
        try { await event.ack(); } catch { return refusal('IO_FAILURE'); }
        return;
      }
      const payload = normalizeSlackIngress(event.body, scope);
      if (!payload) {
        await params.delegate(event);
        return;
      }
      try {
        if (params.probeControl) {
          // Probe a copy: unhandled control must journal the unchanged normalized source.
          const control = await params.probeControl(structuredClone(payload.body));
          if (control === "HANDLED") { await event.ack(); return; }
          if (control !== "NOT_CONTROL" && control !== "NOT_HANDLED")
            return refusal("CONTROL_UNVERIFIED");
        }
        const result = await params.queue.enqueue(payload.sourceId, payload, {
          metadata: { digest: payload.digest },
          laneKey: canonical([scope.teamId, scope.channelId, scope.threadTs]),
        });
        if (result.kind === "failed") return refusal("FAILED_TOMBSTONE");
        if (result.record.metadata?.digest !== payload.digest) return refusal("DUPLICATE_CONFLICT");
        if (
          (result.kind === "pending" || result.kind === "claimed") &&
          (result.record.payload.digest !== payload.digest ||
            canonical(result.record.payload.body) !== canonical(payload.body))
        ) {
          return refusal("DUPLICATE_CONFLICT");
        }
        await event.ack();
      } catch (error) {
        if (error instanceof SlackIngressRefusal) throw error;
        // The SDK logs processEvent errors. Never forward private database/transport text.
        return refusal("IO_FAILURE");
      }
    },
    async claimOne(
      ownerId: string,
    ): Promise<ChannelIngressQueueClaim<SlackIngressPayload, SlackIngressMetadata> | null> {
      // Never pass staleMs: its implicit recovery lacks proof of dead owner AND unadopted source.
      const laneKey = canonical([scope.teamId, scope.channelId, scope.threadTs]);
      const pending = await params.queue.listPending({ limit: 32, laneKey });
      const candidateIds: string[] = [];
      for (const row of pending) {
        if (row.laneKey !== laneKey) continue;
        const expected = normalizeSlackIngress(row.payload.body, scope);
        if (
          !expected ||
          expected.sourceId !== row.id ||
          expected.digest !== row.payload.digest ||
          row.metadata?.digest !== expected.digest
        )
          return refusal("STORED_IDENTITY");
        candidateIds.push(row.id);
      }
      if (!candidateIds.length) return null;
      const claim = await params.queue.claimNext({
        ownerId: string(ownerId),
        scanLimit: 32,
        candidateIds,
      });
      if (!claim) return null;
      const expected = normalizeSlackIngress(claim.payload.body, scope);
      if (
        !expected ||
        expected.sourceId !== claim.id ||
        expected.digest !== claim.payload.digest ||
        claim.metadata?.digest !== expected.digest
      ) {
        return refusal("STORED_IDENTITY"); // Preserve uncertain claim; do not replay/delete.
      }
      return claim;
    },
    participant(
      claim: ChannelIngressQueueClaim<SlackIngressPayload, SlackIngressMetadata>,
    ): SlackIngressParticipant {
      return Object.freeze({
        sourceId: claim.id,
        digest: claim.payload.digest,
        claimId: claim.id,
        claimToken: claim.claim.token,
        ownerId: claim.claim.ownerId,
      });
    },
  };
}

/** Receiver wrapper for App construction; SDK start/stop/auth transport remain unchanged. */
export function wrapSlackDurableReceiver<
  TApp extends { processEvent(event: SlackIngressEnvelope): Promise<unknown> },
>(params: {
  receiver: { init(app: TApp): void; start(): unknown; stop(): unknown };
  scope: SlackIngressScope;
  queue: SlackIngressQueue;
  probeControl?: SlackIngressControlProbe;
  getIgnoredBotIdentity?: () => SlackIgnoredBotIdentity | undefined;
}) {
  let initialized = false;
  const init = (app: TApp) => {
    if (initialized) return refusal("ALREADY_INITIALIZED");
    initialized = true;
    const journal = createSlackDurableIngress({
      ...params,
      delegate: (event) => app.processEvent(event),
    });
    const proxy = new Proxy(app, {
      get(target, key, receiver) {
        if (key === "processEvent")
          return (event: SlackIngressEnvelope) => journal.receive(event);
        return Reflect.get(target, key, receiver);
      },
    });
    params.receiver.init(proxy);
  };
  // Preserve the real client's disconnect/shutdown surface and receiver prototype.
  // Bind methods to the original receiver so private fields and getters keep their owner.
  const methods = new Map<PropertyKey, { original: unknown; bound: unknown }>();
  return new Proxy(params.receiver, {
    get(target, key) {
      if (key === "init") return init;
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const cached = methods.get(key);
      if (cached && cached.original === value) return cached.bound;
      const bound = value.bind(target);
      methods.set(key, { original: value, bound });
      return bound;
    },
  });
}
