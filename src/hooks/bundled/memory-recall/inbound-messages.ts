// Remembers the last few human messages per thread so the prompt-build hook can
// add the thread's previous human message to the retrieval query. Bot-authored
// message ids are remembered too, so a turn for one of them is skipped even when
// the channel context reaching the hook lacks the bot flag.
import { LruMap } from "./lru-map.js";

export type InboundMessage = {
  messageId: string;
  text: string;
  threadId?: string;
};

const DEFAULT_MAX_THREADS = 500;
const DEFAULT_MAX_MESSAGES_PER_THREAD = 3;
/**
 * Redelivery window per thread, independent of the retained history: wide enough
 * that a message the history already dropped is still recognised as a redelivery,
 * small enough that a busy thread cannot grow the stash without bound.
 */
const DEFAULT_MAX_SEEN_IDS_PER_THREAD = 32;
const DEFAULT_MAX_REJECTED_IDS = 2000;
const QUERY_MAX_CHARS = 1000;

/** One thread's retained history and its redelivery window, so both evict together. */
type ThreadState = {
  history: InboundMessage[];
  seenIds: LruMap<string, true>;
};

export class InboundMessageStash {
  private readonly threads: LruMap<string, ThreadState>;
  private readonly rejectedBotMessages: LruMap<string, true>;
  private readonly maxMessagesPerThread: number;
  private readonly maxSeenIdsPerThread: number;

  constructor(
    limits: {
      maxThreads?: number;
      maxMessagesPerThread?: number;
      maxSeenIdsPerThread?: number;
      maxRejectedIds?: number;
    } = {},
  ) {
    this.threads = new LruMap(limits.maxThreads ?? DEFAULT_MAX_THREADS);
    this.rejectedBotMessages = new LruMap(limits.maxRejectedIds ?? DEFAULT_MAX_REJECTED_IDS);
    this.maxMessagesPerThread = limits.maxMessagesPerThread ?? DEFAULT_MAX_MESSAGES_PER_THREAD;
    this.maxSeenIdsPerThread = limits.maxSeenIdsPerThread ?? DEFAULT_MAX_SEEN_IDS_PER_THREAD;
  }

  /** A human record is authoritative: it also clears an earlier bot rejection of the same id. */
  record(sessionKey: string, message: InboundMessage): void {
    this.rejectedBotMessages.delete(turnKey(sessionKey, message.messageId));
    const key = threadKey(sessionKey, message.threadId);
    const thread = this.threads.get(key) ?? this.startThread(key);
    const retained = thread.history.findIndex((entry) => entry.messageId === message.messageId);
    if (retained >= 0) {
      // Redelivery of a retained message: refresh the text in place, keep the order.
      thread.history[retained] = message;
    } else if (!thread.seenIds.has(message.messageId)) {
      thread.history = [...thread.history, message].slice(-this.maxMessagesPerThread);
    }
    // A redelivery the history already dropped is not stashed again, but stays in the window.
    thread.seenIds.set(message.messageId, true);
  }

  rejectBotMessage(sessionKey: string, messageId: string): void {
    this.rejectedBotMessages.set(turnKey(sessionKey, messageId), true);
  }

  isRejectedBotMessage(sessionKey: string, messageId: string): boolean {
    return this.rejectedBotMessages.has(turnKey(sessionKey, messageId));
  }

  /** The stashed message with this id in its thread, if still remembered. */
  find(
    sessionKey: string,
    threadId: string | undefined,
    messageId: string,
  ): InboundMessage | undefined {
    return this.threads
      .get(threadKey(sessionKey, threadId))
      ?.history.find((entry) => entry.messageId === messageId);
  }

  /** The latest human message before `message` in the same thread; none outside a thread. */
  findThreadContext(sessionKey: string, message: InboundMessage): InboundMessage | undefined {
    if (!message.threadId) {
      return undefined;
    }
    const history = this.threads.get(threadKey(sessionKey, message.threadId))?.history ?? [];
    const position = history.findIndex((entry) => entry.messageId === message.messageId);
    const earlier = position >= 0 ? history.slice(0, position) : history;
    return earlier.at(-1);
  }

  private startThread(key: string): ThreadState {
    const thread: ThreadState = { history: [], seenIds: new LruMap(this.maxSeenIdsPerThread) };
    this.threads.set(key, thread);
    return thread;
  }
}

/** Collision-free identity of one inbound turn (a plain join would conflate `a:b`+`c` with `a`+`b:c`). */
export function turnKey(sessionKey: string, messageId: string): string {
  return JSON.stringify([sessionKey, messageId]);
}

function threadKey(sessionKey: string, threadId: string | undefined): string {
  return JSON.stringify([sessionKey, threadId ?? null]);
}

export function buildRetrievalQuery(text: string, threadContext?: InboundMessage): string {
  const parts = [text.trim()];
  if (threadContext) {
    parts.push(threadContext.text.trim());
  }
  return parts.join("\n").slice(0, QUERY_MAX_CHARS);
}
