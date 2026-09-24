// Slack tests cover provider.reconnect plugin behavior.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gracefulStopSlackApp,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  SlackSocketConnectTimeoutError,
  ensureSlackAppReusableAfterStop,
  SlackSocketAppDiscardedError,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import {
  formatSlackSocketModeSharedConnectionWarning,
  formatUnknownError,
  registerSlackSocketModeConnectionDiagnostics,
  waitForSlackSocketDisconnect,
  watchSlackSocketLiveness,
} from "./reconnect-policy.js";

class FakeEmitter {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void) {
    const bucket = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeSocketClient extends FakeEmitter {
  open = true;
  websocket = { isActive: () => this.open };
}

function expectNoSocketListeners(client: FakeEmitter) {
  expect(client.listenerCount("disconnected")).toBe(0);
  expect(client.listenerCount("error")).toBe(0);
}

function statusCallAt(setStatus: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const call = setStatus.mock.calls[index];
  if (!call) {
    throw new Error(`expected status call ${index}`);
  }
  const [status] = call;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error(`expected status call ${index} payload`);
  }
  return status as Record<string, unknown>;
}

describe("slack socket reconnect helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("marks socket mode healthy without seeding event liveness on connect", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_400_000);

    publishSlackConnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    const status = statusCallAt(setStatus, 0);
    expect(status?.connected).toBe(true);
    expect(status?.lastConnectedAt).toBe(1_711_406_400_000);
    expect(status?.healthState).toBe("healthy");
    expect(status?.lastError).toBeNull();
    expect(status).not.toHaveProperty("lastEventAt");
  });

  it("marks socket mode degraded when boot identity is unavailable", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_400_500);

    publishSlackConnectedStatus(setStatus, {
      healthState: "degraded",
      lastError: "auth.test returned no user_id",
    });

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: 1_711_406_400_500,
      healthState: "degraded",
      lastError: "auth.test returned no user_id",
    });
  });

  it("marks socket mode disconnected when an error closes the socket", () => {
    const setStatus = vi.fn();
    const err = new Error("dns down");
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_401_000);

    publishSlackDisconnectedStatus(setStatus, err);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      healthState: "disconnected",
      lastDisconnect: {
        at: 1_711_406_401_000,
        error: "dns down",
      },
      lastError: "dns down",
    });
  });

  it("marks socket mode disconnected without error when the socket closes cleanly", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_402_000);

    publishSlackDisconnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      healthState: "disconnected",
      lastDisconnect: {
        at: 1_711_406_402_000,
      },
      lastError: null,
    });
  });

  it("formats missing and unserializable socket errors without leaking undefined", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatUnknownError(undefined)).toBe("no error detail");
    expect(formatUnknownError(null)).toBe("no error detail");
    expect(formatUnknownError("")).toBe("no error detail");
    expect(formatUnknownError(new Error(""))).toBe("Error");
    expect(formatUnknownError(circular)).toBe('{"self":"[Circular]"}');
  });

  it("formats structured Slack socket errors", () => {
    expect(
      formatUnknownError({
        code: "slack_webapi_platform_error",
        data: {
          error: "missing_scope",
          needed: "connections:write",
          response_metadata: {
            messages: ["[ERROR] missing required scope"],
          },
        },
      }),
    ).toBe(
      "code: slack_webapi_platform_error; slack error: missing_scope; needed: connections:write; slack message: [ERROR] missing required scope",
    );
  });

  it("formats shared Socket Mode connection warnings with remediation", () => {
    expect(formatSlackSocketModeSharedConnectionWarning(2)).toContain(
      "slack socket mode reports 2 active connections for this Slack app",
    );
    expect(formatSlackSocketModeSharedConnectionWarning(2)).toContain(
      "equivalent routing and authorization",
    );
  });

  it("warns once when Slack reports a shared Socket Mode app token", () => {
    const client = new FakeEmitter();
    const onSharedConnection = vi.fn();
    const unregister = registerSlackSocketModeConnectionDiagnostics({
      app: { receiver: { client } },
      onSharedConnection,
    });

    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "events_api", payload: { text: "hello" } })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: "2" })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 1 })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 2 })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 3 })),
      false,
    );

    expect(onSharedConnection).toHaveBeenCalledTimes(1);
    expect(onSharedConnection).toHaveBeenCalledWith(2);

    unregister();
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 2 })),
      false,
    );
    expect(onSharedConnection).toHaveBeenCalledTimes(1);
    expect(client.listenerCount("ws_message")).toBe(0);
  });

  it("resolves disconnect waiter on socket disconnect event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("disconnected");

    await expect(waiter).resolves.toEqual({ event: "disconnect" });
  });

  it("resolves disconnect waiter on socket error event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };
    const err = new Error("dns down");

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("error", err);

    await expect(waiter).resolves.toEqual({ event: "error", error: err });
  });

  it("installs the disconnect waiter before socket start completes", async () => {
    const client = new FakeSocketClient();
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(async () => {
        client.emit("disconnected");
      }),
    };
    const onStarted = vi.fn();

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted,
      }),
    ).resolves.toEqual({ event: "disconnect" });

    expect(app.start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("cancels the disconnect waiter when onStarted throws", async () => {
    const client = new FakeEmitter();
    const app = {
      receiver: { client },
      start: vi.fn().mockResolvedValue(undefined),
    };
    const err = new Error("status sink failed");

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted: () => {
          throw err;
        },
      }),
    ).rejects.toThrow("status sink failed");

    expectNoSocketListeners(client);
  });

  it("uses the socket error when Bolt rejects without detail", async () => {
    const client = new FakeEmitter();
    const err = new Error("missing_scope");
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(() => {
        client.emit("error", err);
        throw new Error();
      }),
    };

    await expect(startSlackSocketAndWaitForDisconnect({ app: app as never })).rejects.toThrow(
      "missing_scope",
    );

    expectNoSocketListeners(client);
  });

  it("fails a start that never connects at the connect deadline", async () => {
    vi.useFakeTimers();
    const client = new FakeEmitter();
    const app = { receiver: { client }, start: vi.fn(() => new Promise(() => {})) };
    const onStarted = vi.fn();

    const run = startSlackSocketAndWaitForDisconnect({
      app: app as never,
      onStarted,
      connectTimeoutMs: 90_000,
    });
    const outcome = expect(run).rejects.toBeInstanceOf(SlackSocketConnectTimeoutError);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(client.listenerCount("disconnected")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;

    expect(onStarted).not.toHaveBeenCalled();
    expectNoSocketListeners(client);
  });

  it("does not surface a superseded start's late rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectStart: ((err: Error) => void) | undefined;
      const client = new FakeEmitter();
      const app = {
        receiver: { client },
        start: vi.fn(
          () =>
            new Promise((_, reject) => {
              rejectStart = reject;
            }),
        ),
      };
      const run = startSlackSocketAndWaitForDisconnect({ app: app as never, connectTimeoutMs: 10 });
      const outcome = expect(run).rejects.toBeInstanceOf(SlackSocketConnectTimeoutError);
      await vi.advanceTimersByTimeAsync(10);
      await outcome;
      rejectStart?.(new Error("late failure"));
      vi.useRealTimers();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("reports a connected socket whose websocket stops being open as stalled", async () => {
    vi.useFakeTimers();
    const client = new FakeSocketClient();
    const app = { receiver: { client }, start: vi.fn().mockResolvedValue(undefined) };
    const liveness = { checkIntervalMs: 5_000, staleAfterMs: 60_000 };

    const run = startSlackSocketAndWaitForDisconnect({ app: app as never, liveness });
    const settled = vi.fn();
    void run.then(settled);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).not.toHaveBeenCalled();

    client.open = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    const disconnect = await run;
    expect(disconnect?.event).toBe("stalled");
    expect(formatUnknownError(disconnect?.error)).toContain("websocket not open for 60s");
    expectNoSocketListeners(client);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the stall clock when the websocket reopens", async () => {
    vi.useFakeTimers();
    const client = new FakeSocketClient();
    const watcher = watchSlackSocketLiveness(
      { receiver: { client } },
      { checkIntervalMs: 5_000, staleAfterMs: 60_000 },
    );
    const settled = vi.fn();
    void watcher.promise.then(settled);

    client.open = false;
    await vi.advanceTimersByTimeAsync(55_000);
    client.open = true;
    await vi.advanceTimersByTimeAsync(5_000);
    client.open = false;
    await vi.advanceTimersByTimeAsync(55_000);
    expect(settled).not.toHaveBeenCalled();

    watcher.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails loudly when the client exposes no websocket after start", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client }, start: vi.fn().mockResolvedValue(undefined) };

    await expect(startSlackSocketAndWaitForDisconnect({ app: app as never })).rejects.toThrow(
      "unsupported @slack/socket-mode client",
    );
    expectNoSocketListeners(client);
  });

  it("returns promptly when the gateway aborts during a hung start", async () => {
    vi.useFakeTimers();
    const client = new FakeEmitter();
    const controller = new AbortController();
    const app = { receiver: { client }, start: vi.fn(() => new Promise(() => {})) };

    const run = startSlackSocketAndWaitForDisconnect({
      app: app as never,
      abortSignal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();

    await expect(run).resolves.toBeNull();
    expectNoSocketListeners(client);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops watching liveness once the socket disconnects", async () => {
    vi.useFakeTimers();
    const client = new FakeSocketClient();
    const app = { receiver: { client }, start: vi.fn().mockResolvedValue(undefined) };

    const run = startSlackSocketAndWaitForDisconnect({ app: app as never });
    await vi.advanceTimersByTimeAsync(0);
    client.emit("disconnected");

    await expect(run).resolves.toEqual({ event: "disconnect" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports the reason of a Slack disconnect envelope", () => {
    const client = new FakeEmitter();
    const onDisconnectRequested = vi.fn();
    const onSharedConnection = vi.fn();
    registerSlackSocketModeConnectionDiagnostics({
      app: { receiver: { client } },
      onSharedConnection,
      onDisconnectRequested,
    });

    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "events_api", payload: { text: '"disconnect"' } })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "disconnect", reason: "too_many_websockets" })),
      false,
    );
    client.emit("ws_message", Buffer.from(JSON.stringify({ type: "disconnect" })), false);

    expect(onDisconnectRequested.mock.calls).toEqual([["too_many_websockets"], ["unspecified"]]);
    expect(onSharedConnection).not.toHaveBeenCalled();
  });

  it("marks the socket client as shutting down before stop runs", async () => {
    const app = {
      receiver: { client: { shuttingDown: false } },
      stop: vi.fn().mockImplementation(async () => {
        expect(app.receiver.client.shuttingDown).toBe(true);
      }),
    };

    await expect(gracefulStopSlackApp(app)).resolves.toMatchObject({
      outcome: "stopped",
      forcedClose: false,
    });

    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(app.receiver.client.shuttingDown).toBe(true);
  });

  it("terminates the websocket a hung stop left open without an unhandled error", async () => {
    vi.useFakeTimers();
    // Like SlackWebSocket.terminate() on a ws still in its handshake: all listeners are
    // removed and ws reports the abort as "error". The fake emits at every point
    // (before and after the removal, and a tick later) so no window goes untested.
    const ws = new EventEmitter();
    const abort = () => new Error("closed before the connection was established");
    const terminate = vi.fn(() => {
      ws.emit("error", abort());
      ws.removeAllListeners();
      ws.emit("error", abort());
      process.nextTick(() => ws.emit("error", abort()));
    });
    const app = {
      receiver: {
        client: { shuttingDown: false, websocket: { readyState: 0, terminate, websocket: ws } },
      },
      stop: vi.fn(() => new Promise(() => {})),
    };

    const stop = gracefulStopSlackApp(app, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await stop;

    expect(result).toMatchObject({ outcome: "timed_out", forcedClose: true });
    expect(result.forceCloseError).toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => {
      process.nextTick(resolve);
    });
    expect(ws.listenerCount("error")).toBe(1);
    expect(Object.hasOwn(ws, "removeAllListeners")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores a websocket's own removeAllListeners after the forced close", async () => {
    const ws = new EventEmitter();
    const ownRemoveAll = function (this: EventEmitter, ...args: [string?]) {
      return EventEmitter.prototype.removeAllListeners.apply(this, args);
    };
    Object.defineProperty(ws, "removeAllListeners", {
      configurable: true,
      writable: true,
      value: ownRemoveAll,
    });
    const app = {
      receiver: {
        client: {
          websocket: { readyState: 1, websocket: ws, terminate: () => ws.removeAllListeners() },
        },
      },
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const result = await gracefulStopSlackApp(app);

    expect(result).toMatchObject({ outcome: "stopped", forcedClose: true });
    expect(result.forceCloseError).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(ws, "removeAllListeners")?.value).toBe(ownRemoveAll);
    expect(ws.listenerCount("error")).toBe(1);
  });

  it("reports a websocket that could not be terminated instead of throwing", async () => {
    const err = new Error("terminate exploded");
    const app = {
      receiver: {
        client: {
          websocket: {
            readyState: 1,
            websocket: new EventEmitter(),
            terminate: () => {
              throw err;
            },
          },
        },
      },
      stop: vi.fn().mockResolvedValue(undefined),
    };

    await expect(gracefulStopSlackApp(app)).resolves.toMatchObject({
      outcome: "stopped",
      forcedClose: true,
      forceCloseError: err,
    });
  });

  it("refuses to force-close a websocket whose underlying ws it cannot see", async () => {
    const terminate = vi.fn();
    const app = {
      receiver: { client: { websocket: { readyState: 1, terminate } } },
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const stop = await gracefulStopSlackApp(app);

    expect(stop).toMatchObject({ outcome: "stopped", forcedClose: true });
    expect(String(stop.forceCloseError)).toContain("websocket has no underlying ws");
    expect(terminate).not.toHaveBeenCalled();
  });

  it("reports a failing stop with its error and leaves a closed websocket alone", async () => {
    const err = new Error("already closed");
    const terminate = vi.fn();
    const app = {
      receiver: { client: { websocket: { readyState: undefined, terminate } } },
      stop: vi.fn().mockRejectedValue(err),
    };

    const result = await gracefulStopSlackApp(app);
    expect(result).toMatchObject({ outcome: "failed", error: err, forcedClose: false });
    await expect(result.settled).rejects.toThrow("already closed");
    expect(terminate).not.toHaveBeenCalled();
  });
});

describe("ensureSlackAppReusableAfterStop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const never = () => new Promise<void>(() => {});

  it("reuses the app after a clean stop", async () => {
    await expect(
      ensureSlackAppReusableAfterStop({ outcome: "stopped", forcedClose: true, settled: never() }),
    ).resolves.toBeUndefined();
  });

  it("discards the app when the stop failed or the old websocket survived", async () => {
    const failed = Promise.reject(new Error("stop failed"));
    failed.catch(() => undefined);
    await expect(
      ensureSlackAppReusableAfterStop({ outcome: "failed", forcedClose: false, settled: failed }),
    ).rejects.toThrow("Slack app.stop() failed; discarding this Slack app");
    await expect(
      ensureSlackAppReusableAfterStop({
        outcome: "stopped",
        forcedClose: true,
        forceCloseError: new Error("terminate exploded"),
        settled: Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(SlackSocketAppDiscardedError);
  });

  it("waits for a timed-out stop that finishes late", async () => {
    vi.useFakeTimers();
    let finish = () => {};
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const done = vi.fn();
    void ensureSlackAppReusableAfterStop(
      { outcome: "timed_out", forcedClose: false, settled },
      20_000,
    ).then(done);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(done).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards the app when a timed-out stop never finishes or fails late", async () => {
    vi.useFakeTimers();
    let failLate = (_err: Error) => {};
    const lateFailure = new Promise<void>((_, reject) => {
      failLate = reject;
    });
    const hung = ensureSlackAppReusableAfterStop(
      { outcome: "timed_out", forcedClose: false, settled: never() },
      20_000,
    );
    const failedLate = ensureSlackAppReusableAfterStop(
      { outcome: "timed_out", forcedClose: false, settled: lateFailure },
      20_000,
    );
    const hungRejected = expect(hung).rejects.toThrow("still running 20s after it timed out");
    const lateRejected = expect(failedLate).rejects.toThrow("failed after it timed out");
    failLate(new Error("late"));
    await vi.advanceTimersByTimeAsync(20_000);
    await hungRejected;
    await lateRejected;
  });
});
