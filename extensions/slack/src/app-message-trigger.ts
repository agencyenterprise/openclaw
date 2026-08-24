// Slack plugin module detects app-attributed user messages that engage the bot.
import type { SlackAppMessageTriggerConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { SlackMessageEvent } from "./types.js";

const compiledTextPatterns = new Map<string, RegExp | null>();

function compileTextPattern(pattern: string): RegExp | null {
  const cached = compiledTextPatterns.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern, "u");
  } catch {
    // Config validation rejects invalid patterns; never let a stale one crash inbound handling.
    logVerbose(`slack: ignoring invalid appMessageTriggers textPattern ${JSON.stringify(pattern)}`);
    compiled = null;
  }
  compiledTextPatterns.set(pattern, compiled);
  return compiled;
}

/**
 * True when a user message carries a configured app attribution (for example
 * Slack's "Sent using @Claude" trail) and must engage the bot as if it were
 * an explicit mention. A trigger matches on author plus either the event's
 * `app_id` or the rendered trail text.
 */
export function matchesSlackAppMessageTrigger(params: {
  triggers: readonly SlackAppMessageTriggerConfig[] | undefined;
  message: Pick<SlackMessageEvent, "user" | "app_id" | "text">;
}): boolean {
  const { triggers, message } = params;
  if (!triggers?.length || !message.user) {
    return false;
  }
  return triggers.some((trigger) => {
    if (trigger.userId !== message.user) {
      return false;
    }
    if (trigger.appId && message.app_id === trigger.appId) {
      return true;
    }
    if (trigger.textPattern && message.text) {
      return compileTextPattern(trigger.textPattern)?.test(message.text) ?? false;
    }
    return false;
  });
}
