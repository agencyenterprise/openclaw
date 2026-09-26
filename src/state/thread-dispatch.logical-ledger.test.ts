import { AsyncResource } from "node:async_hooks";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  beginNativeCleanupAttempt,
  invalidateNativeCleanupTracking,
  withNativeCleanupTracking,
} from "../agents/embedded-agent-runner/native-cleanup-proof.js";
import { FailoverError } from "../agents/failover-error.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  beginLedgerAttempt,
  beginLedgerEffect,
  createLogicalTurnLedger,
  ledgerAcceptsAttempts,
  settleLogicalTurnLedger,
} from "./logical-turn-ledger.js";
import { claimNativeCleanupRecorder } from "./native-cleanup-evidence.js";
import {
  beginLogicalDispatchEffect,
  dispatchHash,
  runLogicalDispatchAttempt,
  runLogicalNativeAttempt,
  withHostReplyDispatch,
  withLogicalReplyDispatch,
  type DispatchConfig,
  type LogicalEffectOutcome,
} from "./thread-dispatch.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const RUNNER_FIXTURE = new URL(
  "../agents/embedded-agent-runner/run.thread-dispatch.test.ts",
  import.meta.url,
);
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "logical-ledger-"));
  roots.push(root);
  const databasePath = join(root, "state.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(frozenFenceSchema(RUNNER_FIXTURE));
  chmodSync(databasePath, 0o600);
  const scope = "slack/C123/1788816064.061969";
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
  const config: DispatchConfig = {
    databasePath,
    scopes: { [scope]: 1 },
    sessionScopes: { session: scope },
  };
  const turn = (source: string) => ({
    config,
    sessionKey: "session",
    sourceTurnId: `channel-user:v1:${source.repeat(64)}`,
    prompt: "prompt",
  });
  const state = () => db.prepare("SELECT state FROM thread_dispatch_claims ORDER BY rowid").all();
  return { db, root, scope, turn, state };
}

const cleanupIdentity = "cleanup-identity";
/** A run result whose cleanup the real native tracker verified. */
function verifiedResult(identity = cleanupIdentity): Promise<{ meta: Record<string, unknown> }> {
  return withNativeCleanupTracking(identity, async () => {
    beginNativeCleanupAttempt()(true);
    return { meta: {} };
  });
}
const REFUSED = Object.freeze({ meta: { refused: true } });
const refusedResult = () => REFUSED;
const provenAttempt = () =>
  runLogicalNativeAttempt({
    sessionKey: "session",
    cleanupIdentity,
    refused: refusedResult,
    run: async () => verifiedResult(),
  })!;

it("proven attempt with no sends settles TERMINAL; a later send runs untracked and a later attempt is refused without running", async () => {
  const { db, turn, state } = fixture();
  let late!: () => Promise<void>;
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const lateWork = barrier.then(async () => {
          expect(beginLogicalDispatchEffect("late send")).toBeUndefined();
          const lateRun = vi.fn(async () => ({ meta: {} }));
          await expect(
            runLogicalNativeAttempt({
              sessionKey: "session",
              cleanupIdentity,
              refused: refusedResult,
              run: lateRun,
            }),
          ).resolves.toBe(REFUSED);
          expect(lateRun).not.toHaveBeenCalled();
        });
        late = () => {
          release();
          return lateWork;
        };
      },
    });
    expect(state()).toEqual([{ state: "TERMINAL" }]);
    await late();
  } finally {
    db.close();
  }
});

it("a void'd late nested dispatch from a timer is refused without running and raises no unhandled rejection", async () => {
  const { db, turn, state } = fixture();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const lateRun = vi.fn(async () => "ran");
  let lateResult!: Promise<string | undefined>;
  let lateFired!: Promise<void>;
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        // Armed inside the turn, so it fires later with the settled turn's context.
        lateFired = new Promise<void>((resolve) => {
          setTimeout(() => {
            lateResult = runLogicalDispatchAttempt({
              sessionKey: "session",
              run: lateRun,
              refused: () => "refused",
            })!;
            void lateResult;
            resolve();
          }, 10);
        });
      },
    });
    await lateFired;
    await expect(lateResult).resolves.toBe("refused");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(lateRun).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    expect(state()).toEqual([{ state: "TERMINAL" }]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    db.close();
  }
});

it("a late attempt whose refused callback throws rejects asynchronously, never synchronously", async () => {
  const { db, turn } = fixture();
  let late!: () => { dispatch: Promise<unknown>; native: Promise<unknown> };
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        late = AsyncResource.bind(() => {
          const refused = () => {
            throw new Error("refused callback bug");
          };
          return {
            dispatch: runLogicalDispatchAttempt({
              sessionKey: "session",
              run: async () => 1,
              refused,
            })!,
            native: runLogicalNativeAttempt({
              sessionKey: "session",
              cleanupIdentity,
              run: async () => ({ meta: {} }),
              refused,
            })!,
          };
        });
      },
    });
    const { dispatch, native } = late();
    await expect(dispatch).rejects.toThrow("refused callback bug");
    await expect(native).rejects.toThrow("refused callback bug");
  } finally {
    db.close();
  }
});

it("a void'd late native attempt from a timer is refused without running and raises no unhandled rejection", async () => {
  const { db, turn, state } = fixture();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const lateRun = vi.fn(async () => ({ meta: {} }));
  let lateFired!: Promise<void>;
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        // The timer is armed inside the turn, so it fires later with the settled turn's context.
        lateFired = new Promise<void>((resolve) => {
          setTimeout(() => {
            void runLogicalNativeAttempt({
              sessionKey: "session",
              cleanupIdentity,
              refused: refusedResult,
              run: lateRun,
            });
            resolve();
          }, 20);
        });
      },
    });
    expect(state()).toEqual([{ state: "TERMINAL" }]);
    await lateFired;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(lateRun).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    db.close();
  }
});

it("an observed completion does not waive the cleanup proof of an attempt that ran", async () => {
  const { db, turn, state } = fixture();
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async (observeCompleted) => {
        await runLogicalNativeAttempt({
          sessionKey: "session",
          cleanupIdentity,
          refused: refusedResult,
          run: async () => ({ meta: {} }),
        });
        observeCompleted(dispatchHash("reply completed"));
      },
    });
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    db.close();
  }
});

it("attempt without ended-run proof keeps UNKNOWN even when a later attempt is proven", async () => {
  const { db, turn, state } = fixture();
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await runLogicalNativeAttempt({
          sessionKey: "session",
          cleanupIdentity,
          refused: refusedResult,
          run: async () => ({ meta: {} }),
        });
        await provenAttempt();
      },
    });
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    db.close();
  }
});

function namedError(name: string): Error {
  const error = new Error(`fixture ${name}`);
  error.name = name;
  return error;
}
const rateLimited = () =>
  new FailoverError("fixture rate limited", { reason: "rate_limit", provider: "openai" });

it.each([
  {
    name: "failover error after a verified attempt",
    verified: [true],
    error: rateLimited,
    expected: "TERMINAL",
  },
  {
    name: "failover error before any attempt (auth cooldown)",
    verified: [],
    error: rateLimited,
    expected: "TERMINAL",
  },
  {
    name: "failover error after an unverified attempt",
    verified: [false],
    error: rateLimited,
    expected: "UNKNOWN",
  },
  {
    name: "abort after a verified attempt",
    verified: [true],
    error: () => namedError("AbortError"),
    expected: "UNKNOWN",
  },
  {
    name: "timeout after a verified attempt",
    verified: [true],
    error: () => namedError("TimeoutError"),
    expected: "UNKNOWN",
  },
  {
    name: "failover error from invalidated tracking (CLI backend)",
    verified: [],
    invalidate: true,
    error: rateLimited,
    expected: "UNKNOWN",
  },
])(
  "a thrown attempt, then a proven fallback and completion: $name settles $expected",
  async ({ verified, invalidate, error, expected }) => {
    const { db, turn, state } = fixture();
    try {
      await withLogicalReplyDispatch({
        ...turn("a"),
        run: async (observeCompleted) => {
          const thrown = runLogicalNativeAttempt({
            sessionKey: "session",
            cleanupIdentity,
            refused: refusedResult,
            run: () =>
              withNativeCleanupTracking(cleanupIdentity, async () => {
                for (const ok of verified) {
                  beginNativeCleanupAttempt()(ok);
                }
                if (invalidate) {
                  invalidateNativeCleanupTracking();
                }
                throw error();
              }),
          })!;
          await expect(thrown).rejects.toThrow("fixture");
          await provenAttempt();
          observeCompleted(dispatchHash("reply completed"));
        },
      });
      expect(state()).toEqual([{ state: expected }]);
    } finally {
      db.close();
    }
  },
);

it("an attempt that threw with verified cleanup and no later attempt keeps UNKNOWN", async () => {
  const { db, turn, state } = fixture();
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async (observeCompleted) => {
        await runLogicalNativeAttempt({
          sessionKey: "session",
          cleanupIdentity,
          refused: refusedResult,
          run: () =>
            withNativeCleanupTracking(cleanupIdentity, async () => {
              beginNativeCleanupAttempt()(true);
              throw rateLimited();
            }),
        })!.catch(() => undefined);
        observeCompleted(dispatchHash("reply completed"));
      },
    });
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    db.close();
  }
});

it.each([
  { outcome: "completed" as const, expected: "TERMINAL" },
  { outcome: "not_sent" as const, expected: "TERMINAL" },
  { outcome: "unknown" as const, expected: "UNKNOWN" },
])("send outcome $outcome settles $expected", async ({ outcome, expected }) => {
  const { db, turn, state } = fixture();
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        const settle = beginLogicalDispatchEffect("test send")!.settle;
        setTimeout(() => settle(outcome), 5);
      },
    });
    expect(state()).toEqual([{ state: expected }]);
  } finally {
    db.close();
  }
});

it("a native attempt started while settlement waits on a send is refused, and the turn settles on its own evidence", async () => {
  const { db, turn, state } = fixture();
  const lateRun = vi.fn(() => new Promise<{ meta: Record<string, unknown> }>(() => {}));
  let lateResult!: Promise<unknown>;
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        const send = beginLogicalDispatchEffect("test send")!;
        // Armed inside the turn: fires while settlement is blocked on the send.
        setTimeout(() => {
          lateResult = runLogicalNativeAttempt({
            sessionKey: "session",
            cleanupIdentity,
            refused: refusedResult,
            run: lateRun,
          })!;
        }, 10);
        setTimeout(() => send.settle("completed"), 30);
      },
    });
    await expect(lateResult).resolves.toBe(REFUSED);
    expect(lateRun).not.toHaveBeenCalled();
    expect(state()).toEqual([{ state: "TERMINAL" }]);
  } finally {
    db.close();
  }
});

it("an attempt that joins the ledger during the send drain is read again at the decision: never TERMINAL unproven", async () => {
  const ledger = createLogicalTurnLedger("claim", "scope");
  const proven = beginLedgerAttempt(ledger);
  proven("returned", "a".repeat(64));
  const send = beginLedgerEffect(ledger, "test send")!;
  const settlement = settleLogicalTurnLedger(ledger, {
    kind: "returned",
    observedCompletion: true,
  });
  expect(ledgerAcceptsAttempts(ledger)).toBe(false);
  // Bypasses admission, as a race past it would: the attempt is still running.
  const raced = beginLedgerAttempt(ledger);
  send.settle("completed");
  await expect(settlement).resolves.toBeUndefined();
  expect(ledger.sealed).toBe(true);
  raced("returned", undefined);
});

it("a send that never answers leaves UNKNOWN after the bounded wait", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { db, turn, state } = fixture();
  try {
    const running = withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        beginLogicalDispatchEffect("test send");
      },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await running;
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    db.close();
  }
});

it("the send wait is one total deadline: sends that keep starting sends cannot hold the claim open", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { db, turn, state } = fixture();
  let settledAt: number | undefined;
  try {
    const running = withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        // Each send settles after 50s and starts the next one, forever. The promise
        // continuation keeps the turn context, as a real delivery chain does.
        const chain = () => {
          const settle = beginLogicalDispatchEffect("test send")!.settle;
          void new Promise((resolve) => {
            setTimeout(resolve, 50_000);
          }).then(() => {
            chain();
            settle("completed");
          });
        };
        chain();
      },
    }).then(() => {
      settledAt = Date.now();
    });
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    await running;
    expect(settledAt! - startedAt).toBeLessThanOrEqual(60_000);
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    db.close();
  }
});

it("an invalid or repeated send outcome is logged, never thrown, and counts as unknown", async () => {
  const { db, turn, state } = fixture();
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        const settle = beginLogicalDispatchEffect("test send")!.settle;
        expect(() => settle("broken" as LogicalEffectOutcome)).not.toThrow();
        const settleTwice = beginLogicalDispatchEffect("test send")!.settle;
        settleTwice("completed");
        expect(() => settleTwice("completed")).not.toThrow();
      },
    });
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    db.close();
  }
});

it("abort while waiting on a send throws and leaves UNKNOWN", async () => {
  const { db, turn, state } = fixture();
  const controller = new AbortController();
  try {
    const running = withLogicalReplyDispatch({
      ...turn("a"),
      abortSignal: controller.signal,
      run: async () => {
        await provenAttempt();
        beginLogicalDispatchEffect("test send");
        setTimeout(() => controller.abort(), 5);
      },
    });
    await expect(running).rejects.toThrow("THREAD_DISPATCH_ABORTED");
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    db.close();
  }
});

it("an observed reply completion still waits for its sends and settles TERMINAL only when they completed", async () => {
  const { db, turn, state } = fixture();
  let releaseLate!: () => void;
  let late!: Promise<void>;
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async (observeCompleted) => {
        const settle = beginLogicalDispatchEffect("test send")!.settle;
        observeCompleted(dispatchHash("reply completed"));
        setTimeout(() => settle("completed"), 5);
        // Registered inside the turn, so it runs later with the turn context.
        late = new Promise<void>((resolve) => {
          releaseLate = resolve;
        }).then(() => {
          expect(beginLogicalDispatchEffect("late send")).toBeUndefined();
          expect(() => observeCompleted(dispatchHash("again"))).not.toThrow();
        });
      },
    });
    expect(state()).toEqual([{ state: "TERMINAL" }]);
    releaseLate();
    await late;
  } finally {
    db.close();
  }
});

it.each(["unknown", "never"] as const)(
  "an observed reply completion with a send whose outcome is %s stays UNKNOWN",
  async (send) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { db, turn, state } = fixture();
    try {
      const running = withLogicalReplyDispatch({
        ...turn("a"),
        run: async (observeCompleted) => {
          const settle = beginLogicalDispatchEffect("test send")!.settle;
          if (send === "unknown") {
            settle("unknown");
          }
          observeCompleted(dispatchHash("reply completed"));
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await running;
      expect(state()).toEqual([{ state: "UNKNOWN" }]);
    } finally {
      db.close();
    }
  },
);

function hostSetup(root: string, databasePath: string) {
  const configPath = join(root, "host-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ databasePath, scopes: {}, sessionScopes: {}, automaticSessions: true }),
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_THREAD_DISPATCH_CONFIG", configPath);
}

it.each([
  { outcome: "completed" as const, expected: "TERMINAL" },
  { outcome: "unknown" as const, expected: "UNKNOWN" },
])(
  "a host turn completed without reply settles $expected when its send was $outcome",
  async ({ outcome, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "logical-ledger-host-"));
    roots.push(root);
    const databasePath = join(root, "state.sqlite");
    const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
    db.exec(frozenFenceSchema(RUNNER_FIXTURE));
    chmodSync(databasePath, 0o600);
    hostSetup(root, databasePath);
    try {
      await withHostReplyDispatch({
        sessionKey: "agent:main:main",
        operationId: "heartbeat:ledger",
        identity: { host: true },
        timeoutMs: 1000,
        completedWithoutReply: () => true,
        run: async () => {
          beginLogicalDispatchEffect("test send")!.settle(outcome);
          return "no reply";
        },
      });
      expect(db.prepare("SELECT state FROM thread_dispatch_claims").all()).toEqual([
        { state: expected },
      ]);
    } finally {
      db.close();
    }
  },
);

it("a native attempt still running when the turn observes completion keeps UNKNOWN", async () => {
  const { db, turn, state } = fixture();
  let finishAttempt!: () => void;
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async (observeCompleted) => {
        void runLogicalNativeAttempt({
          sessionKey: "session",
          cleanupIdentity,
          refused: refusedResult,
          run: () =>
            new Promise<object>((resolve) => {
              finishAttempt = () => void verifiedResult().then(resolve);
            }),
        });
        observeCompleted(dispatchHash("reply completed"));
      },
    });
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    finishAttempt();
    db.close();
  }
});

it.each([
  { name: "no verified cleanup for the result", result: () => ({ meta: {} }) },
  { name: "cleanup verified for another identity", result: () => verifiedResult("other-run") },
  { name: "a result that is not an object", result: () => "result" },
  {
    name: "a verified run interrupted by timeout",
    result: async () => Object.assign(await verifiedResult(), { meta: { stopReason: "timeout" } }),
  },
])("an attempt returning $name is no proof", async ({ result }) => {
  const { db, turn, state } = fixture();
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await runLogicalNativeAttempt({
          sessionKey: "session",
          cleanupIdentity,
          refused: refusedResult,
          run: async () => result(),
        });
      },
    });
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    db.close();
  }
});

it.each([
  { name: "all its transport requests were answered", child: "completed", expected: "TERMINAL" },
  { name: "Slack refused its request", child: "not_sent", expected: "TERMINAL" },
  { name: "its request's answer was lost", child: "unknown", expected: "UNKNOWN" },
  { name: "it made no transport request", child: undefined, expected: "UNKNOWN" },
] as const)("a failed delivery settles $expected when $name", async ({ child, expected }) => {
  const { db, turn, state } = fixture();
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        const delivery = beginLogicalDispatchEffect("test send")!;
        await delivery.run(async () => {
          if (child) {
            beginLogicalDispatchEffect("test send")!.settle(child);
          }
        });
        delivery.settle("failed");
      },
    });
    expect(state()).toEqual([{ state: expected }]);
  } finally {
    db.close();
  }
});

it("a turn that throws with nothing in flight settles TERMINAL; later sends from its context run untracked", async () => {
  const { db, turn, state } = fixture();
  let releaseLate!: () => void;
  let late!: Promise<void>;
  try {
    await expect(
      withLogicalReplyDispatch({
        ...turn("a"),
        run: async () => {
          late = new Promise<void>((resolve) => {
            releaseLate = resolve;
          }).then(() => {
            expect(beginLogicalDispatchEffect("late send")).toBeUndefined();
          });
          throw new Error("turn failed");
        },
      }),
    ).rejects.toThrow("turn failed");
    expect(state()).toEqual([{ state: "TERMINAL" }]);
    releaseLate();
    await late;
  } finally {
    db.close();
  }
});

it("a send started while settlement awaits is waited for or runs untracked, never left in flight at TERMINAL", async () => {
  const { db, turn, state } = fixture();
  try {
    // One turn per microtask depth, so for some depth the send starts inside the
    // settlement's own awaits, after it first saw no send in flight.
    for (let depth = 0; depth <= 30; depth += 1) {
      let admitted: Promise<boolean> = Promise.resolve(false);
      let settled = false;
      await withLogicalReplyDispatch({
        ...turn("a"),
        sourceTurnId: `channel-user:v1:${dispatchHash(`depth-${depth}`)}`,
        run: async () => {
          await provenAttempt();
          const startAtDepth = (remaining: number) => {
            queueMicrotask(() => {
              if (remaining > 0) {
                startAtDepth(remaining - 1);
                return;
              }
              const effect = beginLogicalDispatchEffect("race send");
              if (!effect) {
                return;
              }
              admitted = new Promise<boolean>((resolve) => {
                setTimeout(() => {
                  effect.settle("completed");
                  settled = true;
                  resolve(true);
                }, 5);
              });
            });
          };
          startAtDepth(depth);
        },
      });
      const settledAtTurnEnd = settled;
      if (await admitted) {
        expect({ depth, settledAtTurnEnd }).toEqual({ depth, settledAtTurnEnd: true });
      }
    }
    expect(state().every((row) => (row as { state: string }).state === "TERMINAL")).toBe(true);
  } finally {
    db.close();
  }
});

it("only the native cleanup tracker holds the recorder: a later claim gets nothing", () => {
  expect(claimNativeCleanupRecorder()).toBeUndefined();
});

it("outside a logical owner no send is registered", () => {
  expect(beginLogicalDispatchEffect("test send")).toBeUndefined();
  expect(
    runLogicalNativeAttempt({
      sessionKey: "session",
      cleanupIdentity,
      refused: refusedResult,
      run: async () => verifiedResult(),
    }),
  ).toBeUndefined();
});

it("a send from a second copy of this module (jiti-loaded plugin) is accounted to the core owner", async () => {
  const { db, turn, state } = fixture();
  vi.resetModules();
  const pluginCopy = await import("./thread-dispatch.js");
  expect(pluginCopy.beginLogicalDispatchEffect).not.toBe(beginLogicalDispatchEffect);
  try {
    await withLogicalReplyDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        const effect = pluginCopy.beginLogicalDispatchEffect("test send");
        expect(effect).toBeDefined();
        effect!.settle("unknown");
      },
    });
    expect(state()).toEqual([{ state: "UNKNOWN" }]);
  } finally {
    db.close();
  }
});
