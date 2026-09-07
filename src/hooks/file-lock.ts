// Cross-process advisory lock for the JSONL/JSON evidence files under
// <workspace>/state. Uses proper-lockfile: the lock is the directory
// `<file>.lock` (mkdir is atomic), considered stale after LOCK_STALE_MS.
// Python scripts writing the same files follow the same protocol
// (see workspace/scripts/asks.py).
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

export const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = { retries: 25, minTimeout: 10, maxTimeout: 120 };

async function ensureFileExists(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "a");
  await handle.close();
}

/** Run `task` while holding the advisory lock for `filePath`. */
export async function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  await ensureFileExists(filePath);
  const release = await lockfile.lock(filePath, {
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: LOCK_RETRIES,
  });
  try {
    return await task();
  } finally {
    await release();
  }
}
