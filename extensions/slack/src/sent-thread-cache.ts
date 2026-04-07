import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/core";

/**
 * In-memory cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 * Follows a similar TTL pattern to the MS Teams and Telegram sent-message caches.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;

/**
 * Keep Slack thread participation shared across bundled chunks so thread
 * auto-reply gating does not diverge between prepare/dispatch call paths.
 */
const SLACK_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.slackThreadParticipation");
const threadParticipation = resolveGlobalDedupeCache(SLACK_THREAD_PARTICIPATION_KEY, {
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
});

function makeKey(accountId: string, channelId: string, threadTs: string): string {
  return `${accountId}:${channelId}:${threadTs}`;
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  threadParticipation.check(makeKey(accountId, channelId, threadTs));
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  return threadParticipation.peek(makeKey(accountId, channelId, threadTs));
}


/**
 * Check Slack thread history to see if the bot previously participated.
 * Used to rehydrate the in-memory cache after gateway restarts.
 * Only calls the Slack API if the in-memory cache misses — then warms the cache
 * so subsequent messages in the same thread don't re-query.
 */
export async function checkAndRehydrateThreadParticipation(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
  botUserId: string;
  client: { conversations: { replies: (opts: Record<string, unknown>) => Promise<Record<string, unknown>> } };
}): Promise<boolean> {
  const { accountId, channelId, threadTs, botUserId, client } = params;
  if (!accountId || !channelId || !threadTs || !botUserId) {
    return false;
  }

  // Already in cache — no API call needed
  if (hasSlackThreadParticipation(accountId, channelId, threadTs)) {
    return true;
  }

  try {
    // Fetch first page of thread replies (limit 50 is enough to detect bot presence)
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 50,
    }) as { messages?: Array<{ user?: string }> };

    const botParticipated = response.messages?.some((m) => m.user === botUserId) ?? false;

    if (botParticipated) {
      // Warm the cache so we don't re-query
      recordSlackThreadParticipation(accountId, channelId, threadTs);
    }

    return botParticipated;
  } catch {
    // API failure — don't block message processing
    return false;
  }
}

export function clearSlackThreadParticipationCache(): void {
  threadParticipation.clear();
}
