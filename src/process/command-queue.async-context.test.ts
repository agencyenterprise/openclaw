// A queued task must run in the async context of its enqueuer, never in the
// context of whichever earlier task happened to finish and pump the lane.
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it } from "vitest";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "./command-queue.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";

const lane = "async-context-test";
const owner = new AsyncLocalStorage<string>();

beforeEach(() => {
  resetCommandQueueStateForTest();
  setCommandLaneConcurrency(lane, 1);
});
afterEach(() => resetCommandQueueStateForTest());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("runs a task dequeued by another task's completion in its own enqueue context", async () => {
  const releaseFirst = deferred();
  const first = owner.run("first-turn", () =>
    enqueueCommandInLane(lane, async () => {
      await releaseFirst.promise;
      return owner.getStore();
    }),
  );
  const queued = owner.run("queued-turn", () =>
    enqueueCommandInLane(lane, async () => owner.getStore()),
  );
  releaseFirst.resolve();
  await expect(first).resolves.toBe("first-turn");
  await expect(queued).resolves.toBe("queued-turn");
});

it("runs a task enqueued outside any context without inheriting the finished task's context", async () => {
  const releaseFirst = deferred();
  const first = owner.run("first-turn", () =>
    enqueueCommandInLane(lane, () => releaseFirst.promise),
  );
  const queued = enqueueCommandInLane(lane, async () => owner.getStore());
  releaseFirst.resolve();
  await first;
  await expect(queued).resolves.toBeUndefined();
});

it("reports lane waits in the waiting task's own context", async () => {
  const releaseFirst = deferred();
  const first = owner.run("first-turn", () =>
    enqueueCommandInLane(lane, () => releaseFirst.promise),
  );
  const observed: Array<string | undefined> = [];
  const queued = owner.run("queued-turn", () =>
    enqueueCommandInLane(lane, async () => undefined, {
      warnAfterMs: 0,
      onWait: () => observed.push(owner.getStore()),
    }),
  );
  releaseFirst.resolve();
  await Promise.all([first, queued]);
  expect(observed).toEqual(["queued-turn"]);
});
