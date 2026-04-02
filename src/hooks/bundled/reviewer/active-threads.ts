/**
 * Active threads persistence — survives gateway restarts.
 *
 * Tracks which Slack threads have an active agent turn in progress.
 * On gateway restart, threads < 1 hour old are respawned.
 *
 * Thread-safety: Node.js is single-threaded for JS, but async interleaving
 * can cause read-modify-write races on the file. We use an in-memory Map
 * as the source of truth and flush to disk through a serialized write queue.
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/active-threads");

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// In-memory source of truth: "channelId:threadTs" → ISO timestamp
const threads = new Map<string, string>();

// Serialized write queue (mutex via promise chain)
let writeQueue: Promise<void> = Promise.resolve();

function getFilePath(): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ?? path.join(require("node:os").homedir(), ".openclaw");
  return path.join(stateDir, "active-threads.json");
}

function pruneStale(): void {
  const now = Date.now();
  for (const [key, ts] of threads) {
    if (now - new Date(ts).getTime() > STALE_THRESHOLD_MS) {
      threads.delete(key);
    }
  }
}

function flushToDisk(): void {
  writeQueue = writeQueue.then(async () => {
    try {
      const data: Record<string, string> = {};
      for (const [k, v] of threads) {
        data[k] = v;
      }
      const filePath = getFilePath();
      const tmp = filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (err) {
      log.warn(`flush failed: ${String(err)}`);
    }
  });
}

export function addThread(channelId: string, threadTs: string): void {
  const key = `${channelId}:${threadTs}`;
  threads.set(key, new Date().toISOString());
  pruneStale();
  flushToDisk();
  log.info(`tracked: ${key} (${threads.size} active)`);
}

export function removeThread(channelId: string, threadTs: string): void {
  const key = `${channelId}:${threadTs}`;
  if (threads.delete(key)) {
    flushToDisk();
    log.info(`removed: ${key} (${threads.size} active)`);
  }
}

/**
 * Load active threads from disk (called on startup).
 * Returns entries < 1 hour old, then clears the file.
 */
export function loadAndConsumeThreads(): Array<{ channelId: string; threadTs: string }> {
  const filePath = getFilePath();
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }

  const now = Date.now();
  const active: Array<{ channelId: string; threadTs: string }> = [];
  for (const [key, ts] of Object.entries(data)) {
    if (now - new Date(ts).getTime() > STALE_THRESHOLD_MS) {
      continue;
    }
    const [channelId, threadTs] = key.split(":");
    if (channelId && threadTs) {
      active.push({ channelId, threadTs });
    }
  }

  // Clear the file — threads are consumed
  try {
    fs.writeFileSync(filePath, "{}");
  } catch {}

  log.info(
    `loaded ${active.length} active threads from disk (${Object.keys(data).length} total, stale filtered)`,
  );
  return active;
}

export function getActiveCount(): number {
  return threads.size;
}
