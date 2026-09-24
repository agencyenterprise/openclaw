// Slack tests cover provider reconnect loop behavior.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackClient, getSlackTestState, resetSlackTestState } from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");
const { SlackSocketAppDiscardedError } = await import("./provider-support.js");
const slackTestState = getSlackTestState();

describe("slack socket reconnect loop", () => {
  beforeEach(() => {
    resetSlackTestState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["network error", () => new Error("ECONNRESET")],
    [
      "Slack Web API request error",
      () =>
        Object.assign(new Error("Slack Web API request error"), {
          code: "slack_webapi_request_error",
          original: new Error("ECONNRESET"),
        }),
    ],
    [
      "Slack Web API HTTP error",
      () =>
        Object.assign(new Error("Slack Web API HTTP error"), {
          code: "slack_webapi_http_error",
          statusCode: 503,
          statusMessage: "Service Unavailable",
        }),
    ],
  ])(
    "continues after thirteen consecutive recoverable %s failures",
    async (_label, createError) => {
      const controller = new AbortController();
      const runtimeError = vi.fn();
      let attempts = 0;
      slackTestState.appStartMock.mockImplementation(async () => {
        attempts += 1;
        if (attempts <= 13) {
          throw createError();
        }
        controller.abort();
      });

      const run = monitorSlackProvider({
        botToken: "bot-token",
        appToken: "app-token",
        abortSignal: controller.signal,
        config: slackTestState.config,
        runtime: {
          log: vi.fn(),
          error: runtimeError,
          exit: vi.fn(),
        },
      });

      await vi.runAllTimersAsync();
      await expect(run).resolves.toBeUndefined();

      expect(slackTestState.appStartMock).toHaveBeenCalledTimes(14);
      expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("retry 13/∞"));
    },
  );

  it("includes the configured Socket Mode logger context in start retry diagnostics", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const runtimeError = vi.fn();
    let attempts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        slackTestState.socketModeLogger?.error("failed to retrieve WSS URL", {
          data: { error: "missing_scope", needed: "connections:write" },
        });
        throw new Error();
      }
      controller.abort();
    });

    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime: {
        log: vi.fn(),
        error: runtimeError,
        exit: vi.fn(),
      },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();

    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining(
        "last SDK log: socket-mode:socket-mode failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
      ),
    );
  });

  function emitSocketEvent(event: string, ...args: unknown[]) {
    const listeners = (slackTestState.socketModeClient?.on.mock.calls ?? [])
      .filter(([name]) => name === event)
      .map(([, listener]) => listener);
    const latest = listeners.at(-1);
    if (!latest) {
      throw new Error(`no ${event} listener registered`);
    }
    latest(...args);
  }

  it("reconnects itself after the connected socket closes", async () => {
    const controller = new AbortController();
    const log = vi.fn();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime: { log, error: vi.fn(), exit: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("slack socket mode connected");

    emitSocketEvent("disconnected");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(slackTestState.appStopMock).toHaveBeenCalledTimes(1);
    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("slack socket disconnected (disconnect); reconnecting in"),
    );
    expect(log).toHaveBeenCalledWith("slack socket mode connected (reconnect 1)");

    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });

  it("abandons a start that never connects and starts a fresh connection", async () => {
    const controller = new AbortController();
    const runtimeError = vi.fn();
    const log = vi.fn();
    slackTestState.appStartMock.mockImplementationOnce(() => new Promise(() => {}));

    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime: { log, error: runtimeError, exit: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(89_000);
    expect(slackTestState.appStopMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("Slack Socket Mode did not connect within 90s"),
    );
    expect(slackTestState.appStopMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("slack socket mode connected");

    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });

  function startMonitor(controller: AbortController, log = vi.fn(), error = vi.fn()) {
    return monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime: { log, error, exit: vi.fn() },
    });
  }

  it("does not restart the app until a timed-out stop has finished", async () => {
    const controller = new AbortController();
    const runtimeError = vi.fn();
    let stopFinishedAt: number | undefined;
    const startedAt: number[] = [];
    slackTestState.appStartMock.mockImplementation(async () => {
      startedAt.push(Date.now());
    });
    slackTestState.appStopMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            stopFinishedAt = Date.now();
            resolve();
          }, 15_000);
        }),
    );
    const run = startMonitor(controller, vi.fn(), runtimeError);

    await vi.advanceTimersByTimeAsync(0);
    emitSocketEvent("disconnected");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(startedAt).toHaveLength(1);
    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("slack socket mode stop timed_out"),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(startedAt).toHaveLength(2);
    expect(startedAt[1]).toBeGreaterThanOrEqual(stopFinishedAt ?? Number.POSITIVE_INFINITY);

    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });

  it("gives up the app when a timed-out stop never finishes", async () => {
    const controller = new AbortController();
    const runtimeError = vi.fn();
    slackTestState.appStopMock.mockImplementation(() => new Promise(() => {}));
    const outcome = startMonitor(controller, vi.fn(), runtimeError).then(
      () => "resolved",
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(0);
    emitSocketEvent("disconnected");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await outcome).toBeInstanceOf(SlackSocketAppDiscardedError);
    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(1);
    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("was still running 20s after it timed out"),
    );
  });

  it.each([
    [
      "app.stop() rejects",
      () => {
        slackTestState.appStopMock.mockRejectedValue(new Error("stop failed"));
      },
      "Slack app.stop() failed",
    ],
    [
      "the old websocket cannot be terminated",
      () => {
        Object.assign(slackTestState.socketModeClient ?? {}, {
          websocket: {
            readyState: 1,
            websocket: new EventEmitter(),
            terminate: () => {
              throw new Error("terminate exploded");
            },
          },
        });
      },
      "the old Slack websocket could not be terminated",
    ],
  ])("gives up the app when %s", async (_label, breakStop, reason) => {
    const controller = new AbortController();
    const runtimeError = vi.fn();
    const outcome = startMonitor(controller, vi.fn(), runtimeError).then(
      () => "resolved",
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(0);
    breakStop();
    emitSocketEvent("disconnected");
    await vi.advanceTimersByTimeAsync(60_000);

    const err = await outcome;
    expect(err).toBeInstanceOf(SlackSocketAppDiscardedError);
    expect(String(err)).toContain(reason);
    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(1);
  });

  it("keeps degraded identity health after a recoverable reconnect", async () => {
    getSlackClient().auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UUSER",
      team_id: "T1",
      is_enterprise_install: false,
    });
    const controller = new AbortController();
    const setStatus = vi.fn();
    let attempts = 0;
    let resolveSecondStart: (() => void) | undefined;
    const secondStart = new Promise<void>((resolve) => {
      resolveSecondStart = resolve;
    });
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("ECONNRESET");
      }
      resolveSecondStart?.();
    });

    const run = monitorSlackProvider({
      botToken: "bot",
      appToken: "app",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      setStatus,
    });

    await vi.runOnlyPendingTimersAsync();
    await secondStart;
    await Promise.resolve();
    await Promise.resolve();

    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      healthState: "degraded",
      lastError: expect.stringContaining("without bot_id"),
    });
    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });
});
