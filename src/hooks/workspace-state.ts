// Shared persistence helpers for bundled hooks that write evidence files under
// `<workspace>/state/`. Hooks fire with a session key but rarely with a config,
// so the workspace is resolved from the runtime config snapshot. Every write
// runs under the cross-process file lock because Python crons write the same files.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { withFileLock } from "./file-lock.js";

export type WorkspaceDirResolver = (sessionKey: string | undefined) => string;

export function resolveHookWorkspaceDir(
  sessionKey: string | undefined,
  cfg: OpenClawConfig | null = getRuntimeConfigSnapshot(),
): string {
  if (cfg) {
    return resolveAgentWorkspaceDir(cfg, resolveAgentIdFromSessionKey(sessionKey));
  }
  return path.join(resolveStateDir(process.env, os.homedir), "workspace");
}

export function resolveWorkspaceStatePath(workspaceDir: string, fileName: string): string {
  return path.join(workspaceDir, "state", fileName);
}

function isMissingFileError(err: unknown): boolean {
  return (err as { code?: string }).code === "ENOENT";
}

export type JsonlReadResult<T> = {
  records: T[];
  malformedLines: number[];
};

/** Read every JSON line; malformed lines are reported (1-based) instead of aborting the read. */
export async function readJsonlRecords<T>(filePath: string): Promise<JsonlReadResult<T>> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (isMissingFileError(err)) {
      return { records: [], malformedLines: [] };
    }
    throw err;
  }
  const records: T[] = [];
  const malformedLines: number[] = [];
  content.split("\n").forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      malformedLines.push(index + 1);
    }
  });
  return { records, malformedLines };
}

function serializeJsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/** Append one JSON line under the file lock. */
export function appendJsonlRecord(filePath: string, record: unknown): Promise<void> {
  return withFileLock(filePath, () => fs.appendFile(filePath, serializeJsonl([record]), "utf-8"));
}

/** Read the JSONL file, then append the records `decide` returns, all under one lock. */
export function appendJsonlRecordsAfterRead<T, R>(
  filePath: string,
  decide: (current: JsonlReadResult<T>) => { append: unknown[]; result: R },
): Promise<R> {
  return withFileLock(filePath, async () => {
    const decision = decide(await readJsonlRecords<T>(filePath));
    if (decision.append.length > 0) {
      await fs.appendFile(filePath, serializeJsonl(decision.append), "utf-8");
    }
    return decision.result;
  });
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (isMissingFileError(err)) {
      return fallback;
    }
    throw err;
  }
  return content.trim().length === 0 ? fallback : (JSON.parse(content) as T);
}

/** Read-modify-write a JSON file under the file lock; the write is atomic (temp file + rename). */
export function updateJsonFile<T, R>(
  filePath: string,
  fallback: T,
  update: (current: T) => { next: T | undefined; result: R },
): Promise<R> {
  return withFileLock(filePath, async () => {
    const decision = update(await readJsonFile<T>(filePath, fallback));
    if (decision.next !== undefined) {
      await writeFileAtomic(filePath, `${JSON.stringify(decision.next, null, 2)}\n`);
    }
    return decision.result;
  });
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}
