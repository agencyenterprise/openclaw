// Slack helper module reads the reply presentation config for an account.
import type { SlackReplyPresentationSettings } from "./markdown-presentation.js";

type SlackPresentationEntry = { presentation?: Partial<SlackReplyPresentationSettings> };

type SlackPresentationConfigSource = {
  channels?: {
    slack?: SlackPresentationEntry & { accounts?: Record<string, SlackPresentationEntry> };
  };
};

/** Read `channels.slack.presentation`, letting a per-account entry win. */
export function readSlackReplyPresentationConfig(
  cfg: unknown,
  accountId?: string,
): Partial<SlackReplyPresentationSettings> {
  const slack = (cfg as SlackPresentationConfigSource | undefined)?.channels?.slack;
  return {
    ...slack?.presentation,
    ...(accountId ? slack?.accounts?.[accountId]?.presentation : {}),
  };
}
