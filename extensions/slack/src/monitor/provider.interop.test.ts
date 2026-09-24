// Slack tests cover provider.interop plugin behavior.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createSlackBoltApp,
  gracefulStopSlackApp,
  resolveSlackBoltInterop,
} from "./provider-support.js";

describe("resolveSlackBoltInterop", () => {
  function FakeApp() {}
  function FakeHTTPReceiver() {}
  function FakeSocketModeReceiver() {}

  it("uses the default import when it already exposes named exports", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: {
        App: FakeApp,
        HTTPReceiver: FakeHTTPReceiver,
        SocketModeReceiver: FakeSocketModeReceiver,
      },
      namespaceImport: {},
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("uses nested default export when the default import is a wrapper object", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: {
        default: {
          App: FakeApp,
          HTTPReceiver: FakeHTTPReceiver,
          SocketModeReceiver: FakeSocketModeReceiver,
        },
      },
      namespaceImport: {},
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("uses the namespace receiver when the default import is the App constructor itself", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: FakeApp,
      namespaceImport: {
        HTTPReceiver: FakeHTTPReceiver,
        SocketModeReceiver: FakeSocketModeReceiver,
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("uses namespace.default when it exposes named exports", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: undefined,
      namespaceImport: {
        default: {
          App: FakeApp,
          HTTPReceiver: FakeHTTPReceiver,
          SocketModeReceiver: FakeSocketModeReceiver,
        },
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("falls back to the namespace import when it exposes named exports", () => {
    const resolved = resolveSlackBoltInterop({
      defaultImport: undefined,
      namespaceImport: {
        App: FakeApp,
        HTTPReceiver: FakeHTTPReceiver,
        SocketModeReceiver: FakeSocketModeReceiver,
      },
    });

    expect(resolved).toEqual({
      App: FakeApp,
      HTTPReceiver: FakeHTTPReceiver,
      SocketModeReceiver: FakeSocketModeReceiver,
    });
  });

  it("throws when the module cannot be resolved", () => {
    expect(() =>
      resolveSlackBoltInterop({
        defaultImport: null,
        namespaceImport: {},
      }),
    ).toThrow("Unable to resolve @slack/bolt App/HTTPReceiver exports");
  });
});

describe("createSlackBoltApp", () => {
  class FakeApp {
    args: Record<string, unknown>;
    middleware: unknown[] = [];

    constructor(args: Record<string, unknown>) {
      this.args = args;
    }

    use(middleware: unknown) {
      this.middleware.push(middleware);
      return this;
    }
  }

  class FakeHTTPReceiver {
    args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
    }
  }

  class FakeSocketModeClient {
    start = vi.fn();
    disconnect = vi.fn();
    retrieveWSSURL = vi.fn();
    on = vi.fn();
    off = vi.fn();
  }

  class FakeSocketModeReceiver {
    args: Record<string, unknown>;
    client = new FakeSocketModeClient();

    constructor(args: Record<string, unknown>) {
      this.args = args;
    }
  }

  it("uses SocketModeReceiver without native reconnects and a bounded socket client", () => {
    const clientOptions = { teamId: "T1" };
    const { app, receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions,
    });

    expect(receiver).toBeInstanceOf(FakeSocketModeReceiver);
    const receiverArgs = (receiver as unknown as FakeSocketModeReceiver).args;
    const receiverLogger = receiverArgs.logger as { error?: unknown; warn?: unknown };
    expect(receiverLogger.error).toBeTypeOf("function");
    expect(receiverLogger.warn).toBeTypeOf("function");
    expect(receiverArgs).toEqual({
      appToken: "xapp-test",
      autoReconnectEnabled: false,
      clientPingTimeout: 15_000,
      logger: receiverLogger,
      installerOptions: {
        clientOptions: { teamId: "T1", timeout: 20_000 },
      },
    });
    expect(clientOptions).toEqual({ teamId: "T1" });
    expect(app).toBeInstanceOf(FakeApp);
    expect((app as unknown as FakeApp).args).toEqual({
      token: "xoxb-test",
      receiver,
      clientOptions,
      ignoreSelf: false,
      tokenVerificationEnabled: false,
    });
    expect((app as unknown as FakeApp).middleware).toHaveLength(1);
  });

  it("filters Socket Mode noise and retains SDK errors through the configured receiver logger", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { receiver, socketModeLogger } = createSlackBoltApp({
        interop: {
          App: FakeApp as never,
          HTTPReceiver: FakeHTTPReceiver as never,
          SocketModeReceiver: FakeSocketModeReceiver as never,
        },
        slackMode: "socket",
        botToken: "xoxb-test",
        appToken: "xapp-test",
        slackWebhookPath: "/slack/events",
        clientOptions: {},
      });
      const receiverLogger = (receiver as unknown as FakeSocketModeReceiver).args.logger;
      expect(receiverLogger).toBe(socketModeLogger);

      socketModeLogger.setName("SlackWebSocket:1");
      socketModeLogger.warn(
        "A pong wasn't received from the server before the timeout of 15000ms!",
      );
      socketModeLogger.warn(
        "A ping wasn't received from the server before the timeout of 30000ms!",
      );
      socketModeLogger.warn(
        "The logLevel given to Socket Mode was ignored as you also gave logger",
      );
      socketModeLogger.warn("another socket warning");
      socketModeLogger.error("failed to retrieve WSS URL", {
        data: { error: "missing_scope", needed: "connections:write" },
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("socket-mode:SlackWebSocket:1", "another socket warning");
      expect(error).toHaveBeenCalledTimes(1);
      expect(socketModeLogger.getLastMessage()).toBe(
        "socket-mode:SlackWebSocket:1 failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("applies OpenClaw self-event filtering through installed Bolt middleware", async () => {
    const { app } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });
    const middleware = (app as unknown as FakeApp).middleware[0] as
      | ((args: {
          next: () => Promise<void>;
          context?: { botId?: string; botUserId?: string };
          event?: unknown;
          message?: unknown;
        }) => Promise<void>)
      | undefined;
    if (!middleware) {
      throw new Error("expected Slack self-event middleware");
    }

    const cases = [
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "reaction_added", user: "U_BOT" },
        },
        forwarded: false,
      },
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "message", subtype: "message_changed", user: "U_BOT" },
        },
        forwarded: true,
      },
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "message", user: "U_BOT" },
        },
        forwarded: false,
      },
      {
        args: {
          context: { botUserId: "U_BOT", botId: "B_BOT" },
          event: { type: "message", user: "U_OTHER" },
          message: { subtype: "bot_message", bot_id: "B_BOT" },
        },
        forwarded: false,
      },
    ] as const;

    for (const testCase of cases) {
      const next = vi.fn(async () => {});
      await middleware({ ...testCase.args, next });
      expect(next).toHaveBeenCalledTimes(testCase.forwarded ? 1 : 0);
    }
  });

  it("refuses a Socket Mode client without the methods the reconnect guard needs", () => {
    class FakeBareSocketModeReceiver {
      client = { start: vi.fn(), on: vi.fn(), off: vi.fn() };
    }
    expect(() =>
      createSlackBoltApp({
        interop: {
          App: FakeApp as never,
          HTTPReceiver: FakeHTTPReceiver as never,
          SocketModeReceiver: FakeBareSocketModeReceiver as never,
        },
        slackMode: "socket",
        botToken: "xoxb-test",
        appToken: "xapp-test",
        slackWebhookPath: "/slack/events",
        clientOptions: {},
      }),
    ).toThrow("unsupported @slack/socket-mode client");
  });

  function createGuardedSocketClient() {
    const urlRequests: Array<(url: string) => void> = [];
    const assignGates: Array<Promise<void>> = [];
    // Mirrors SocketModeClient.start(): fetch the URL, assign the websocket,
    // emit "connecting", then connect.
    class FakeGuardedSocketModeClient extends EventEmitter {
      opened: string[] = [];
      disconnects = 0;
      websocket: { options: { url: string } } | null = null;

      retrieveWSSURL() {
        return new Promise<string>((resolve) => {
          urlRequests.push(resolve);
        });
      }

      async start() {
        const url = await this.retrieveWSSURL();
        await assignGates.shift();
        this.websocket = { options: { url } };
        this.emit("connecting");
        this.opened.push(url);
      }

      async disconnect() {
        this.disconnects += 1;
      }
    }
    class FakeGuardedSocketModeReceiver {
      args: Record<string, unknown>;
      client = new FakeGuardedSocketModeClient();

      constructor(args: Record<string, unknown>) {
        this.args = args;
      }
    }
    const { receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeGuardedSocketModeReceiver as never,
      },
      slackMode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });
    const client = (receiver as unknown as FakeGuardedSocketModeReceiver).client;
    return { client, receiver, urlRequests, assignGates };
  }

  it("discards a WSS URL fetched for a superseded socket start", async () => {
    const { client, urlRequests } = createGuardedSocketClient();

    const stoppedStart = client.start();
    await client.disconnect();
    urlRequests[0]?.("wss://stopped");
    await expect(stoppedStart).rejects.toThrow("superseded");

    const olderStart = client.start();
    const newerStart = client.start();
    urlRequests[1]?.("wss://older");
    urlRequests[2]?.("wss://newer");
    await expect(olderStart).rejects.toThrow("superseded");
    await expect(newerStart).resolves.toBeUndefined();

    expect(client.opened).toEqual(["wss://newer"]);
    expect(client.disconnects).toBe(1);
  });

  it("keeps a current start valid when a stale start returns the same URL", async () => {
    const { client, urlRequests, assignGates } = createGuardedSocketClient();
    let releaseAssign = () => {};
    assignGates.push(
      new Promise<void>((resolve) => {
        releaseAssign = resolve;
      }),
    );

    const olderStart = client.start();
    const newerStart = client.start();
    urlRequests[1]?.("wss://same");
    await vi.waitFor(() => expect(assignGates).toHaveLength(0));
    urlRequests[0]?.("wss://same");
    await expect(olderStart).rejects.toThrow("superseded");
    releaseAssign();

    await expect(newerStart).resolves.toBeUndefined();
    expect(client.opened).toEqual(["wss://same"]);
  });

  it("refuses to connect a start superseded after its URL was accepted", async () => {
    const { client, urlRequests, assignGates } = createGuardedSocketClient();
    let releaseAssign = () => {};
    assignGates.push(
      new Promise<void>((resolve) => {
        releaseAssign = resolve;
      }),
    );

    const start = client.start();
    urlRequests[0]?.("wss://accepted-then-superseded");
    await vi.waitFor(() => expect(assignGates).toHaveLength(0));
    await client.disconnect();
    releaseAssign();

    await expect(start).rejects.toThrow("superseded");
    expect(client.opened).toEqual([]);
  });

  it("makes a pending start stale as soon as the app is stopped", async () => {
    const { client, receiver, urlRequests } = createGuardedSocketClient();
    const app = { receiver, stop: vi.fn(() => new Promise(() => {})) };

    const start = client.start();
    const stop = gracefulStopSlackApp(app, 5);
    urlRequests[0]?.("wss://late-after-stop");

    await expect(start).rejects.toThrow("superseded");
    await expect(stop).resolves.toMatchObject({ outcome: "timed_out", forcedClose: false });
    expect(client.opened).toEqual([]);
  });

  it("fails loudly when the client connects outside start()", async () => {
    const { client } = createGuardedSocketClient();

    expect(() => client.emit("connecting")).toThrow(
      "unsupported @slack/socket-mode client: connecting outside start()",
    );
  });

  it("refuses a stale start that got the same URL as the current one", async () => {
    const { client, urlRequests, assignGates } = createGuardedSocketClient();
    let releaseOld = () => {};
    assignGates.push(
      new Promise<void>((resolve) => {
        releaseOld = resolve;
      }),
    );

    const olderStart = client.start();
    urlRequests[0]?.("wss://same");
    await vi.waitFor(() => expect(assignGates).toHaveLength(0));
    const newerStart = client.start();
    urlRequests[1]?.("wss://same");
    await expect(newerStart).resolves.toBeUndefined();
    releaseOld();

    await expect(olderStart).rejects.toThrow("superseded");
    expect(client.opened).toEqual(["wss://same"]);
  });

  it("passes Socket Mode ping/pong options through Slack's public receiver API", () => {
    const clientOptions = { teamId: "T1" };
    const { receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions,
      socketMode: {
        clientPingTimeout: 20_000,
        serverPingTimeout: 45_000,
        pingPongLoggingEnabled: true,
      },
    });

    const receiverArgs = (receiver as unknown as FakeSocketModeReceiver).args;
    const receiverLogger = receiverArgs.logger as { error?: unknown; warn?: unknown };
    expect(receiverLogger.error).toBeTypeOf("function");
    expect(receiverLogger.warn).toBeTypeOf("function");
    expect(receiverArgs).toEqual({
      appToken: "xapp-test",
      autoReconnectEnabled: false,
      clientPingTimeout: 20_000,
      serverPingTimeout: 45_000,
      pingPongLoggingEnabled: true,
      logger: receiverLogger,
      installerOptions: {
        clientOptions: { teamId: "T1", timeout: 20_000 },
      },
    });
  });

  it("uses HTTPReceiver for webhook mode", () => {
    const clientOptions = { teamId: "T1" };
    const { app, receiver } = createSlackBoltApp({
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "http",
      botToken: "xoxb-test",
      signingSecret: "secret",
      slackWebhookPath: "/slack/events",
      clientOptions,
    });

    expect(receiver).toBeInstanceOf(FakeHTTPReceiver);
    expect((receiver as unknown as FakeHTTPReceiver).args).toEqual({
      signingSecret: "secret",
      endpoints: "/slack/events",
    });
    expect(app).toBeInstanceOf(FakeApp);
    expect((app as unknown as FakeApp).args).toEqual({
      token: "xoxb-test",
      receiver,
      clientOptions,
      ignoreSelf: false,
      tokenVerificationEnabled: false,
    });
    expect((app as unknown as FakeApp).middleware).toHaveLength(1);
  });

  it("prevents Bolt's constructor-time token verification side effect", () => {
    let eagerAuthTestCalls = 0;
    class BoltLikeEagerAuthApp extends FakeApp {
      constructor(args: Record<string, unknown>) {
        super(args);
        if (args.tokenVerificationEnabled !== false) {
          eagerAuthTestCalls += 1;
        }
      }
    }

    createSlackBoltApp({
      interop: {
        App: BoltLikeEagerAuthApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeSocketModeReceiver as never,
      },
      slackMode: "socket",
      botToken: "xoxb-invalid",
      appToken: "xapp-test",
      slackWebhookPath: "/slack/events",
      clientOptions: {},
    });

    expect(eagerAuthTestCalls).toBe(0);
  });
});
