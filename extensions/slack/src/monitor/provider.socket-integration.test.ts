// Slack tests drive the real Bolt + Socket Mode client against a local fake Slack.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  createSlackBoltApp,
  gracefulStopSlackApp,
  resolveSlackBoltInterop,
  startSlackSocketAndWaitForDisconnect,
  ensureSlackAppReusableAfterStop,
} from "./provider-support.js";

type FakeSlack = {
  apiUrl: string;
  heldSockets: Set<Socket>;
  openConnections: () => number;
  hellos: number;
  holdUpgrades: boolean;
  holdConnectionsOpen: boolean;
  sendToAll: (payload: unknown) => void;
  closeAll: () => void;
  stop: () => Promise<void>;
};

async function startFakeSlack(): Promise<FakeSlack> {
  const wss = new WebSocketServer({ noServer: true });
  const heldSockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/api/apps.connections.open")) {
      if (fake.holdConnectionsOpen) {
        return;
      }
      const { port } = server.address() as AddressInfo;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/link` }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  server.on("upgrade", (req, socket, head) => {
    if (fake.holdUpgrades) {
      // Never answer the upgrade; count the socket as released once the client closes it.
      const held = socket as Socket;
      heldSockets.add(held);
      held.on("end", () => {
        heldSockets.delete(held);
        held.destroy();
      });
      held.resume();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      fake.hellos += 1;
      ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const fake: FakeSlack = {
    apiUrl: `http://127.0.0.1:${port}/api/`,
    heldSockets,
    openConnections: () => wss.clients.size,
    hellos: 0,
    holdUpgrades: false,
    holdConnectionsOpen: false,
    sendToAll: (payload) => {
      for (const ws of wss.clients) {
        ws.send(JSON.stringify(payload));
      }
    },
    closeAll: () => {
      for (const ws of wss.clients) {
        ws.terminate();
      }
    },
    stop: async () => {
      for (const socket of heldSockets) {
        socket.destroy();
      }
      for (const ws of wss.clients) {
        ws.terminate();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
  return fake;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition not met in time");
    }
    await sleep(25);
  }
}

// The provider's reconnect loop, with test-sized deadlines.
function runSocketLoop(app: Parameters<typeof gracefulStopSlackApp>[0] & { start: () => unknown }) {
  const controller = new AbortController();
  const outcomes: string[] = [];
  const connectedAt: number[] = [];
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        const disconnect = await startSlackSocketAndWaitForDisconnect({
          app,
          abortSignal: controller.signal,
          connectTimeoutMs: 1_500,
          liveness: { checkIntervalMs: 100, staleAfterMs: 1_000 },
          onStarted: () => {
            outcomes.push("connected");
            connectedAt.push(Date.now());
          },
        });
        if (!disconnect || controller.signal.aborted) {
          break;
        }
        outcomes.push(`lost:${disconnect.event}`);
      } catch (err) {
        outcomes.push(`start-failed:${(err as Error).name}`);
      }
      const stop = await gracefulStopSlackApp(app, 500);
      if (stop.outcome !== "stopped" || stop.forcedClose) {
        outcomes.push(`stop:${stop.outcome}${stop.forcedClose ? "+forced" : ""}`);
      }
      try {
        await ensureSlackAppReusableAfterStop(stop, 1_000);
      } catch (err) {
        outcomes.push(`discarded:${(err as Error).name}`);
        break;
      }
      await sleep(50);
    }
  })();
  return {
    outcomes,
    connectedAt,
    stop: async () => {
      controller.abort();
      await done;
      await gracefulStopSlackApp(app, 2_000);
    },
  };
}

describe("slack socket mode against a local Slack", () => {
  let fake: FakeSlack | undefined;
  let loop: ReturnType<typeof runSocketLoop> | undefined;
  const uncaught: unknown[] = [];
  const recordUncaught = (err: unknown) => uncaught.push(err);

  beforeEach(() => {
    uncaught.length = 0;
    process.on("uncaughtException", recordUncaught);
    process.on("unhandledRejection", recordUncaught);
  });

  afterEach(async () => {
    await loop?.stop();
    await fake?.stop();
    await sleep(50);
    process.off("uncaughtException", recordUncaught);
    process.off("unhandledRejection", recordUncaught);
    loop = undefined;
    fake = undefined;
    expect(uncaught).toEqual([]);
  });

  it("gives the app up instead of reconnecting when stop never settles", async () => {
    const app = await startApp();
    const receiver = (app as unknown as { receiver: { stop: () => Promise<unknown> } }).receiver;
    loop = runSocketLoop(app);
    await waitUntil(() => loop!.outcomes.includes("connected"), 5_000);

    receiver.stop = () => new Promise(() => {});
    fake!.holdUpgrades = true;
    fake!.closeAll();
    await waitUntil(
      () => loop!.outcomes.includes("discarded:SlackSocketAppDiscardedError"),
      10_000,
    );

    expect(loop!.outcomes).toContain("stop:timed_out");
    expect(loop!.outcomes.filter((o) => o === "connected")).toHaveLength(1);
    await waitUntil(() => fake!.heldSockets.size === 0, 2_000);
    expect(fake!.openConnections()).toBe(0);
  });

  it("reconnects only after a timed-out stop has finished", async () => {
    const app = await startApp();
    const receiver = (app as unknown as { receiver: { stop: () => Promise<unknown> } }).receiver;
    loop = runSocketLoop(app);
    await waitUntil(() => loop!.outcomes.includes("connected"), 5_000);

    // A stop that runs its real work late, after the 500 ms stop timeout.
    const realStop = receiver.stop.bind(receiver);
    let stopFinishedAt = Number.POSITIVE_INFINITY;
    receiver.stop = async () => {
      await sleep(800);
      await realStop();
      stopFinishedAt = Date.now();
    };
    fake!.closeAll();
    await waitUntil(() => loop!.connectedAt.length === 2, 8_000);

    expect(loop!.outcomes).toContain("stop:timed_out");
    expect(loop!.connectedAt[1]).toBeGreaterThanOrEqual(stopFinishedAt);
    await sleep(1_000);
    expect(fake!.openConnections()).toBe(1);
  });

  async function startApp() {
    fake = await startFakeSlack();
    const { app } = createSlackBoltApp({
      interop: resolveSlackBoltInterop({
        defaultImport: await import("@slack/bolt"),
        namespaceImport: await import("@slack/bolt"),
      }),
      slackMode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-1-A1-test",
      slackWebhookPath: "/slack/events",
      clientOptions: { slackApiUrl: fake.apiUrl, retryConfig: { retries: 0 } },
    });
    return app as unknown as Parameters<typeof runSocketLoop>[0];
  }

  it("reconnects after Slack sends a disconnect envelope", async () => {
    const app = await startApp();
    loop = runSocketLoop(app);
    await waitUntil(() => fake!.hellos === 1 && loop!.outcomes.includes("connected"), 5_000);

    fake!.sendToAll({ type: "disconnect", reason: "refresh_requested" });

    await waitUntil(() => fake!.hellos === 2, 5_000);
    await waitUntil(() => loop!.outcomes.filter((o) => o === "connected").length === 2, 5_000);
    expect(loop.outcomes).toEqual(["connected", "lost:disconnect", "connected"]);
  });

  // Regression: force-closing a ws still in its handshake must not raise an unhandled
  // "error" (it exits the gateway); afterEach fails the test on any uncaught error.
  it("recovers when the reconnect handshake hangs", async () => {
    const app = await startApp();
    loop = runSocketLoop(app);
    await waitUntil(() => loop!.outcomes.includes("connected"), 5_000);

    fake!.holdUpgrades = true;
    fake!.closeAll();
    await waitUntil(
      () => loop!.outcomes.includes("start-failed:SlackSocketConnectTimeoutError"),
      8_000,
    );
    fake!.holdUpgrades = false;

    await waitUntil(() => loop!.outcomes.filter((o) => o === "connected").length === 2, 8_000);
    expect(loop.outcomes[1]).toBe("lost:disconnect");
    expect(loop.outcomes).toContain("stop:stopped+forced");
  });

  it("recovers when apps.connections.open never answers", async () => {
    const app = await startApp();
    loop = runSocketLoop(app);
    await waitUntil(() => loop!.outcomes.includes("connected"), 5_000);

    fake!.holdConnectionsOpen = true;
    fake!.closeAll();
    await waitUntil(
      () => loop!.outcomes.includes("start-failed:SlackSocketConnectTimeoutError"),
      8_000,
    );
    fake!.holdConnectionsOpen = false;

    await waitUntil(() => loop!.outcomes.filter((o) => o === "connected").length === 2, 8_000);
    expect(fake!.hellos).toBe(2);
  });
}, 60_000);
