import { afterEach, describe, expect, it, vi } from "vitest";
import {
  noteDeliveredMessage,
  rememberRepairIntent,
  type RepairIntent,
  type RepairRunner,
  resetPendingRepairsForTest,
} from "./pending-repair.js";
import { DEFAULT_TURN_GATE_REPAIR_CONFIG } from "./repair.js";

const SESSION = "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609";

function intent(overrides: Partial<RepairIntent> = {}): RepairIntent {
  return {
    sessionKey: SESSION,
    thread: "C0A3C98HS48:1786591963.108609",
    channel: "C0A3C98HS48",
    threadTs: "1786591963.108609",
    workspaceDir: "/tmp/does-not-matter",
    inboundMessageId: "1786591963.108609",
    inboundText: "run the harvest",
    sentences: ["Next: I'll start the harvest now."],
    config: DEFAULT_TURN_GATE_REPAIR_CONFIG,
    ...overrides,
  };
}

function runner(note = "sent:correct"): RepairRunner {
  return vi.fn(async () => note);
}

afterEach(() => {
  resetPendingRepairsForTest();
});

describe("turn-gate pending repair", () => {
  it("does nothing for a session with no parked intent", async () => {
    const run = runner();
    expect(
      await noteDeliveredMessage({ sessionKey: SESSION, messageId: "1.1", run, settleMs: 0 }),
    ).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs once, against the last delivered message of the turn", async () => {
    const run = runner();
    rememberRepairIntent(intent());

    const first = noteDeliveredMessage({ sessionKey: SESSION, messageId: "1.1", run, settleMs: 0 });
    const last = noteDeliveredMessage({ sessionKey: SESSION, messageId: "2.2", run, settleMs: 0 });

    expect(await first).toBeUndefined();
    expect(await last).toBe("sent:correct");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ messageId: "2.2" }));
  });

  it("clears the intent after it runs, so a later delivery repeats nothing", async () => {
    const run = runner();
    rememberRepairIntent(intent());

    await noteDeliveredMessage({ sessionKey: SESSION, messageId: "1.1", run, settleMs: 0 });
    expect(
      await noteDeliveredMessage({ sessionKey: SESSION, messageId: "1.2", run, settleMs: 0 }),
    ).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("settles rather than hanging when the repair itself throws", async () => {
    const run: RepairRunner = vi.fn(async () => {
      throw new Error("lane.py exploded");
    });
    rememberRepairIntent(intent());

    expect(
      await noteDeliveredMessage({ sessionKey: SESSION, messageId: "1.1", run, settleMs: 0 }),
    ).toBeUndefined();
  });

  it("expires an intent whose turn delivered nothing", async () => {
    const run = runner();
    rememberRepairIntent(intent(), 0);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    expect(
      await noteDeliveredMessage({ sessionKey: SESSION, messageId: "1.1", run, settleMs: 0 }),
    ).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("replaces the intent when the same session promises again", async () => {
    const run = runner();
    rememberRepairIntent(intent({ sentences: ["Next: I'll start the first thing."] }));
    rememberRepairIntent(intent({ sentences: ["Next: I'll start the second thing."] }));

    await noteDeliveredMessage({ sessionKey: SESSION, messageId: "1.1", run, settleMs: 0 });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ sentences: ["Next: I'll start the second thing."] }),
      }),
    );
  });
});
