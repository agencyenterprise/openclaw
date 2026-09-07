// Slack channel/thread identity helpers shared by the Fractal bundled hooks and
// by the outbound reply path that declares which ask a reply answers.
// Session keys look like `agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609`;
// delivery targets look like `channel:C0A3C98HS48` or a bare `C0A3C98HS48`.
const SESSION_CHANNEL_RE = /channel:([cdg][a-z0-9]+)/i;
const SESSION_THREAD_RE = /thread:(\d+\.\d+)/;
const SLACK_TS_RE = /^\d+\.\d+$/;
const TARGET_PREFIX_RE = /^(?:channel|user|group):/i;

export function extractSlackChannelFromSessionKey(
  sessionKey: string | undefined,
): string | undefined {
  return sessionKey?.match(SESSION_CHANNEL_RE)?.[1]?.toUpperCase();
}

export function extractSlackThreadTsFromSessionKey(
  sessionKey: string | undefined,
): string | undefined {
  return sessionKey?.match(SESSION_THREAD_RE)?.[1];
}

export function isSlackTs(value: unknown): value is string {
  return typeof value === "string" && SLACK_TS_RE.test(value);
}

export function normalizeSlackTarget(target: string | undefined): string | undefined {
  const stripped = target?.trim().replace(TARGET_PREFIX_RE, "");
  return stripped ? stripped.toUpperCase() : undefined;
}

export function isSlackDirectMessageChannel(channel: string | undefined): boolean {
  return typeof channel === "string" && channel.startsWith("D");
}

/**
 * The ask-ledger id of a Slack message: `<channel>:<ts>`. One obligation per
 * source message, so a replay of the same message is idempotent. It lives here
 * rather than in the ledger because the outbound reply path names the ask it
 * answers with the same id, and must not depend on a bundled hook to do it.
 */
export function buildAskId(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}
