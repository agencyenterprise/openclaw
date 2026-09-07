// Append-only evidence of every retrieval at `<workspace>/state/retrieval_log.jsonl`.
// Every field is always present (null when unknown) so consumers see one schema.
import { createHash } from "node:crypto";
import { appendJsonlRecordsAfterRead, resolveWorkspaceStatePath } from "../../workspace-state.js";
import type { RetrievalOutcome, RetrievalSource } from "./retrieval.js";

export const RETRIEVAL_LOG_FILE = "retrieval_log.jsonl";
const QUERY_LOG_MAX_CHARS = 200;

export type RetrievalLogEntry = {
  ts: string;
  session_key: string;
  message_id: string;
  /** Identifies the exact query so an edited message gets its own line. */
  query_digest: string;
  channel: string | null;
  thread_ts: string | null;
  query: string;
  hindsight_hits: number;
  markdown_hits: number;
  ms: number;
  failed_sources: RetrievalSource[];
  error: string | null;
  injected_chars: number;
};

export function digestQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 16);
}

export function buildRetrievalLogEntry(params: {
  now: Date;
  sessionKey: string;
  messageId: string;
  channel?: string;
  threadTs?: string;
  query: string;
  outcome: RetrievalOutcome;
  injectedChars: number;
}): RetrievalLogEntry {
  return {
    ts: params.now.toISOString(),
    session_key: params.sessionKey,
    message_id: params.messageId,
    query_digest: digestQuery(params.query),
    channel: params.channel ?? null,
    thread_ts: params.threadTs ?? null,
    query: params.query.slice(0, QUERY_LOG_MAX_CHARS),
    hindsight_hits: params.outcome.hindsightHits,
    markdown_hits: params.outcome.markdownHits,
    ms: params.outcome.ms,
    failed_sources: params.outcome.failedSources,
    error: params.outcome.error ?? null,
    injected_chars: params.injectedChars,
  };
}

function isSameRetrieval(existing: RetrievalLogEntry, entry: RetrievalLogEntry): boolean {
  return (
    existing.session_key === entry.session_key &&
    existing.message_id === entry.message_id &&
    existing.query_digest === entry.query_digest
  );
}

/**
 * Append under the file lock unless a line for the same session + message id +
 * query already exists, so redeliveries and restarts never double-log a turn
 * while an edited message still gets its own line. Returns whether a line was written.
 */
export function appendRetrievalLogEntry(
  workspaceDir: string,
  entry: RetrievalLogEntry,
): Promise<boolean> {
  const filePath = resolveWorkspaceStatePath(workspaceDir, RETRIEVAL_LOG_FILE);
  return appendJsonlRecordsAfterRead<RetrievalLogEntry, boolean>(filePath, (current) => {
    const alreadyLogged = current.records.some((existing) => isSameRetrieval(existing, entry));
    return alreadyLogged ? { append: [], result: false } : { append: [entry], result: true };
  });
}
