// Extracts plain user/assistant text from the message snapshot `agent_end` receives.
type TranscriptRole = "user" | "assistant";

export type TranscriptTurn = {
  role: TranscriptRole;
  text: string;
};

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const candidate = block as { type?: unknown; text?: unknown } | null;
      return candidate?.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

export function extractTranscriptTurns(messages: readonly unknown[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const message of messages) {
    const record = message as { role?: unknown; content?: unknown } | null;
    if (record?.role !== "user" && record?.role !== "assistant") {
      continue;
    }
    const text = extractText(record.content).trim();
    if (text) {
      turns.push({ role: record.role, text });
    }
  }
  return turns;
}

export function lastTurn(
  turns: TranscriptTurn[],
  role: TranscriptRole,
): TranscriptTurn | undefined {
  return turns.findLast((turn) => turn.role === role);
}

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}
