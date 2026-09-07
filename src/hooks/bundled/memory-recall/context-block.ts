// Formats retrieved memory as the prompt block the model sees before it plans.
import type { RetrievedItem } from "./retrieval.js";

export const RETRIEVED_MEMORY_HEADER =
  "Retrieved memory (leads, not verification; verify before citing):";
const ITEM_TEXT_MAX_CHARS = 240;
const ELLIPSIS = "…";

function toSingleLine(value: string): string {
  return value.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

function clipText(text: string): string {
  const collapsed = toSingleLine(text);
  if (collapsed.length <= ITEM_TEXT_MAX_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, ITEM_TEXT_MAX_CHARS - ELLIPSIS.length)}${ELLIPSIS}`;
}

export function formatRetrievedItem(item: RetrievedItem): string {
  const label = item.date ? `${item.source} ${toSingleLine(item.date)}` : item.source;
  return `[${label}] ${clipText(item.text)} — ref: ${toSingleLine(item.ref)}`;
}

/** Header plus as many item lines as fit under `maxChars`; undefined when no item fits. */
export function buildRetrievedMemoryBlock(
  items: readonly RetrievedItem[],
  limits: { maxItems: number; maxChars: number },
): string | undefined {
  const lines = [RETRIEVED_MEMORY_HEADER];
  let totalChars = RETRIEVED_MEMORY_HEADER.length;
  for (const item of items.slice(0, limits.maxItems)) {
    const line = formatRetrievedItem(item);
    const nextTotal = totalChars + 1 + line.length;
    if (nextTotal > limits.maxChars) {
      break;
    }
    lines.push(line);
    totalChars = nextTotal;
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}
