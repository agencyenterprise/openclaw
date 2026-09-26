// A clean full embedded attempt verifies its own cleanup, so a clean logical turn
// that ran it settles TERMINAL on its ended-run proof.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { requireNodeSqlite } from "../../../infra/node-sqlite.js";
import {
  dispatchHash,
  runLogicalNativeAttempt,
  withLogicalChannelDispatch,
  type DispatchConfig,
} from "../../../state/thread-dispatch.js";
import { withNativeCleanupTracking } from "../native-cleanup-proof.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createDefaultEmbeddedSession,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const tempPaths: string[] = [];
beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});
beforeEach(() => {
  resetEmbeddedAttemptHarness();
});
afterEach(async () => {
  await cleanupTempPaths(tempPaths);
});

/** The harness session plus the idle wait a real agent has, which cleanup verification awaits. */
function sessionWithIdleWait() {
  const session = createDefaultEmbeddedSession();
  Object.assign(session.agent, { waitForIdle: async () => {} });
  return session;
}

/** The frozen V2 fence schema from the thread-dispatch runner fixture, not a relaxed test copy. */
function frozenFenceSchema(fixtureUrl: URL): string {
  const literal = readFileSync(fixtureUrl, "utf8").match(
    /const fenceSql =\s*("(?:[^"\\]|\\.)*");/,
  )?.[1];
  if (!literal) {
    throw new Error(`fenceSql fixture not found in ${fixtureUrl.pathname}`);
  }
  return JSON.parse(literal) as string;
}

function fenceFixture() {
  const root = mkdtempSync(join(tmpdir(), "clean-attempt-proof-"));
  tempPaths.push(root);
  const databasePath = join(root, "state.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(frozenFenceSchema(new URL("../run.thread-dispatch.test.ts", import.meta.url)));
  chmodSync(databasePath, 0o600);
  const scope = "slack/C123/1788816064.061969";
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
  const config: DispatchConfig = {
    databasePath,
    scopes: { [scope]: 1 },
    sessionScopes: { session: scope },
  };
  const state = () => db.prepare("SELECT state FROM thread_dispatch_claims").get()?.state;
  return { db, config, state };
}

async function settleTurnRunningOneAttempt(
  config: DispatchConfig,
  createSession: () => ReturnType<typeof createDefaultEmbeddedSession>,
) {
  const cleanupIdentity = dispatchHash("clean-attempt-run");
  await withLogicalChannelDispatch({
    config,
    sessionKey: "session",
    sourceTurnId: `channel-user:v1:${"c".repeat(64)}`,
    prompt: "prompt",
    run: async () => {
      await runLogicalNativeAttempt({
        sessionKey: "session",
        cleanupIdentity,
        refused: () => ({ meta: {} }),
        run: () =>
          withNativeCleanupTracking(cleanupIdentity, async () => {
            await createContextEngineAttemptRunner({
              contextEngine: createContextEngineBootstrapAndAssemble(),
              sessionKey: "agent:main:clean-attempt",
              createSession,
              tempPaths,
            });
            return { meta: {} };
          }),
      });
    },
  });
}

it("a clean full embedded attempt carries an ended-run proof and its logical turn settles TERMINAL", async () => {
  const { db, config, state } = fenceFixture();
  try {
    await settleTurnRunningOneAttempt(config, sessionWithIdleWait);
    expect(state()).toBe("TERMINAL");
  } finally {
    db.close();
  }
});

it("an attempt whose agent cannot show it is idle carries no proof: UNKNOWN", async () => {
  const { db, config, state } = fenceFixture();
  try {
    await settleTurnRunningOneAttempt(config, () => createDefaultEmbeddedSession());
    expect(state()).toBe("UNKNOWN");
  } finally {
    db.close();
  }
});
it("an attempt whose transcript ends on a terminating tool batch (stopReason toolUse) still carries the ended-run proof", async () => {
  const { readEndedCleanupProof } = await import("../../../state/native-cleanup-evidence.js");
  const cleanupIdentity = dispatchHash("tool-use-terminal-attempt");
  const endsOnTerminatingTool = () => {
    const session = createDefaultEmbeddedSession({
      prompt: async (current) => {
        current.messages.push(
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "call_1", name: "edit", arguments: { path: "a.txt" } },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "edit",
            isError: false,
            content: [{ type: "text", text: "No changes made to a.txt." }],
          },
        );
      },
    });
    Object.assign(session.agent, { waitForIdle: async () => {} });
    return session;
  };
  const result = await withNativeCleanupTracking(cleanupIdentity, async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:tool-use-terminal-attempt",
      createSession: endsOnTerminatingTool,
      tempPaths,
    });
    return { meta: { stopReason: "toolUse" } };
  });
  expect(readEndedCleanupProof(result, cleanupIdentity)).toMatch(/^[a-f0-9]{64}$/);
});
