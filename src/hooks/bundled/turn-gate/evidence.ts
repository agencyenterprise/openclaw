// Evidence that a stated commitment was actually armed. A promise is backed only
// by an artifact the turn left behind: a job registration, a cron entry, an hcom
// hand-off, or a fresh `state/jobs.json`. Prose about intent is never evidence.
import fs from "node:fs/promises";
import { resolveWorkspaceStatePath } from "../../workspace-state.js";

export const JOBS_FILE = "jobs.json";

/** Command fragments that mean a job was really registered, not just described. */
export const DEFAULT_COMMAND_MARKERS = ["register_job.py", "cron add", "hcom codex"];

const CRON_TOOL_NAME_PREFIX = "cron";

export type TurnToolCall = {
  name: string;
  text: string;
};

function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (input === undefined || input === null) {
    return "";
  }
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

/**
 * The production shape. `agent_end` receives normalized OpenClaw `Message[]`
 * (packages/llm-core/src/types.ts), whose assistant tool calls are
 * `{ type: "toolCall", id, name, arguments }` — `arguments` is an object, and
 * the type tag is not the provider's `tool_use`.
 */
function readNormalizedToolCall(block: unknown): TurnToolCall | undefined {
  const record = block as { type?: unknown; name?: unknown; arguments?: unknown } | null;
  if (record?.type !== "toolCall" || typeof record.name !== "string") {
    return undefined;
  }
  return { name: record.name, text: stringifyToolInput(record.arguments) };
}

/**
 * Provider wire shape `{ type: "tool_use", name, input }`. Kept only because
 * cli-runner transcripts are not normalized; the embedded runner never emits it.
 */
function readWireContentBlockToolCall(block: unknown): TurnToolCall | undefined {
  const record = block as { type?: unknown; name?: unknown; input?: unknown } | null;
  if (record?.type !== "tool_use" || typeof record.name !== "string") {
    return undefined;
  }
  return { name: record.name, text: stringifyToolInput(record.input) };
}

/**
 * Provider wire shape `{ tool_calls: [{ function: { name, arguments } }] }`.
 * Same reason as above: only unnormalized cli-runner transcripts carry it.
 */
function readWireFunctionToolCall(entry: unknown): TurnToolCall | undefined {
  const fn = (entry as { function?: unknown } | null)?.function as
    | { name?: unknown; arguments?: unknown }
    | undefined;
  if (typeof fn?.name !== "string") {
    return undefined;
  }
  return { name: fn.name, text: stringifyToolInput(fn.arguments) };
}

/** Every tool call in the given messages: normalized shape first, wire shapes after. */
export function extractToolCalls(messages: readonly unknown[]): TurnToolCall[] {
  const calls: TurnToolCall[] = [];
  for (const message of messages) {
    const record = message as { content?: unknown; tool_calls?: unknown } | null;
    if (Array.isArray(record?.content)) {
      for (const block of record.content) {
        const call = readNormalizedToolCall(block) ?? readWireContentBlockToolCall(block);
        if (call) {
          calls.push(call);
        }
      }
    }
    if (Array.isArray(record?.tool_calls)) {
      for (const entry of record.tool_calls) {
        const call = readWireFunctionToolCall(entry);
        if (call) {
          calls.push(call);
        }
      }
    }
  }
  return calls;
}

function isCronTool(name: string): boolean {
  return name.toLowerCase().startsWith(CRON_TOOL_NAME_PREFIX);
}

/** Evidence descriptors from the turn's tool calls, deduplicated in scan order. */
export function findToolCallEvidence(
  toolCalls: readonly TurnToolCall[],
  commandMarkers: readonly string[],
): string[] {
  const found = new Set<string>();
  for (const call of toolCalls) {
    if (isCronTool(call.name)) {
      found.add(`tool:${call.name}`);
    }
    const haystack = `${call.name} ${call.text}`.toLowerCase();
    for (const marker of commandMarkers) {
      if (haystack.includes(marker.toLowerCase())) {
        found.add(`command:${marker}`);
      }
    }
  }
  return [...found];
}

/**
 * A `state/jobs.json` written during the turn is evidence even when the write
 * came from a script the transcript does not show. `turnStart` is unknown when
 * the turn carries neither a message timestamp nor a `durationMs`; the check is
 * then skipped rather than guessed, because a wrong window would invent
 * evidence that does not exist.
 */
export async function findJobsFileEvidence(
  workspaceDir: string,
  turnStart: Date | undefined,
): Promise<string | undefined> {
  if (!turnStart) {
    return undefined;
  }
  const jobsPath = resolveWorkspaceStatePath(workspaceDir, JOBS_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(jobsPath)).mtimeMs;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  return mtimeMs >= turnStart.getTime() ? `state/${JOBS_FILE} written` : undefined;
}
