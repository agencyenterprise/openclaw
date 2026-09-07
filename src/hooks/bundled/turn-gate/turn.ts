// Scoping the transcript to the turn that just ended. `agent_end` receives
// `state.messagesSnapshot` (src/agents/embedded-agent-runner/run/attempt-after-turn.ts),
// which is the WHOLE session transcript, not this turn. Without this slice an
// old cron registration from any earlier turn would back a promise made now.
export type TurnSlice = {
  messages: readonly unknown[];
  startedAt: Date | undefined;
};

function isUserMessage(message: unknown): boolean {
  return (message as { role?: unknown } | null)?.role === "user";
}

/** Normalized messages carry `timestamp` as Unix milliseconds. */
function readTimestamp(message: unknown): Date | undefined {
  const timestamp = (message as { timestamp?: unknown } | null)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? new Date(timestamp)
    : undefined;
}

/**
 * The current turn is everything from the last user message onward. A runtime
 * context carrier is itself a user message appended right after the real user
 * turn, so slicing at the LAST user message stays inside the current turn.
 * A transcript with no user message at all is treated as one turn.
 */
export function sliceCurrentTurn(messages: readonly unknown[]): TurnSlice {
  const lastUserIndex = messages.findLastIndex(isUserMessage);
  const sliced = lastUserIndex >= 0 ? messages.slice(lastUserIndex) : messages;
  return { messages: sliced, startedAt: readTimestamp(sliced[0]) };
}
