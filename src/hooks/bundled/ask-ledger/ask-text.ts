// Text comparison for duplicate asks. Slack replays an outage message with the
// exact bytes the user typed, and the user's re-post differs only in the mention
// Slack renders in front of it, so case folding, whitespace collapsing and
// dropping the opening mentions is enough to recognize the same ask twice.

/** Slack renders a mention as `<@U0123>` or `<@U0123|name>`; the bot's own opens an ask. */
const LEADING_MENTIONS_RE = /^(?:\s*<@[^\s>]+>)+/;
const WHITESPACE_RE = /\s+/g;

/**
 * Normalize ask text for equality. Only the mentions that open the message are
 * dropped — the bot mention that made it an ask. Mentions inside the sentence
 * stay, so "ping <@U1> about the run" and "ping <@U2> about the run" remain
 * different asks.
 */
export function normalizeAskText(text: string): string {
  return text.replace(LEADING_MENTIONS_RE, "").replace(WHITESPACE_RE, " ").trim().toLowerCase();
}
