// Slack provider module implements model/runtime integration.
import { AsyncLocalStorage } from "node:async_hooks";
import { asOptionalRecord as asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackChannelResolution } from "../resolve-channels.js";
import type { SlackUserResolution } from "../resolve-users.js";
import type { SlackIdentityHealth } from "./enterprise-install.js";
import {
  formatUnknownError,
  type SlackSocketDisconnect,
  type SlackSocketLivenessOptions,
  waitForSlackSocketDisconnect,
  watchSlackSocketLiveness,
} from "./reconnect-policy.js";

type SlackAppConstructor = typeof import("@slack/bolt").App;
type SlackHttpReceiverConstructor = typeof import("@slack/bolt").HTTPReceiver;
type SlackReceiver = import("@slack/bolt").Receiver;
type SlackSocketModeReceiverConstructor = typeof import("@slack/bolt").SocketModeReceiver;
type SlackSocketModeReceiverOptions = ConstructorParameters<SlackSocketModeReceiverConstructor>[0];
type SlackSocketModeConfig = Pick<
  SlackSocketModeReceiverOptions,
  "clientPingTimeout" | "serverPingTimeout" | "pingPongLoggingEnabled"
>;
type SlackSdkLogger = NonNullable<SlackSocketModeReceiverOptions["logger"]>;
type SlackSdkLogLevel = ReturnType<SlackSdkLogger["getLevel"]>;
type SlackSocketModeLogger = SlackSdkLogger & {
  getLastMessage: () => string | undefined;
};

const OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS = 15_000;
// Reconnects are owned by OpenClaw's monitor loop, never by the SDK: the SDK's
// native reconnect runs at debug log level, never reports back, and can wait
// forever (no HTTP timeout on apps.connections.open, no websocket handshake
// timeout, no bound on "disconnect before hello" loops).
// Every Socket Mode connection attempt is bounded by these limits.
const SLACK_SOCKET_OPEN_HTTP_TIMEOUT_MS = 20_000;
export const SLACK_SOCKET_CONNECT_TIMEOUT_MS = 90_000;
export const SLACK_SOCKET_STOP_TIMEOUT_MS = 10_000;
/** After a stop timed out, how long a reconnect waits for it to finish before the app is discarded. */
export const SLACK_SOCKET_STOP_SETTLE_TIMEOUT_MS = 20_000;
const SLACK_SOCKET_CLIENT_METHODS = ["start", "disconnect", "retrieveWSSURL", "on", "off"] as const;
export const SLACK_SOCKET_LIVENESS: SlackSocketLivenessOptions = {
  checkIntervalMs: 5_000,
  staleAfterMs: 60_000,
};
const SLACK_SOCKET_PONG_TIMEOUT_WARNING_PREFIX = "A pong wasn't received from the server";
const SLACK_SOCKET_PING_TIMEOUT_WARNING_PREFIX = "A ping wasn't received from the server";
const SLACK_SOCKET_LOG_LEVEL_IGNORED_WARNING_RE =
  /^The logLevel given to .+ was ignored as you also gave logger$/;

export type SlackBoltResolvedExports = {
  App: SlackAppConstructor;
  HTTPReceiver: SlackHttpReceiverConstructor;
  SocketModeReceiver: SlackSocketModeReceiverConstructor;
};

type SlackSocketShutdownClient = {
  shuttingDown?: boolean;
};
type Constructor = abstract new (...args: never[]) => unknown;
type SlackSelfFilterArgs = {
  context?: {
    botId?: string;
    botUserId?: string;
  };
  event?: unknown;
  message?: unknown;
};

function isConstructorFunction<
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Constructor guard preserves the requested concrete Slack constructor type.
  T extends Constructor,
>(value: unknown): value is T {
  return typeof value === "function";
}

const supersedePendingStartsByClient = new WeakMap<object, () => void>();

/**
 * A connection attempt that outlives its deadline (or a stop) must not open a
 * socket later. Each start() gets its own attempt token, carried through its
 * async work by AsyncLocalStorage; each start, disconnect and stop moves the
 * current token on. A start whose token is no longer current rejects when its
 * WSS URL arrives, and again at the "connecting" emit that start() fires right
 * before ws.connect(), so a superseded start never connects.
 */
function discardSupersededSlackSocketStarts(receiver: unknown) {
  const client =
    receiver && typeof receiver === "object" ? Reflect.get(receiver, "client") : undefined;
  const [start, disconnect, retrieveWSSURL, on, off] = SLACK_SOCKET_CLIENT_METHODS.map((name) =>
    client && typeof client === "object" ? Reflect.get(client, name) : undefined,
  );
  if (
    !client ||
    typeof client !== "object" ||
    typeof start !== "function" ||
    typeof disconnect !== "function" ||
    typeof retrieveWSSURL !== "function" ||
    typeof on !== "function" ||
    typeof off !== "function"
  ) {
    throw new Error(
      `unsupported @slack/socket-mode client: expected methods ${SLACK_SOCKET_CLIENT_METHODS.join(", ")}`,
    );
  }
  let generation = 0;
  const attempt = new AsyncLocalStorage<number>();
  const requireCurrentAttempt = (step: string) => {
    const token = attempt.getStore();
    if (token === undefined) {
      throw new Error(`unsupported @slack/socket-mode client: ${step} outside start()`);
    }
    if (token !== generation) {
      throw new Error("Slack Socket Mode connection attempt was superseded; it will not connect");
    }
  };
  supersedePendingStartsByClient.set(client, () => {
    generation += 1;
  });
  Reflect.set(client, "start", function startNextGeneration(this: object) {
    generation += 1;
    return attempt.run(generation, () => start.call(this));
  });
  Reflect.set(client, "disconnect", function disconnectCurrentGeneration(this: object) {
    generation += 1;
    return disconnect.call(this);
  });
  Reflect.set(client, "retrieveWSSURL", async function retrieveForCurrentAttempt(this: object) {
    const url: unknown = await retrieveWSSURL.call(this);
    requireCurrentAttempt("retrieveWSSURL");
    return url;
  });
  on.call(client, "connecting", () => requireCurrentAttempt("connecting"));
}

/** Make every in-flight start of this client stale, so none of them can connect later. */
function supersedePendingSlackSocketStarts(client: object) {
  supersedePendingStartsByClient.get(client)?.();
}

function createSlackRelayReceiver(): SlackReceiver {
  return {
    init() {},
    start: () => Promise.resolve(undefined),
    stop: () => Promise.resolve(undefined),
  };
}

function resolveSlackBoltModule(value: unknown): SlackBoltResolvedExports | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const app = Reflect.get(value, "App");
  const httpReceiver = Reflect.get(value, "HTTPReceiver");
  const socketModeReceiver = Reflect.get(value, "SocketModeReceiver");
  if (
    !isConstructorFunction<SlackAppConstructor>(app) ||
    !isConstructorFunction<SlackHttpReceiverConstructor>(httpReceiver) ||
    !isConstructorFunction<SlackSocketModeReceiverConstructor>(socketModeReceiver)
  ) {
    return null;
  }
  return {
    App: app,
    HTTPReceiver: httpReceiver,
    SocketModeReceiver: socketModeReceiver,
  };
}

export function resolveSlackBoltInterop(params: {
  defaultImport: unknown;
  namespaceImport: unknown;
}): SlackBoltResolvedExports {
  const { defaultImport, namespaceImport } = params;
  const nestedDefault =
    defaultImport && typeof defaultImport === "object"
      ? Reflect.get(defaultImport, "default")
      : undefined;
  const namespaceDefault =
    namespaceImport && typeof namespaceImport === "object"
      ? Reflect.get(namespaceImport, "default")
      : undefined;
  const namespaceReceiver =
    namespaceImport && typeof namespaceImport === "object"
      ? Reflect.get(namespaceImport, "HTTPReceiver")
      : undefined;
  const namespaceSocketModeReceiver =
    namespaceImport && typeof namespaceImport === "object"
      ? Reflect.get(namespaceImport, "SocketModeReceiver")
      : undefined;
  const directModule =
    resolveSlackBoltModule(defaultImport) ??
    resolveSlackBoltModule(nestedDefault) ??
    resolveSlackBoltModule(namespaceDefault) ??
    resolveSlackBoltModule(namespaceImport);
  if (directModule) {
    return directModule;
  }
  if (
    isConstructorFunction<SlackAppConstructor>(defaultImport) &&
    isConstructorFunction<SlackHttpReceiverConstructor>(namespaceReceiver) &&
    isConstructorFunction<SlackSocketModeReceiverConstructor>(namespaceSocketModeReceiver)
  ) {
    return {
      App: defaultImport,
      HTTPReceiver: namespaceReceiver,
      SocketModeReceiver: namespaceSocketModeReceiver,
    };
  }
  throw new TypeError("Unable to resolve @slack/bolt App/HTTPReceiver exports");
}

export function publishSlackConnectedStatus(
  setStatus?: (next: Record<string, unknown>) => void,
  identityHealth: SlackIdentityHealth = { healthState: "healthy", lastError: null },
) {
  if (!setStatus) {
    return;
  }
  setStatus({
    connected: true,
    lastConnectedAt: Date.now(),
    ...identityHealth,
  });
}

export function publishSlackDisconnectedStatus(
  setStatus?: (next: Record<string, unknown>) => void,
  error?: unknown,
) {
  if (!setStatus) {
    return;
  }
  const at = Date.now();
  const message = error ? formatUnknownError(error) : undefined;
  setStatus({
    connected: false,
    healthState: "disconnected",
    lastDisconnect: message ? { at, error: message } : { at },
    lastError: message ?? null,
  });
}

function isSlackSocketHeartbeatTimeoutWarning(args: readonly unknown[]) {
  return (
    typeof args[0] === "string" &&
    (args[0].startsWith(SLACK_SOCKET_PONG_TIMEOUT_WARNING_PREFIX) ||
      args[0].startsWith(SLACK_SOCKET_PING_TIMEOUT_WARNING_PREFIX))
  );
}

function isSlackSocketSelfInflictedLoggerWarning(args: readonly unknown[]) {
  return typeof args[0] === "string" && SLACK_SOCKET_LOG_LEVEL_IGNORED_WARNING_RE.test(args[0]);
}

function formatSlackSdkLogArgs(args: readonly unknown[]) {
  return args
    .map((arg) => formatUnknownError(arg, ""))
    .filter(Boolean)
    .join(" ");
}

function createSlackSocketModeLogger(
  sink: Pick<typeof console, "debug" | "info" | "warn" | "error"> = console,
): SlackSocketModeLogger {
  let level = "info" as SlackSdkLogLevel;
  let name = "socket-mode";
  const prefix = () => `socket-mode:${name}`;
  let lastMessage: string | undefined;
  const remember = (args: readonly unknown[]) => {
    const message = formatSlackSdkLogArgs([prefix(), ...args]);
    if (message) {
      lastMessage = message;
    }
  };
  return {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      if (
        isSlackSocketHeartbeatTimeoutWarning(args) ||
        isSlackSocketSelfInflictedLoggerWarning(args)
      ) {
        return;
      }
      remember(args);
      sink.warn(prefix(), ...args);
    },
    error: (...args: unknown[]) => {
      remember(args);
      sink.error(prefix(), ...args);
    },
    setLevel: (nextLevel) => {
      level = nextLevel;
    },
    getLevel: () => level,
    setName: (nextName) => {
      name = nextName;
    },
    getLastMessage: () => lastMessage,
  };
}

function shouldSkipOpenClawSlackSelfEvent(args: SlackSelfFilterArgs): boolean {
  const botId = args.context?.botId;
  const botUserId = args.context?.botUserId;
  const message = asRecord(args.message);
  if (message?.subtype === "bot_message" && botId && message.bot_id === botId) {
    return true;
  }

  const event = asRecord(args.event);
  if (
    event?.type === "message" &&
    event.subtype === "message_changed" &&
    event.user === botUserId
  ) {
    return false;
  }

  const eventsWhichShouldBeKept = new Set(["member_joined_channel", "member_left_channel"]);
  return Boolean(
    botUserId &&
    event &&
    event.user === botUserId &&
    typeof event.type === "string" &&
    !eventsWhichShouldBeKept.has(event.type),
  );
}

export function createSlackBoltApp(params: {
  interop: SlackBoltResolvedExports;
  slackMode: "socket" | "http" | "relay";
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  slackWebhookPath: string;
  clientOptions: Record<string, unknown>;
  socketMode?: SlackSocketModeConfig;
  decorateReceiver?: (receiver: SlackReceiver) => SlackReceiver;
}) {
  const socketModeLogger = createSlackSocketModeLogger();
  const socketModeReceiverOptions: SlackSocketModeReceiverOptions = {
    appToken: params.appToken ?? "",
    autoReconnectEnabled: false,
    clientPingTimeout:
      params.socketMode?.clientPingTimeout ?? OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS,
    logger: socketModeLogger,
    installerOptions: {
      // A copy: the SDK mutates its client options, and apps.connections.open needs a timeout.
      clientOptions: { ...params.clientOptions, timeout: SLACK_SOCKET_OPEN_HTTP_TIMEOUT_MS },
    },
  };
  if (params.socketMode?.serverPingTimeout !== undefined) {
    socketModeReceiverOptions.serverPingTimeout = params.socketMode.serverPingTimeout;
  }
  if (params.socketMode?.pingPongLoggingEnabled !== undefined) {
    socketModeReceiverOptions.pingPongLoggingEnabled = params.socketMode.pingPongLoggingEnabled;
  }

  let receiver:
    | InstanceType<SlackSocketModeReceiverConstructor>
    | InstanceType<SlackHttpReceiverConstructor>
    | SlackReceiver
    | undefined;
  if (params.slackMode === "socket") {
    receiver = new params.interop.SocketModeReceiver(socketModeReceiverOptions);
    discardSupersededSlackSocketStarts(receiver);
  } else if (params.slackMode === "http") {
    receiver = new params.interop.HTTPReceiver({
      signingSecret: params.signingSecret ?? "",
      endpoints: params.slackWebhookPath,
    });
  } else {
    receiver = createSlackRelayReceiver();
  }
  if (params.decorateReceiver) receiver = params.decorateReceiver(receiver);
  const app = new params.interop.App({
    token: params.botToken,
    clientOptions: params.clientOptions,
    ignoreSelf: false,
    // Bolt eagerly starts an auth.test promise in the constructor when token
    // verification is enabled. Invalid tokens can reject before any listener
    // consumes that promise, tripping OpenClaw's fatal unhandled-rejection path.
    tokenVerificationEnabled: false,
    ...(receiver ? { receiver } : {}),
  });
  app.use(async (args) => {
    if (shouldSkipOpenClawSlackSelfEvent(args)) {
      return;
    }
    await args.next();
  });
  return { app, receiver, socketModeLogger };
}

function createSlackSocketDisconnectWaiter(app: unknown, abortSignal?: AbortSignal) {
  const waiterAbortController = new AbortController();
  const relayAbort = () => waiterAbortController.abort();
  let latest: SlackSocketDisconnect | undefined;
  abortSignal?.addEventListener("abort", relayAbort, { once: true });
  const promise = waitForSlackSocketDisconnect(app, waiterAbortController.signal).then((value) => {
    latest = value;
    return value;
  });
  return {
    promise,
    getLatest: () => latest,
    cancel: () => {
      waiterAbortController.abort();
      abortSignal?.removeEventListener("abort", relayAbort);
    },
  };
}

export class SlackSocketConnectTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Slack Socket Mode did not connect within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "SlackSocketConnectTimeoutError";
  }
}

/** Resolves "aborted" when the abort signal fires first; the caller's stop cleans up. */
async function awaitSlackSocketStart(
  start: Promise<unknown>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<"started" | "aborted"> {
  // A start that loses the race settles later; its outcome is superseded.
  start.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SlackSocketConnectTimeoutError(timeoutMs)), timeoutMs);
  });
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    if (abortSignal?.aborted) {
      onAbort();
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([start.then(() => "started" as const), deadline, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      abortSignal?.removeEventListener("abort", onAbort);
    }
  }
}

async function waitForSlackSocketLoss(
  app: unknown,
  disconnectWaiter: ReturnType<typeof createSlackSocketDisconnectWaiter>,
  liveness: SlackSocketLivenessOptions,
): Promise<SlackSocketDisconnect> {
  const watcher = watchSlackSocketLiveness(app, liveness);
  try {
    return await Promise.race([disconnectWaiter.promise, watcher.promise]);
  } finally {
    watcher.cancel();
  }
}

export async function startSlackSocketAndWaitForDisconnect(params: {
  app: { start: () => unknown };
  abortSignal?: AbortSignal;
  onStarted?: () => void;
  connectTimeoutMs?: number;
  liveness?: SlackSocketLivenessOptions;
}) {
  const disconnectWaiter = createSlackSocketDisconnectWaiter(params.app, params.abortSignal);
  try {
    const started = await awaitSlackSocketStart(
      Promise.resolve(params.app.start()),
      params.connectTimeoutMs ?? SLACK_SOCKET_CONNECT_TIMEOUT_MS,
      params.abortSignal,
    );
    if (started === "aborted" || params.abortSignal?.aborted) {
      disconnectWaiter.cancel();
      return null;
    }
    params.onStarted?.();
    const disconnect = await waitForSlackSocketLoss(
      params.app,
      disconnectWaiter,
      params.liveness ?? SLACK_SOCKET_LIVENESS,
    );
    disconnectWaiter.cancel();
    return disconnect;
  } catch (err) {
    await Promise.resolve();
    const disconnect = disconnectWaiter.getLatest();
    disconnectWaiter.cancel();
    if (isMissingSocketStartErrorDetail(err) && disconnect?.error !== undefined) {
      throw toLintErrorObject(disconnect.error, "Non-Error thrown");
    }
    if (isMissingSocketStartErrorDetail(err)) {
      const suffix = disconnect ? ` after ${disconnect.event}` : "";
      throw new Error(`Slack Socket Mode start failed${suffix} without error detail`, {
        cause: err,
      });
    }
    throw err;
  }
}

function isMissingSocketStartErrorDetail(err: unknown): boolean {
  return (
    err === undefined || err === null || err === "" || (err instanceof Error && err.message === "")
  );
}

type SlackSocketHandle = { readyState?: number; terminate?: () => void };

function resolveSlackSocketShutdownClient(app: unknown): SlackSocketShutdownClient | undefined {
  if (!app || typeof app !== "object") {
    return undefined;
  }
  const receiver = Reflect.get(app, "receiver");
  if (!receiver || typeof receiver !== "object") {
    return undefined;
  }
  const client = Reflect.get(receiver, "client");
  if (!client || typeof client !== "object") {
    return undefined;
  }
  return client as SlackSocketShutdownClient;
}

/**
 * SlackWebSocket.terminate() calls removeAllListeners() on its ws and then
 * terminates it. Terminating a ws that is still in its handshake makes ws emit
 * an "error"; with no listener that is an uncaught exception, which exits the
 * gateway. So an "error" guard is attached before the termination and re-attached
 * by every removeAllListeners() call made during it: there is no moment when the
 * ws has no error listener. The guard stays on the dead ws afterwards, because
 * ws emits the handshake abort on a later tick.
 */
function terminateSlackWebSocket(socket: SlackSocketHandle & { terminate: () => void }) {
  const ws: unknown = Reflect.get(socket, "websocket");
  const on = ws && typeof ws === "object" ? Reflect.get(ws, "on") : undefined;
  const removeAllListeners =
    ws && typeof ws === "object" ? Reflect.get(ws, "removeAllListeners") : undefined;
  if (typeof on !== "function" || typeof removeAllListeners !== "function") {
    throw new Error("unsupported @slack/socket-mode client: websocket has no underlying ws");
  }
  const target = ws as object;
  const consumeTerminationError = () => {};
  on.call(target, "error", consumeTerminationError);
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, "removeAllListeners");
  const installed = Reflect.defineProperty(target, "removeAllListeners", {
    configurable: true,
    writable: true,
    value: function keepErrorGuard(this: object, ...args: unknown[]) {
      const result: unknown = removeAllListeners.apply(this, args);
      on.call(this, "error", consumeTerminationError);
      return result;
    },
  });
  if (!installed) {
    throw new Error("could not guard the Slack websocket's error listener; not terminating it");
  }
  let terminated: { ok: true } | { ok: false; error: unknown } = { ok: true };
  try {
    socket.terminate();
  } catch (error) {
    terminated = { ok: false, error };
  }
  const restored = ownDescriptor
    ? Reflect.defineProperty(target, "removeAllListeners", ownDescriptor)
    : Reflect.deleteProperty(target, "removeAllListeners");
  if (!terminated.ok) {
    throw terminated.error;
  }
  if (!restored) {
    throw new Error("could not restore the Slack websocket's removeAllListeners");
  }
}

export type SlackSocketStopResult = {
  outcome: "stopped" | "failed" | "timed_out";
  error?: unknown;
  /** The old websocket was still present after stop and was terminated here. */
  forcedClose: boolean;
  /** Terminating the old websocket threw; it may still be open. */
  forceCloseError?: unknown;
  /** app.stop() itself (rejects if it fails), still pending after `outcome` "timed_out". */
  settled: Promise<void>;
};

export class SlackSocketAppDiscardedError extends Error {
  constructor(reason: string) {
    super(`${reason}; discarding this Slack app so the channel restarts with a fresh one`);
    this.name = "SlackSocketAppDiscardedError";
  }
}

/**
 * The same app is reused for the next connection only when its stop is known to be
 * over and no old websocket can survive: app.stop() fulfilled (if it timed out, it
 * must fulfill within `settleTimeoutMs`) and any forced close succeeded. A stop that
 * rejected may still tear down later, and a failed forced close may leave a live
 * socket, so both throw SlackSocketAppDiscardedError, as does a stop still running.
 */
export async function ensureSlackAppReusableAfterStop(
  stop: SlackSocketStopResult,
  settleTimeoutMs = SLACK_SOCKET_STOP_SETTLE_TIMEOUT_MS,
): Promise<void> {
  if (stop.forceCloseError !== undefined) {
    throw new SlackSocketAppDiscardedError("the old Slack websocket could not be terminated");
  }
  if (stop.outcome === "failed") {
    throw new SlackSocketAppDiscardedError("Slack app.stop() failed");
  }
  if (stop.outcome === "stopped") {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), settleTimeoutMs);
  });
  const settled = stop.settled.then(
    () => "stopped" as const,
    () => "failed" as const,
  );
  try {
    const late = await Promise.race([settled, gaveUp]);
    if (late === "hung") {
      throw new SlackSocketAppDiscardedError(
        `Slack app.stop() was still running ${Math.round(settleTimeoutMs / 1000)}s after it timed out`,
      );
    }
    if (late === "failed") {
      throw new SlackSocketAppDiscardedError("Slack app.stop() failed after it timed out");
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function gracefulStopSlackApp(
  app: { stop: () => unknown },
  timeoutMs = SLACK_SOCKET_STOP_TIMEOUT_MS,
): Promise<SlackSocketStopResult> {
  const socketClient = resolveSlackSocketShutdownClient(app);
  if (socketClient) {
    socketClient.shuttingDown = true;
    supersedePendingSlackSocketStarts(socketClient);
  }
  const stopCall = Promise.resolve().then(() => app.stop());
  const stopped = stopCall.then(
    () => ({ outcome: "stopped" as const }),
    (error: unknown) => ({ outcome: "failed" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ outcome: "timed_out" }>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timed_out" }), timeoutMs);
  });
  let outcome: { outcome: SlackSocketStopResult["outcome"]; error?: unknown };
  try {
    outcome = await Promise.race([stopped, timedOut]);
  } finally {
    clearTimeout(timer);
  }
  const result = { ...outcome, settled: stopCall.then(() => undefined) };
  result.settled.catch(() => undefined);
  const socket = socketClient
    ? (Reflect.get(socketClient, "websocket") as SlackSocketHandle | undefined)
    : undefined;
  if (socket?.readyState === undefined || typeof socket.terminate !== "function") {
    return { ...result, forcedClose: false };
  }
  try {
    terminateSlackWebSocket(socket as SlackSocketHandle & { terminate: () => void });
    return { ...result, forcedClose: true };
  } catch (forceCloseError) {
    return { ...result, forcedClose: true, forceCloseError };
  }
}

function formatSlackResolvedLabel(params: {
  input: string;
  id: string;
  name?: string;
  extra?: string[];
}): string | null {
  const extras = params.extra?.filter(Boolean) ?? [];
  const display = params.name ?? params.id;
  if (params.input === params.id && !params.name && extras.length === 0) {
    // An id that resolved to itself with no display name says nothing; omit it
    // so startup summaries only list lookups that translated something. Bare
    // names that resolved to an id stay logged even when name === input.
    return null;
  }
  // Show the raw id only when neither the input nor the display already is it.
  const details = [
    ...(params.input === params.id || display === params.id ? [] : [`id:${params.id}`]),
    ...extras,
  ];
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `${params.input}→${display}${suffix}`;
}

export function formatSlackChannelResolved(entry: SlackChannelResolution): string | null {
  const id = entry.id ?? entry.input;
  return formatSlackResolvedLabel({
    input: entry.input,
    id,
    name: entry.name,
    extra: entry.archived ? ["archived"] : [],
  });
}

export function formatSlackUserResolved(entry: SlackUserResolution): string | null {
  const id = entry.id ?? entry.input;
  return formatSlackResolvedLabel({
    input: entry.input,
    id,
    name: entry.name,
    extra: entry.note ? [entry.note] : [],
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
