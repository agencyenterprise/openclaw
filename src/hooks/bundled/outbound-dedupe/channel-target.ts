// The channel target used by every outbound-dedupe key. Slack ids are
// case-insensitive and prefixed (`channel:C…`); other channels keep their
// target verbatim.
import { normalizeSlackTarget } from "../../slack-thread.js";

export const SLACK_CHANNEL_ID = "slack";

export function canonicalTarget(channelId: string, target: string | undefined): string | undefined {
  if (channelId === SLACK_CHANNEL_ID) {
    return normalizeSlackTarget(target);
  }
  const trimmed = target?.trim();
  return trimmed ? trimmed : undefined;
}
