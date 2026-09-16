import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";

type NativeControlReceipt = Readonly<{ sourceTurnId: string; sessionKey: string; scopeKey: string }>;
type NativeControlProbe = {
  open: boolean;
  entered: boolean;
  responseCompleted?: boolean;
  disposition: "HANDLED" | "NOT_HANDLED" | "UNVERIFIED";
  receipt?: NativeControlReceipt;
};
const nativeControlProbe = new AsyncLocalStorage<NativeControlProbe>();
/** Private host control capability; no message field can activate this path. */
export async function withNativeControlProbe(run: () => Promise<unknown>): Promise<{
  disposition: "HANDLED" | "NOT_HANDLED" | "UNVERIFIED";
  receipt?: NativeControlReceipt;
  responseCompleted: boolean;
}> {
  if (nativeControlProbe.getStore()) throw new Error("THREAD_CONTROL_PROBE_NESTED");
  const probe: NativeControlProbe = { open: true, entered: false, disposition: "UNVERIFIED" };
  let responseCompleted = false;
  try {
    await nativeControlProbe.run(probe, run);
    responseCompleted = probe.responseCompleted === true;
  } catch {
    // Bolt may swallow the sentinel; only the private core observation is authority.
  } finally {
    probe.open = false;
  }
  return { disposition: probe.disposition, receipt: probe.receipt, responseCompleted };
}
/** Core-only entry check, before default-off routing or any control effects. */
export function enterNativeControlProbe(): boolean {
  const probe = nativeControlProbe.getStore();
  if (!probe) return false;
  if (!probe.open || probe.entered) throw new Error("THREAD_CONTROL_PROBE_CLOSED");
  probe.entered = true;
  return true;
}
export function completeNativeControlProbe(): void {
  const probe = nativeControlProbe.getStore();
  if (!probe || !probe.open || probe.disposition !== "HANDLED") throw new Error("THREAD_CONTROL_PROBE_UNVERIFIED");
  probe.responseCompleted = true;
}
/** Core-only latch after the existing authenticated abort resolver has returned. */
export function observeNativeControlProbe(receipt: NativeControlReceipt, handled: boolean): void {
  const probe = nativeControlProbe.getStore();
  if (!probe || !probe.open || !probe.entered || probe.receipt) throw new Error("THREAD_CONTROL_PROBE_UNVERIFIED");
  probe.receipt = Object.freeze({ ...receipt });
  probe.disposition = handled ? "HANDLED" : "NOT_HANDLED";
  if (!handled) throw new Error("THREAD_CONTROL_PROBE_NOT_HANDLED");
}

export type DispatchConfig = {
  databasePath: string;
  scopes: Record<string, number>;
  sessionScopes: Record<string, string>;
  unscopedSessionKeys?: string[];
  unscopedCronSessionKeys?: string[];
};
export type DispatchClaim = {
  claimId: string;
  scopeKey: string;
  epoch: number;
  fingerprint: string;
  kind: string;
};
type DispatchContext = { config: DispatchConfig; claim: DispatchClaim; childIndex: number };
const dispatchContext = new AsyncLocalStorage<DispatchContext | { unconfigured: true }>();
export function admitDispatchChild(identity: unknown): (() => void) | undefined {
  const parent = dispatchContext.getStore();
  if (!parent) {
    // A configured native effect must carry the admitted host context.
    if (loadDispatchConfig()) refuse();
    return undefined;
  }
  if ("unconfigured" in parent) return undefined;
  const index = parent.childIndex++;
  if (!Number.isSafeInteger(index)) refuse();
  const claim: DispatchClaim = {
    claimId: `${parent.claim.claimId}:child:${index}`,
    scopeKey: parent.claim.scopeKey,
    epoch: parent.claim.epoch,
    fingerprint: dispatchHash({ parent: parent.claim.fingerprint, index, identity }),
    kind: "process_child",
  };
  admitThreadDispatch(parent.config, claim, parent.claim);
  return () => settleThreadDispatch(parent.config, claim);
}
const scopePattern = /^slack\/[CGD][A-Z0-9]+\/[0-9]+\.[0-9]{6}$/;
const frozenSchema =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";
const shaPattern = /^[a-f0-9]{64}$/;
export const dispatchHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse(): never {
  throw new Error("THREAD_DISPATCH_REFUSED");
}
function dictionary(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function validateDispatchConfig(value: unknown): DispatchConfig {
  if (
    !dictionary(value) ||
    !dictionary(value.scopes) ||
    !dictionary(value.sessionScopes) ||
    typeof value.databasePath !== "string" ||
    !path.isAbsolute(value.databasePath) ||
    Object.keys(value).some((key) => !["databasePath", "scopes", "sessionScopes", "unscopedSessionKeys", "unscopedCronSessionKeys"].includes(key))
  )
    refuse();
  for (const [scope, epoch] of Object.entries(value.scopes)) {
    if (!scopePattern.test(scope) || !Number.isSafeInteger(epoch) || Number(epoch) < 1) refuse();
  }
  if (!Object.keys(value.scopes).length) refuse();
  for (const [session, scope] of Object.entries(value.sessionScopes)) {
    if (!session || typeof scope !== "string" || !Object.hasOwn(value.scopes, scope)) refuse();
  }
  const selectedKeys = Object.keys(value.sessionScopes).map((key) => key.toLowerCase());
  for (const field of ["unscopedSessionKeys", "unscopedCronSessionKeys"] as const) {
    const entries = value[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > 1024 || new Set(entries).size !== entries.length) refuse();
    for (const key of entries) {
      if (typeof key !== "string" || key.length > 512 || !/^agent:[a-z0-9][a-z0-9_-]*:[!-~]+$/.test(key) ||
          selectedKeys.includes(key.toLowerCase())) refuse();
      const parsed = canonicalSlackScope(key);
      if (parsed && Object.hasOwn(value.scopes, parsed)) refuse();
      if (field === "unscopedCronSessionKeys" && !cronBasePattern.test(key)) refuse();
      // Thread-like or cron-like aliases need their strict recognized grammar, never an exact-list escape.
      if (field === "unscopedSessionKeys" && (key.includes(":thread:") || key.includes(":cron:"))) refuse();
    }
  }
  return value as DispatchConfig;
}
export function loadDispatchConfig(): DispatchConfig | undefined {
  const filename = process.env.OPENCLAW_THREAD_DISPATCH_CONFIG;
  if (filename === undefined) return undefined;
  if (!filename || !path.isAbsolute(filename)) refuse();
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.size > 65536 || stat.mode & 0o022) refuse();
  return validateDispatchConfig(JSON.parse(readFileSync(filename, "utf8")));
}
const uuidPattern = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const cronBasePattern = new RegExp(`^agent:[a-z0-9][a-z0-9_-]*:cron:${uuidPattern}$`);
const cronRunPattern = new RegExp(`^(agent:[a-z0-9][a-z0-9_-]*:cron:${uuidPattern}):run:${uuidPattern}$`);
function canonicalSlackScope(sessionKey: string): string | undefined {
  const matched = /^agent:[a-z0-9][a-z0-9_-]*:slack:channel:([cgd][a-z0-9]+):thread:([0-9]+\.[0-9]{6})$/i.exec(sessionKey);
  if (!matched) return undefined;
  const channel = matched[1]; const thread = matched[2];
  if (!channel || !thread) refuse();
  return `slack/${channel.toUpperCase()}/${thread}`;
}
export function resolveDispatchScope(config: DispatchConfig, sessionKey?: string): string | undefined {
  if (typeof sessionKey !== "string" || !sessionKey || sessionKey !== sessionKey.trim()) refuse();
  if (Object.hasOwn(config.sessionScopes, sessionKey)) {
    const mapped = config.sessionScopes[sessionKey];
    if (typeof mapped !== "string" || !Object.hasOwn(config.scopes, mapped)) refuse();
    return mapped;
  }
  const scope = canonicalSlackScope(sessionKey);
  if (scope) return Object.hasOwn(config.scopes, scope) ? scope : undefined;
  // Host-reviewed exact sessions and exact cron jobs only. No unknown-origin wildcard.
  if (config.unscopedSessionKeys?.includes(sessionKey)) return undefined;
  const cronBase = cronBasePattern.test(sessionKey) ? sessionKey : cronRunPattern.exec(sessionKey)?.[1];
  if (cronBase && config.unscopedCronSessionKeys?.includes(cronBase)) return undefined;
  refuse();
}
export function runProvenUnscopedDispatch<T>(config: DispatchConfig, sessionKey: string | undefined, run: () => Promise<T>): Promise<T> {
  const inherited = dispatchContext.getStore();
  if (nativeControlProbe.getStore() || (inherited && !("unconfigured" in inherited)) || resolveDispatchScope(config, sessionKey) !== undefined) refuse();
  return dispatchContext.run({ unconfigured: true }, run);
}
function database<T>(config: DispatchConfig, fn: (db: DatabaseSync) => T): T {
  const before = lstatSync(config.databasePath);
  if (!before.isFile() || before.uid !== process.getuid?.() || before.mode & 0o077) refuse();
  const db = new (requireNodeSqlite().DatabaseSync)(config.databasePath);
  try {
    const after = lstatSync(config.databasePath);
    if (before.dev !== after.dev || before.ino !== after.ino) refuse();
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
    return runSqliteImmediateTransactionSync(db, () => {
      if (db.prepare("PRAGMA user_version").get()?.user_version !== 2) refuse();
      const normalize = (sql: string) => sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
      const expected = frozenSchema
        .split(";")
        .filter((sql) => sql.trim().startsWith("CREATE "))
        .map(normalize)
        .sort();
      const actual = db
        .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")
        .all()
        .map((row) => normalize(String(row.sql)))
        .sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) refuse();
      return fn(db);
    });
  } finally {
    db.close();
  }
}
function validClaim(claim: DispatchClaim): void {
  if (
    typeof claim.claimId !== "string" ||
    typeof claim.scopeKey !== "string" ||
    typeof claim.fingerprint !== "string" ||
    typeof claim.kind !== "string" ||
    !/^[A-Za-z0-9:._/-]{1,256}$/.test(claim.claimId) ||
    !scopePattern.test(claim.scopeKey) ||
    !shaPattern.test(claim.fingerprint) ||
    !Number.isSafeInteger(claim.epoch) ||
    claim.epoch < 1 ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(claim.kind)
  )
    refuse();
}
export class NativeDispatchBusyError extends Error {
  readonly code = "NATIVE_BUSY";
  constructor() {
    super("NATIVE_BUSY");
    this.name = "NativeDispatchBusyError";
  }
}
type NativeAdmissionBusyReceipt = Readonly<{ claimId: string; scopeKey: string; epoch: number }>;
const nativeAdmissionBusyReceipts = new WeakMap<object, NativeAdmissionBusyReceipt>();
/** Private provenance: only a rejected SQL admission can produce this receipt. */
export function readNativeAdmissionBusy(error: unknown): NativeAdmissionBusyReceipt | undefined {
  return typeof error === "object" && error !== null ? nativeAdmissionBusyReceipts.get(error) : undefined;
}
export function admitThreadDispatch(
  config: DispatchConfig,
  claim: DispatchClaim,
  parent?: DispatchClaim,
): void {
  validClaim(claim);
  if (config.scopes[claim.scopeKey] !== claim.epoch) refuse();
  database(config, (db) => {
    const fence = db
      .prepare("SELECT epoch,state FROM thread_fences WHERE scope_key=?")
      .get(claim.scopeKey);
    if (!fence || fence.epoch !== claim.epoch || fence.state !== "OPEN") refuse();
    if (db.prepare("SELECT 1 FROM thread_dispatch_claims WHERE claim_id=?").get(claim.claimId))
      refuse();
    if (claim.kind === "process_child") {
      if (!parent) refuse();
      validClaim(parent);
      if (
        parent.kind !== "native" ||
        parent.scopeKey !== claim.scopeKey ||
        parent.epoch !== claim.epoch
      )
        refuse();
      const owner = db
        .prepare("SELECT * FROM thread_dispatch_claims WHERE claim_id=?")
        .get(parent.claimId);
      if (
        !owner ||
        owner.scope_key !== parent.scopeKey ||
        owner.epoch !== parent.epoch ||
        owner.fingerprint !== parent.fingerprint ||
        owner.kind !== parent.kind ||
        !["STARTING", "RUNNING"].includes(String(owner.state))
      )
        refuse();
    } else if (parent !== undefined) refuse();
    if (
      claim.kind === "native" &&
      db
        .prepare(
          "SELECT 1 FROM thread_dispatch_claims WHERE scope_key=? AND kind='native' AND state!='TERMINAL'",
        )
        .get(claim.scopeKey)
    ) {
      const error = new NativeDispatchBusyError();
      nativeAdmissionBusyReceipts.set(error, Object.freeze({ claimId: claim.claimId, scopeKey: claim.scopeKey, epoch: claim.epoch }));
      throw error;
    }
    const now = Date.now();
    db.prepare(
      "INSERT INTO thread_dispatch_claims (claim_id,scope_key,epoch,fingerprint,kind,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'STARTING',?,?)",
    ).run(claim.claimId, claim.scopeKey, claim.epoch, claim.fingerprint, claim.kind, now, now);
  });
}
export function settleThreadDispatch(
  config: DispatchConfig,
  claim: DispatchClaim,
  receipt?: string,
): void {
  validClaim(claim);
  if (receipt !== undefined && !shaPattern.test(receipt)) refuse();
  if (config.scopes[claim.scopeKey] !== claim.epoch) refuse();
  database(config, (db) => {
    const row = db
      .prepare("SELECT * FROM thread_dispatch_claims WHERE claim_id=?")
      .get(claim.claimId);
    if (
      !row ||
      row.scope_key !== claim.scopeKey ||
      row.epoch !== claim.epoch ||
      row.fingerprint !== claim.fingerprint ||
      row.kind !== claim.kind
    )
      refuse();
    const fence = db
      .prepare("SELECT epoch,state FROM thread_fences WHERE scope_key=?")
      .get(claim.scopeKey);
    if (!fence || fence.epoch !== claim.epoch) refuse();
    if (row.state === "TERMINAL") {
      if (row.terminal_receipt !== receipt) refuse();
      return;
    }
    if (!["OPEN", "DRAINING"].includes(String(fence.state))) refuse();
    db.prepare(
      "UPDATE thread_dispatch_claims SET state=?,terminal_receipt=?,updated_at_ms=? WHERE claim_id=?",
    ).run(receipt ? "TERMINAL" : "UNKNOWN", receipt ?? null, Date.now(), claim.claimId);
  });
}
export async function withThreadDispatch<T>(params: {
  sessionKey?: string;
  operationId: string;
  kind: string;
  identity: unknown;
  run: () => Promise<T>;
  terminalReceipt: (result: T) => string | undefined;
  config?: DispatchConfig;
}): Promise<T> {
  const config = params.config ?? loadDispatchConfig();
  if (!config) return params.run();
  const scopeKey = resolveDispatchScope(config, params.sessionKey);
  if (!scopeKey) return runProvenUnscopedDispatch(config, params.sessionKey, params.run);
  const epoch = config.scopes[scopeKey];
  if (epoch === undefined) refuse();
  const claim = {
    claimId: params.operationId,
    scopeKey,
    epoch,
    fingerprint: dispatchHash(params.identity),
    kind: params.kind,
  };
  admitThreadDispatch(config, claim);
  try {
    const result = await dispatchContext.run({ config, claim, childIndex: 0 }, params.run);
    settleThreadDispatch(config, claim, params.terminalReceipt(result));
    return result;
  } catch (error) {
    // If reconciliation itself fails, STARTING remains durable and blocks retirement.
    settleThreadDispatch(config, claim);
    throw error;
  }
}

// Only host code can create this capability; public run parameters carry no owner.
type NativePreAdmissionRefusal = Readonly<{ sourceTurnId: string; sessionKey: string; scopeKey: string; claimId: string; epoch: number }>;
const preAdmissionRefusals = new WeakMap<object, NativePreAdmissionRefusal>();
export function readNativePreAdmissionRefusal(error: unknown): NativePreAdmissionRefusal | undefined {
  return typeof error === "object" && error !== null ? preAdmissionRefusals.get(error) : undefined;
}
type LogicalDispatchContext = {
  owner: DispatchContext;
  sessionKey: string;
  sourceTurnId: string;
  role: "dispatch" | "reply";
  observeCompleted: (receipt: string) => void;
  hooks: Promise<boolean>[];
  acceptingHooks: boolean;
};
const logicalDispatchContext = new AsyncLocalStorage<LogicalDispatchContext>();
export const hasLogicalDispatchOwner = (): boolean => logicalDispatchContext.getStore() !== undefined;
type LogicalReplyParams<T> = {
  sessionKey?: string;
  sourceTurnId?: string;
  prompt: string;
  run: (observeCompleted: (receipt: string) => void) => Promise<T>;
  config?: DispatchConfig;
  abortSignal?: AbortSignal;
};
export function trackLogicalDispatchHook(task: () => Promise<unknown>): boolean {
  const logical = logicalDispatchContext.getStore();
  if (!logical || logical.role !== "dispatch") return false;
  if (!logical.acceptingHooks) refuse();
  try { logical.hooks.push(task().then(() => true, () => false)); }
  catch { throw new Error("THREAD_DISPATCH_HOOK_FAILED"); }
  return true;
}
function waitLogicalHooks(hooks: Promise<boolean>[], signal?: AbortSignal): Promise<boolean[]> {
  if (!signal) return Promise.all(hooks);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("THREAD_DISPATCH_ABORTED"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void Promise.all(hooks).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function withLogicalReplyDispatch<T>(params: LogicalReplyParams<T>): Promise<T> {
  const parent = logicalDispatchContext.getStore();
  if (parent) {
    if (parent.role !== "dispatch" || params.sourceTurnId !== parent.sourceTurnId ||
        params.sessionKey !== parent.sessionKey) refuse();
    return runLogicalDispatchAttempt({ sessionKey: params.sessionKey,
      run: () => params.run(parent.observeCompleted) })!;
  }
  return withLogicalOwner(params, "reply");
}
export function withLogicalChannelDispatch<T>(params: LogicalReplyParams<T>): Promise<T> {
  if (logicalDispatchContext.getStore()) refuse();
  return withLogicalOwner(params, "dispatch");
}
async function withLogicalOwner<T>(params: LogicalReplyParams<T>, role: "dispatch" | "reply"): Promise<T> {
  const config = params.config ?? loadDispatchConfig();
  if (!config) return params.run(() => {});
  const scopeKey = resolveDispatchScope(config, params.sessionKey);
  if (!scopeKey) return runProvenUnscopedDispatch(config, params.sessionKey, () => params.run(() => {}));
  if (!params.sessionKey || typeof params.sourceTurnId !== "string" ||
      !/^channel-user:v1:[a-f0-9]{64}$/.test(params.sourceTurnId)) refuse();
  const sessionKey = params.sessionKey;
  const sourceTurnId = params.sourceTurnId;
  let completedReceipt: string | undefined;
  let entered = false;
  const claimId = `logical:${dispatchHash({ scopeKey, sourceTurnId })}`;
  const epoch = config.scopes[scopeKey];
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) refuse();
  try { return await withThreadDispatch({
    config, sessionKey,
    operationId: claimId,
    kind: "native",
    identity: { scopeKey, sessionKey, sourceTurnId, promptSha256: dispatchHash(params.prompt) },
    run: async () => {
      entered = true;
      const owner = dispatchContext.getStore();
      if (!owner || "unconfigured" in owner) refuse();
      const logical: LogicalDispatchContext = {
        owner, sessionKey, sourceTurnId, role, hooks: [], acceptingHooks: true,
        observeCompleted: (receipt) => {
          if (typeof receipt !== "string" || !shaPattern.test(receipt) || completedReceipt) refuse();
          completedReceipt = receipt;
        },
      };
      return logicalDispatchContext.run(logical, async () => {
        try {
          const result = await params.run(logical.observeCompleted);
          // Hooks may register work while earlier hooks finish: drain every admitted batch.
          let offset = 0;
          while (offset < logical.hooks.length) {
            const batch = logical.hooks.slice(offset); offset += batch.length;
            if ((await waitLogicalHooks(batch, params.abortSignal)).some((ok) => !ok))
              throw new Error("THREAD_DISPATCH_HOOK_FAILED");
          }
          if (params.abortSignal?.aborted) throw new Error("THREAD_DISPATCH_ABORTED");
          return result;
        } finally { logical.acceptingHooks = false; }
      });
    },
    terminalReceipt: () => completedReceipt,
  }); } catch (error) {
    if (role === "dispatch" && !entered && error instanceof NativeDispatchBusyError) {
      preAdmissionRefusals.set(error, Object.freeze({ sourceTurnId, sessionKey, scopeKey, claimId, epoch }));
    }
    throw error;
  }
}

export function runLogicalDispatchAttempt<T>(params: {
  sessionKey?: string;
  run: () => Promise<T>;
}): Promise<T> | undefined {
  const logical = logicalDispatchContext.getStore();
  if (!logical) return undefined;
  const { config, claim } = logical.owner;
  if (dispatchContext.getStore() !== logical.owner || params.sessionKey !== logical.sessionKey ||
      resolveDispatchScope(config, params.sessionKey) !== claim.scopeKey ||
      config.scopes[claim.scopeKey] !== claim.epoch) refuse();
  database(config, (db) => {
    const fence = db.prepare("SELECT epoch,state FROM thread_fences WHERE scope_key=?").get(claim.scopeKey);
    const owner = db.prepare("SELECT * FROM thread_dispatch_claims WHERE claim_id=?").get(claim.claimId);
    if (!fence || fence.epoch !== claim.epoch || fence.state !== "OPEN" || !owner ||
        owner.scope_key !== claim.scopeKey || owner.epoch !== claim.epoch ||
        owner.fingerprint !== claim.fingerprint || owner.kind !== "native" ||
        !["STARTING", "RUNNING"].includes(String(owner.state))) refuse();
  });
  // Admission linearizes above. Drain can follow, but cannot cancel this already admitted promise.
  return params.run();
}

// Persisted cron origin owns the logical turn; detached session keys are execution identities.
type CronDispatchContext = { owner?: DispatchContext; sessionKey?: string; receipt?: string; closed: boolean };
const cronDispatchContext = new AsyncLocalStorage<CronDispatchContext>();
export const hasCronDispatchOwner = (): boolean => cronDispatchContext.getStore() !== undefined;
export function bindCronDispatchSession(sessionKey: string): void {
  const context = cronDispatchContext.getStore();
  if (!context) return;
  if (context.closed || context.sessionKey || !sessionKey) refuse();
  context.sessionKey = sessionKey;
}
export async function withCronDispatchOwner<T>(params: {
  sessionKey: string; operationId: string; identity: unknown;
  run: () => Promise<T>; completed: (result: T) => boolean;
}): Promise<T> {
  const config = loadDispatchConfig();
  if (!config) return params.run();
  if (cronDispatchContext.getStore() || logicalDispatchContext.getStore() || dispatchContext.getStore()) refuse();
  let context: CronDispatchContext | undefined;
  return withThreadDispatch({ config, sessionKey: params.sessionKey, operationId: params.operationId,
    identity: params.identity, kind: "native",
    run: async () => {
      const owner = dispatchContext.getStore();
      if (!owner) refuse();
      context = { ...( "unconfigured" in owner ? {} : { owner }), closed: false };
      try { return await cronDispatchContext.run(context, params.run); }
      finally { context.closed = true; }
    },
    terminalReceipt: result => params.completed(result) ? context?.receipt : undefined,
  });
}
export async function runCronDispatchAttempt<T>(params: {
  sessionKey?: string; run: () => Promise<T>; terminalReceipt: (result: T) => string | undefined;
}): Promise<T> {
  const context = cronDispatchContext.getStore();
  if (!context || context.closed || !context.sessionKey || context.sessionKey !== params.sessionKey) refuse();
  const owner = context.owner;
  if (owner) {
    if (dispatchContext.getStore() !== owner) refuse();
    database(owner.config, db => {
      const fence = db.prepare("SELECT epoch,state FROM thread_fences WHERE scope_key=?").get(owner.claim.scopeKey);
      const row = db.prepare("SELECT * FROM thread_dispatch_claims WHERE claim_id=?").get(owner.claim.claimId);
      if (!fence || fence.epoch !== owner.claim.epoch || fence.state !== "OPEN" || !row ||
          row.scope_key !== owner.claim.scopeKey || row.epoch !== owner.claim.epoch ||
          row.fingerprint !== owner.claim.fingerprint || row.kind !== "native" ||
          !["STARTING", "RUNNING"].includes(String(row.state))) refuse();
    });
  } else {
    const active = dispatchContext.getStore();
    if (!active || !("unconfigured" in active)) refuse();
  }
  context.receipt = undefined;
  const result = await params.run();
  context.receipt = params.terminalReceipt(result);
  return result;
}
