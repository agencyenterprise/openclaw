import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "./file-lock.js";

let dir = "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("serializes concurrent read-modify-write cycles on one file", async () => {
    const filePath = path.join(dir, "state", "counter.json");
    const bump = () =>
      withFileLock(filePath, async () => {
        const current = Number((await fs.readFile(filePath, "utf-8")) || "0");
        await sleep(5);
        await fs.writeFile(filePath, String(current + 1), "utf-8");
      });

    await Promise.all(Array.from({ length: 8 }, bump));
    expect(await fs.readFile(filePath, "utf-8")).toBe("8");
  });

  it("waits for a lock held by another writer using the mkdir protocol", async () => {
    const filePath = path.join(dir, "asks.jsonl");
    await fs.writeFile(filePath, "", "utf-8");
    const release = await lockfile.lock(filePath, { realpath: false });
    let ran = false;
    const pending = withFileLock(filePath, async () => {
      ran = true;
    });
    await sleep(50);
    expect(ran).toBe(false);
    await release();
    await pending;
    expect(ran).toBe(true);
  });
});
