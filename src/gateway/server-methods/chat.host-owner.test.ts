import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  admitThreadDispatch,
  loadDispatchConfig,
  resolveDispatchScope,
  dispatchHash,
  withLogicalReplyDispatch,
} from "../../state/thread-dispatch.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext } from "./types.js";

const mocked = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../auto-reply/dispatch.js", () => ({ dispatchInboundMessage: mocked.dispatch }));
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([false, true])(
  "actual chat.send keeps admitted ownership through post-ACK dispatch or rejects BUSY before effects (%s)",
  async (busy) => {
    const dir = mkdtempSync(join(tmpdir(), "chat-host-owner-"));
    dirs.push(dir);
    const text = readFileSync(
      new URL("../../auto-reply/reply/dispatch-from-config.logical-owner.test.ts", import.meta.url),
      "utf8",
    );
    const sql = JSON.parse(text.match(/const fenceSql\s*=\s*("(?:[^"\\]|\\.)*")/s)![1]) as string;
    const databasePath = join(dir, "dispatch.sqlite");
    const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
    db.exec(sql);
    chmodSync(databasePath, 0o600);
    const configPath = join(dir, "dispatch.json");
    writeFileSync(
      configPath,
      JSON.stringify({ databasePath, scopes: {}, sessionScopes: {}, automaticSessions: true }),
      { mode: 0o600 },
    );
    vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", configPath);
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: join(dir, "sessions.json") },
    };
    if (busy) {
      const ownerConfig = loadDispatchConfig()!;
      const scope = resolveDispatchScope(ownerConfig, "agent:main:main")!;
      admitThreadDispatch(ownerConfig, {
        claimId: "incumbent",
        scopeKey: scope,
        epoch: ownerConfig.scopes[scope],
        kind: "native",
        fingerprint: dispatchHash("incumbent"),
      });
    }
    const respond = vi.fn();
    const context = {
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      chatAbortControllers: new Map(),
      chatAbortedRuns: new Map(),
      agentRunSeq: new Map(),
      dedupe: new Map(),
      getRuntimeConfig: () => cfg,
      logGateway: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      addChatRun: vi.fn(),
      removeChatRun: vi.fn(),
    };
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    mocked.dispatch.mockImplementation(async ({ ctx }) => {
      entered();
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      return withLogicalReplyDispatch({
        sessionKey: ctx.SessionKey,
        prompt: "original host turn",
        run: async (complete) => {
          expect(
            db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
          ).toBe("STARTING");
          await new Promise<void>((r) => (release = r));
          complete(dispatchHash("observed synthetic final reply"));
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      });
    });
    let settled = false;
    const running = chatHandlers["chat.send"]!({
      params: {
        sessionKey: "agent:main:main",
        message: "hello",
        idempotencyKey: "host-chat-fixture",
        timeoutMs: 5000,
      },
      respond: respond as never,
      context: context as unknown as GatewayRequestContext,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    }).then(() => {
      settled = true;
    });
    try {
      if (busy) {
        await running;
        expect(mocked.dispatch).not.toHaveBeenCalled();
        expect(context.addChatRun).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          expect.objectContaining({ status: "error" }),
          expect.objectContaining({ code: "UNAVAILABLE" }),
          expect.anything(),
        );
        expect(db.prepare("SELECT claim_id,state FROM thread_dispatch_claims").all()).toEqual([
          { claim_id: "incumbent", state: "STARTING" },
        ]);
        return;
      }
      await Promise.race([
        started,
        running.then(() => {
          throw new Error("chat never dispatched: " + JSON.stringify(respond.mock.calls));
        }),
      ]);
      expect(settled).toBe(false);
      release();
      await running;
      expect(
        db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
      ).toBe("TERMINAL");
      expect(mocked.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  },
);
