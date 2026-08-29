/**
 * Unit tests for inflight-ledger.ts — the crash-safe durable record of reviewer
 * continues. These tests prove the durability contract that the old read-and-clear
 * JSON ledgers violated:
 *
 *   - NEVER clear on read (at-least-once)
 *   - A crash DURING recovery (simulated by close+reopen) replays, loses nothing
 *   - cap=N newest-first, oldest overflow dropped (loudly)
 *   - attempts ceiling quarantines instead of looping forever
 *   - recoveryStartMs excludes rows opened by a live review racing startup
 *   - latest-payload-wins (one row per thread)
 *   - graceful degrade: a broken DB never throws into the reviewer path
 *   - WAL durability across close/reopen
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _listInflightTurnsForTest,
  _seedInflightRowForTest,
  checkpointInflightLedger,
  closeInflightLedgerForTest,
  closeInflightTurn,
  closeInflightTurnIfUnchanged,
  getOpenInflightTurn,
  markInflightAttempt,
  recoverInflightTurns,
  upsertInflightTurn,
  type InflightTurnRow,
} from "./inflight-ledger.js";

let tmpDir = "";
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inflight-ledger-test-"));
  originalEnv = process.env.OPENCLAW_REVIEWER_INFLIGHT_DB_PATH;
  process.env.OPENCLAW_REVIEWER_INFLIGHT_DB_PATH = path.join(tmpDir, "reviewer-inflight.sqlite");
});

afterEach(() => {
  closeInflightLedgerForTest();
  if (originalEnv === undefined) {
    delete process.env.OPENCLAW_REVIEWER_INFLIGHT_DB_PATH;
  } else {
    process.env.OPENCLAW_REVIEWER_INFLIGHT_DB_PATH = originalEnv;
  }
  try {
    // Removes the .sqlite plus its -wal / -shm sidecars.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seed(overrides: Partial<InflightTurnRow> & { channel: string; thread: string }): void {
  const now = Date.now();
  _seedInflightRowForTest({
    key: `${overrides.channel}:${overrides.thread}`,
    channel: overrides.channel,
    thread: overrides.thread,
    kind: overrides.kind ?? "continue",
    iteration: overrides.iteration ?? 1,
    payload: overrides.payload ?? "🔍 *Reviewer:* do the thing",
    opened_at: overrides.opened_at ?? now,
    // Default last_dispatch to opened_at so tests that set opened_at also drive the
    // recovery filter/order (which is keyed on last_dispatch).
    last_dispatch: overrides.last_dispatch ?? overrides.opened_at ?? now,
    attempts: overrides.attempts ?? 0,
  });
}

describe("upsertInflightTurn", () => {
  it("opens a row with attempts=0", () => {
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "continue",
      iteration: 2,
      payload: "fix it",
    });
    const rows = _listInflightTurnsForTest();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "C1",
      thread: "1.0",
      iteration: 2,
      payload: "fix it",
      attempts: 0,
    });
  });

  it("latest-payload-wins: a second upsert replaces payload/iteration, keeps opened_at, RESETS attempts", () => {
    seed({
      channel: "C1",
      thread: "1.0",
      iteration: 1,
      payload: "A",
      opened_at: 1000,
      attempts: 3,
    });
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "continue",
      iteration: 2,
      payload: "B",
    });
    const rows = _listInflightTurnsForTest();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toBe("B");
    expect(rows[0]!.iteration).toBe(2);
    expect(rows[0]!.opened_at).toBe(1000); // preserved (age ordering)
    expect(rows[0]!.attempts).toBe(0); // RESET — a live upsert means the thread is progressing
  });

  it("refuses invalid Slack keys", () => {
    upsertInflightTurn({
      channel: "not-a-channel",
      thread: "nope",
      kind: "continue",
      iteration: 1,
      payload: "x",
    });
    expect(_listInflightTurnsForTest()).toHaveLength(0);
  });

  it("an engage row UPGRADES to continue when a reviewer continue is dispatched", () => {
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "engage",
      iteration: 0,
      payload: "generic",
    });
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "continue",
      iteration: 1,
      payload: "FEEDBACK",
    });
    const rows = _listInflightTurnsForTest();
    expect(rows[0]!.kind).toBe("continue");
    expect(rows[0]!.payload).toBe("FEEDBACK");
  });

  it("a continue row never DOWNGRADES to engage (a real ask outranks a bare mention)", () => {
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "continue",
      iteration: 1,
      payload: "FEEDBACK",
    });
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "engage",
      iteration: 0,
      payload: "generic",
    });
    const rows = _listInflightTurnsForTest();
    expect(rows[0]!.kind).toBe("continue"); // not downgraded
    expect(rows[0]!.payload).toBe("FEEDBACK"); // continue payload preserved
  });
});

describe("closeInflightTurn", () => {
  it("deletes the row", () => {
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "continue",
      iteration: 1,
      payload: "x",
    });
    closeInflightTurn("C1", "1.0");
    expect(_listInflightTurnsForTest()).toHaveLength(0);
  });

  it("is a no-op for an unknown row", () => {
    expect(() => closeInflightTurn("C1", "9.9")).not.toThrow();
    expect(_listInflightTurnsForTest()).toHaveLength(0);
  });
});

describe("markInflightAttempt", () => {
  it("increments attempts", () => {
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "continue",
      iteration: 1,
      payload: "x",
    });
    markInflightAttempt("C1", "1.0");
    markInflightAttempt("C1", "1.0");
    expect(_listInflightTurnsForTest()[0]!.attempts).toBe(2);
  });
});

describe("recoverInflightTurns", () => {
  it("NEVER clears recovered rows on read (at-least-once)", () => {
    seed({ channel: "C1", thread: "1.0" });
    seed({ channel: "C2", thread: "2.0" });
    const res = recoverInflightTurns({
      capNewestFirst: 10,
      attemptsCeiling: 5,
      recoveryStartMs: Date.now() + 1,
    });
    expect(res.recovered).toHaveLength(2);
    // The headline property: rows still on disk after recovery read.
    expect(_listInflightTurnsForTest()).toHaveLength(2);
  });

  it("replays across a simulated double-restart (the 2026-05-28 incident)", () => {
    seed({ channel: "C1", thread: "1.0" });
    // Restart #1: recover, but do NOT close (agent never answered) → crash.
    let res = recoverInflightTurns({
      capNewestFirst: 10,
      attemptsCeiling: 5,
      recoveryStartMs: Date.now() + 1,
    });
    expect(res.recovered).toHaveLength(1);
    closeInflightLedgerForTest(); // simulate restart
    // Restart #2: row survived; recover again.
    res = recoverInflightTurns({
      capNewestFirst: 10,
      attemptsCeiling: 5,
      recoveryStartMs: Date.now() + 1,
    });
    expect(res.recovered).toHaveLength(1);
  });

  it("excludes rows opened at/after recoveryStartMs (no race with live reviews)", () => {
    seed({ channel: "C1", thread: "1.0", opened_at: 5000 });
    // recoveryStartMs equal to opened_at → excluded (strict <).
    const res = recoverInflightTurns({
      capNewestFirst: 10,
      attemptsCeiling: 5,
      recoveryStartMs: 5000,
    });
    expect(res.recovered).toHaveLength(0);
    // ...but the row is left intact for a later pass.
    expect(_listInflightTurnsForTest()).toHaveLength(1);
  });

  it("caps at N newest-first and DEFERS the oldest overflow — never deletes it", () => {
    for (let i = 0; i < 13; i++) {
      seed({ channel: "C1", thread: `${i}.0`, opened_at: 1000 + i }); // strictly increasing age
    }
    const res = recoverInflightTurns({
      capNewestFirst: 10,
      attemptsCeiling: 5,
      recoveryStartMs: 1_000_000,
    });
    expect(res.recovered).toHaveLength(10);
    expect(res.deferredOverflow).toBe(3);
    // The 10 returned are the NEWEST (highest opened_at): threads 3.0..12.0.
    const keptThreads = res.recovered.map((r) => r.thread);
    expect(keptThreads).not.toContain("0.0");
    expect(keptThreads).not.toContain("2.0");
    expect(res.recovered[0]!.opened_at).toBe(1012); // newest first
    // CRUCIAL: all 13 rows are still on disk — overflow is deferred, never lost.
    expect(_listInflightTurnsForTest()).toHaveLength(13);
  });

  it("quarantines rows over the attempts ceiling — keeps them, never deletes", () => {
    seed({ channel: "C1", thread: "1.0", attempts: 6 }); // > ceiling 5
    seed({ channel: "C2", thread: "2.0", attempts: 5 }); // == ceiling → still eligible
    const res = recoverInflightTurns({
      capNewestFirst: 10,
      attemptsCeiling: 5,
      recoveryStartMs: Date.now() + 1,
    });
    expect(res.quarantined).toBe(1);
    expect(res.recovered.map((r) => r.channel)).toEqual(["C2"]);
    // BOTH rows remain — the quarantined one is kept for manual attention, not lost.
    expect(_listInflightTurnsForTest()).toHaveLength(2);
  });

  it("recovery never deletes — overflow and quarantine rows all remain on disk", () => {
    for (let i = 0; i < 12; i++) {
      seed({ channel: "C1", thread: `${i}.0`, opened_at: 1000 + i });
    }
    seed({ channel: "C9", thread: "99.0", attempts: 9, opened_at: 2000 }); // quarantined
    recoverInflightTurns({ capNewestFirst: 10, attemptsCeiling: 5, recoveryStartMs: 1_000_000 });
    // 12 eligible (2 deferred) + 1 quarantined = 13, all preserved.
    expect(_listInflightTurnsForTest()).toHaveLength(13);
  });
});

describe("closeInflightTurnIfUnchanged (compare-and-delete race guard)", () => {
  it("closes when last_dispatch is unchanged since it was read", () => {
    seed({ channel: "C1", thread: "1.0", last_dispatch: 5000 });
    closeInflightTurnIfUnchanged("C1", "1.0", 5000);
    expect(_listInflightTurnsForTest()).toHaveLength(0);
  });

  it("does NOT close when a newer continue refreshed last_dispatch (no-op)", () => {
    seed({ channel: "C1", thread: "1.0", last_dispatch: 5000 });
    // Simulate a live continue refreshing the row after we read last_dispatch=5000.
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "continue",
      iteration: 2,
      payload: "newer continue",
    });
    closeInflightTurnIfUnchanged("C1", "1.0", 5000); // stale close attempt
    const rows = _listInflightTurnsForTest();
    expect(rows).toHaveLength(1); // newer continue preserved
    expect(rows[0]!.payload).toBe("newer continue");
  });
});

describe("getOpenInflightTurn", () => {
  it("returns the row when one is open", () => {
    seed({ channel: "C1", thread: "1.0", last_dispatch: 4242 });
    const row = getOpenInflightTurn("C1", "1.0");
    expect(row?.last_dispatch).toBe(4242);
  });

  it("returns undefined when there is no open row", () => {
    expect(getOpenInflightTurn("C1", "9.9")).toBeUndefined();
  });
});

describe("durability + graceful degradation", () => {
  it("survives close/reopen (WAL durability)", () => {
    upsertInflightTurn({
      channel: "C1",
      thread: "1.0",
      kind: "continue",
      iteration: 1,
      payload: "persist me",
    });
    checkpointInflightLedger();
    closeInflightLedgerForTest(); // close DB
    // Reopen happens lazily on the next call.
    const rows = _listInflightTurnsForTest();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toBe("persist me");
  });

  it("degrades gracefully when the DB cannot be opened — never throws", () => {
    closeInflightLedgerForTest();
    process.env.OPENCLAW_REVIEWER_INFLIGHT_DB_PATH =
      "/dev/null/cannot-create/reviewer-inflight.sqlite";
    expect(() =>
      upsertInflightTurn({
        channel: "C1",
        thread: "1.0",
        kind: "continue",
        iteration: 1,
        payload: "x",
      }),
    ).not.toThrow();
    expect(() => closeInflightTurn("C1", "1.0")).not.toThrow();
    expect(() => markInflightAttempt("C1", "1.0")).not.toThrow();
    expect(() => checkpointInflightLedger()).not.toThrow();
    const res = recoverInflightTurns({
      capNewestFirst: 10,
      attemptsCeiling: 5,
      recoveryStartMs: Date.now(),
    });
    expect(res.recovered).toHaveLength(0);
  });
});
