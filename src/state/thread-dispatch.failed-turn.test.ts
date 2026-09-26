import { cpSync, existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanupIdentity,
  fenceFixture,
  removeFenceFixtures,
  verifiedResult,
} from "./thread-dispatch.fence-fixture.test-support.js";
import {
  admitDispatchChild,
  beginLogicalDispatchEffect,
  NativeDispatchBusyError,
  runLogicalNativeAttempt,
  trackLogicalDispatchHook,
  withLogicalChannelDispatch,
} from "./thread-dispatch.js";

/** How long a finished turn's UNKNOWN claim may keep its thread closed. */
const FINISHED_UNKNOWN_RELEASE_QUIET_MS = 10 * 60_000;

afterEach(() => {
  vi.useRealTimers();
  removeFenceFixtures();
});

const refusedResult = () => ({ meta: { refused: true } });
const provenAttempt = () =>
  runLogicalNativeAttempt({
    sessionKey: "session",
    cleanupIdentity,
    refused: refusedResult,
    run: verifiedResult,
  })!;

it("a turn that throws before it runs anything settles TERMINAL and the next turn in the thread is admitted", async () => {
  const { db, turn, nativeStates } = fenceFixture();
  try {
    await expect(
      withLogicalChannelDispatch({
        ...turn("a"),
        run: async () => {
          throw new Error("THREAD_DISPATCH_REFUSED");
        },
      }),
    ).rejects.toThrow("THREAD_DISPATCH_REFUSED");
    expect(nativeStates()).toEqual(["TERMINAL"]);
    await withLogicalChannelDispatch({ ...turn("b"), run: async () => provenAttempt() });
    expect(nativeStates()).toEqual(["TERMINAL", "TERMINAL"]);
  } finally {
    db.close();
  }
});

it("a turn that throws after a proven attempt and a completed send settles TERMINAL", async () => {
  const { db, turn, nativeStates } = fenceFixture();
  try {
    await expect(
      withLogicalChannelDispatch({
        ...turn("a"),
        run: async () => {
          await provenAttempt();
          beginLogicalDispatchEffect("send")!.settle("completed");
          throw new Error("delivery bookkeeping failed");
        },
      }),
    ).rejects.toThrow("delivery bookkeeping failed");
    expect(nativeStates()).toEqual(["TERMINAL"]);
  } finally {
    db.close();
  }
});

it.each([
  [
    "a send of unknown outcome",
    async () => {
      beginLogicalDispatchEffect("send")!.settle("unknown");
    },
  ],
  [
    "an attempt without its cleanup proof",
    async () => {
      await runLogicalNativeAttempt({
        sessionKey: "session",
        cleanupIdentity,
        refused: refusedResult,
        run: async () => ({ meta: {} }),
      });
    },
  ],
  [
    "a child process still running",
    async () => {
      admitDispatchChild({ command: "sleep" });
    },
  ],
])("a turn that throws with %s stays UNKNOWN", async (_name, before) => {
  const { db, turn, nativeStates } = fenceFixture();
  try {
    await expect(
      withLogicalChannelDispatch({
        ...turn("a"),
        run: async () => {
          await before();
          throw new Error("turn failed");
        },
      }),
    ).rejects.toThrow("turn failed");
    expect(nativeStates()).toEqual(["UNKNOWN"]);
  } finally {
    db.close();
  }
});

it("a turn that throws while its native attempt still runs stays UNKNOWN", async () => {
  const { db, turn, nativeStates } = fenceFixture();
  let finish!: () => void;
  try {
    await expect(
      withLogicalChannelDispatch({
        ...turn("a"),
        run: async () => {
          void runLogicalNativeAttempt({
            sessionKey: "session",
            cleanupIdentity,
            refused: refusedResult,
            run: () =>
              new Promise<{ meta: Record<string, unknown> }>((resolve) => {
                finish = () => resolve({ meta: {} });
              }),
          });
          throw new Error("turn failed");
        },
      }),
    ).rejects.toThrow("turn failed");
    expect(nativeStates()).toEqual(["UNKNOWN"]);
  } finally {
    finish();
    db.close();
  }
});

async function leaveUnknownTurn(turn: ReturnType<typeof fenceFixture>["turn"], source: string) {
  await withLogicalChannelDispatch({
    ...turn(source),
    run: async () => {
      await provenAttempt();
      beginLogicalDispatchEffect("send")!.settle("unknown");
    },
  });
}

it("an UNKNOWN claim of a finished turn blocks its thread only for the quiet window", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { db, turn, nativeStates } = fenceFixture();
  try {
    await leaveUnknownTurn(turn, "a");
    expect(nativeStates()).toEqual(["UNKNOWN"]);
    vi.setSystemTime(Date.now() + FINISHED_UNKNOWN_RELEASE_QUIET_MS - 1_000);
    await expect(
      withLogicalChannelDispatch({ ...turn("b"), run: async () => provenAttempt() }),
    ).rejects.toBeInstanceOf(NativeDispatchBusyError);
    vi.setSystemTime(Date.now() + 2_000);
    await withLogicalChannelDispatch({ ...turn("b"), run: async () => provenAttempt() });
    expect(nativeStates()).toEqual(["TERMINAL", "TERMINAL"]);
  } finally {
    db.close();
  }
});

it("an UNKNOWN claim whose child process still runs is not released after the quiet window", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { db, turn, nativeStates } = fenceFixture();
  try {
    await withLogicalChannelDispatch({
      ...turn("a"),
      run: async () => {
        await provenAttempt();
        admitDispatchChild({ command: "sleep" });
        beginLogicalDispatchEffect("send")!.settle("unknown");
      },
    });
    expect(nativeStates()).toEqual(["UNKNOWN"]);
    vi.setSystemTime(Date.now() + FINISHED_UNKNOWN_RELEASE_QUIET_MS + 1_000);
    await expect(
      withLogicalChannelDispatch({ ...turn("b"), run: async () => provenAttempt() }),
    ).rejects.toBeInstanceOf(NativeDispatchBusyError);
    expect(nativeStates()).toEqual(["UNKNOWN"]);
  } finally {
    db.close();
  }
});

it("an UNKNOWN claim whose native attempt or send still runs is released only after that work ends", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { db, turn, nativeStates } = fenceFixture();
  let finishAttempt!: () => void;
  const send = { handle: undefined as ReturnType<typeof beginLogicalDispatchEffect> };
  try {
    await expect(
      withLogicalChannelDispatch({
        ...turn("a"),
        run: async () => {
          void runLogicalNativeAttempt({
            sessionKey: "session",
            cleanupIdentity,
            refused: refusedResult,
            run: () =>
              new Promise<{ meta: Record<string, unknown> }>((resolve) => {
                finishAttempt = () => resolve({ meta: {} });
              }),
          });
          send.handle = beginLogicalDispatchEffect("send");
          throw new Error("turn failed");
        },
      }),
    ).rejects.toThrow("turn failed");
    expect(nativeStates()).toEqual(["UNKNOWN"]);
    vi.setSystemTime(Date.now() + FINISHED_UNKNOWN_RELEASE_QUIET_MS + 1_000);
    const nextTurn = () =>
      withLogicalChannelDispatch({ ...turn("b"), run: async () => provenAttempt() });
    await expect(nextTurn()).rejects.toBeInstanceOf(NativeDispatchBusyError);
    finishAttempt();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(nextTurn()).rejects.toBeInstanceOf(NativeDispatchBusyError);
    send.handle!.settle("unknown");
    await nextTurn();
    expect(nativeStates()).toEqual(["TERMINAL", "TERMINAL"]);
  } finally {
    db.close();
  }
});

it("an UNKNOWN claim this process did not see finish is not released", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { db, turn, nativeStates } = fenceFixture();
  try {
    await leaveUnknownTurn(turn, "a");
    db.prepare("UPDATE thread_dispatch_claims SET fingerprint=? WHERE kind='native'").run(
      "f".repeat(64),
    );
    vi.setSystemTime(Date.now() + FINISHED_UNKNOWN_RELEASE_QUIET_MS + 1_000);
    await expect(
      withLogicalChannelDispatch({ ...turn("b"), run: async () => provenAttempt() }),
    ).rejects.toBeInstanceOf(NativeDispatchBusyError);
    expect(nativeStates()).toEqual(["UNKNOWN"]);
  } finally {
    db.close();
  }
});

it("an UNKNOWN claim this process saw finish in another fence database does not release a copy of it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const seen = fenceFixture();
  const copy = fenceFixture();
  try {
    await leaveUnknownTurn(seen.turn, "a");
    const row = seen.db.prepare("SELECT * FROM thread_dispatch_claims WHERE kind='native'").get()!;
    const columns = Object.keys(row);
    copy.db
      .prepare(
        `INSERT INTO thread_dispatch_claims (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...(Object.values(row) as (string | number | null)[]));
    const owners = `${seen.config.databasePath}.native-owners`;
    if (existsSync(owners)) {
      cpSync(owners, `${copy.config.databasePath}.native-owners`, { recursive: true });
    }
    vi.setSystemTime(Date.now() + FINISHED_UNKNOWN_RELEASE_QUIET_MS + 1_000);
    await expect(
      withLogicalChannelDispatch({ ...copy.turn("b"), run: async () => provenAttempt() }),
    ).rejects.toBeInstanceOf(NativeDispatchBusyError);
    expect(copy.nativeStates()).toEqual(["UNKNOWN"]);
  } finally {
    seen.db.close();
    copy.db.close();
  }
});

it("a failed turn aborted while its settlement waits for a hook stays UNKNOWN", async () => {
  const { db, turn, nativeStates } = fenceFixture();
  const abort = new AbortController();
  let finishHook!: () => void;
  try {
    const failed = withLogicalChannelDispatch({
      ...turn("a"),
      abortSignal: abort.signal,
      run: async () => {
        trackLogicalDispatchHook(
          () =>
            new Promise<void>((resolve) => {
              finishHook = resolve;
            }),
        );
        throw new Error("turn failed");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    finishHook();
    await expect(failed).rejects.toThrow("turn failed");
    expect(nativeStates()).toEqual(["UNKNOWN"]);
  } finally {
    db.close();
  }
});
