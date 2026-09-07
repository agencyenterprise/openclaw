import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PENDING_TTL_MS } from "./hash-store.js";
import {
  confirmObligation,
  type ObligationReservationStore,
  OUTBOUND_OBLIGATIONS_FILE,
  releaseObligation,
  reserveObligation,
} from "./obligation-store.js";

const KEY = "C0A3C98HS48:1788479206.951729:C0A3C98HS48:1788479206.951729:v0";
const HOLDER = "agent:main:slack:channel:c0a3c98hs48:thread:1788479206.951729";
const OTHER_HOLDER = "agent:main:slack:channel:c0a3c98hs48:thread:1788479558.561999";
const HOUR_MS = 60 * 60 * 1000;
const BURST_MS = 60 * 1000;

let filePath = "";
let clock = new Date("2026-09-03T10:00:00.000Z");

function reservation(overrides: { key?: string; holder?: string; contentHash?: string } = {}) {
  return {
    key: overrides.key ?? KEY,
    holder: overrides.holder ?? HOLDER,
    contentHash: overrides.contentHash ?? "hash-of-the-answer",
    now: clock,
    windowMs: 24 * HOUR_MS,
    burstMs: BURST_MS,
  };
}

async function readStore(): Promise<ObligationReservationStore> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as ObligationReservationStore;
}

function advance(ms: number) {
  clock = new Date(clock.getTime() + ms);
}

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "outbound-obligations-"));
  filePath = path.join(dir, "state", OUTBOUND_OBLIGATIONS_FILE);
  clock = new Date("2026-09-03T10:00:00.000Z");
});

afterEach(async () => {
  await fs.rm(path.dirname(path.dirname(filePath)), { recursive: true, force: true });
});

describe("obligation reservation store", () => {
  it("reserves once and calls a second holder a duplicate", async () => {
    expect(await reserveObligation(filePath, reservation())).toBe("reserved");
    expect(await reserveObligation(filePath, reservation({ holder: OTHER_HOLDER }))).toBe(
      "duplicate",
    );
  });

  it("lets the holder keep delivering the answer it reserved, but only for the burst", async () => {
    await reserveObligation(filePath, reservation());
    advance(BURST_MS);
    expect(await reserveObligation(filePath, reservation())).toBe("same-answer");
    advance(1);
    expect(await reserveObligation(filePath, reservation())).toBe("duplicate");
  });

  it("never lets two concurrent reservations both pass", async () => {
    const outcomes = await Promise.all([
      reserveObligation(filePath, reservation()),
      reserveObligation(filePath, reservation({ holder: OTHER_HOLDER })),
      reserveObligation(filePath, reservation({ holder: "agent:main:main" })),
    ]);
    expect(outcomes.filter((outcome) => outcome === "reserved")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "duplicate")).toHaveLength(2);
    expect(Object.keys(await readStore())).toEqual([KEY]);
  });

  it("holds a confirmed reservation for the window and drops it after", async () => {
    await reserveObligation(filePath, reservation());
    expect(
      await confirmObligation(filePath, {
        holder: HOLDER,
        contentHash: "hash-of-the-answer",
        now: clock,
      }),
    ).toBe(true);

    advance(PENDING_TTL_MS + 1_000);
    expect(await reserveObligation(filePath, reservation({ holder: OTHER_HOLDER }))).toBe(
      "duplicate",
    );
    advance(24 * HOUR_MS);
    expect(await reserveObligation(filePath, reservation({ holder: OTHER_HOLDER }))).toBe(
      "reserved",
    );
  });

  it("expires a reservation the send never reported back", async () => {
    await reserveObligation(filePath, reservation());
    advance(PENDING_TTL_MS + 1_000);
    expect(await reserveObligation(filePath, reservation({ holder: OTHER_HOLDER }))).toBe(
      "reserved",
    );
  });

  it("releases the reservation of a failed send so the retry passes", async () => {
    await reserveObligation(filePath, reservation());
    expect(
      await releaseObligation(filePath, { holder: HOLDER, contentHash: "hash-of-the-answer" }),
    ).toBe(true);
    expect(await readStore()).toEqual({});
    expect(await reserveObligation(filePath, reservation({ holder: OTHER_HOLDER }))).toBe(
      "reserved",
    );
  });

  it("settles the reservation whose text was sent, not another one of the same run", async () => {
    await reserveObligation(filePath, reservation({ contentHash: "first-answer" }));
    advance(1_000);
    await reserveObligation(
      filePath,
      reservation({ key: `${KEY}-second`, contentHash: "second-answer" }),
    );
    await reserveObligation(filePath, reservation({ key: `${KEY}-other`, holder: OTHER_HOLDER }));

    expect(
      await confirmObligation(filePath, {
        holder: HOLDER,
        contentHash: "second-answer",
        now: clock,
      }),
    ).toBe(true);
    const store = await readStore();
    expect(store[`${KEY}-second`]?.confirmedAt).toBe(clock.toISOString());
    expect(store[KEY]?.confirmedAt).toBeUndefined();
    expect(store[`${KEY}-other`]?.confirmedAt).toBeUndefined();
  });

  it("falls back to the run's oldest pending reservation when the channel rendered the text", async () => {
    await reserveObligation(filePath, reservation({ contentHash: "**bold** answer" }));
    expect(
      await confirmObligation(filePath, {
        holder: HOLDER,
        contentHash: "*bold* answer",
        now: clock,
      }),
    ).toBe(true);
    expect((await readStore())[KEY]?.confirmedAt).toBe(clock.toISOString());
  });

  it("reports that there was nothing to settle", async () => {
    expect(
      await confirmObligation(filePath, { holder: HOLDER, contentHash: "x", now: clock }),
    ).toBe(false);
    expect(await releaseObligation(filePath, { holder: HOLDER, contentHash: "x" })).toBe(false);
  });
});
