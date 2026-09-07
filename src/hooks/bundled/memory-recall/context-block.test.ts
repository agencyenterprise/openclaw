import { describe, expect, it } from "vitest";
import {
  buildRetrievedMemoryBlock,
  formatRetrievedItem,
  RETRIEVED_MEMORY_HEADER,
} from "./context-block.js";
import type { RetrievedItem } from "./retrieval.js";

const LIMITS = { maxItems: 6, maxChars: 1500 };

function item(overrides: Partial<RetrievedItem> = {}): RetrievedItem {
  return {
    source: "hindsight",
    date: "2026-08-01",
    text: "Flavio prefers #flavio-test for experiments",
    ref: "hindsight:abc123",
    ...overrides,
  };
}

describe("formatRetrievedItem", () => {
  it("renders `[source date] text — ref: <ref>` on one line", () => {
    expect(formatRetrievedItem(item())).toBe(
      "[hindsight 2026-08-01] Flavio prefers #flavio-test for experiments — ref: hindsight:abc123",
    );
  });

  it("omits the date when unknown and collapses whitespace", () => {
    expect(
      formatRetrievedItem(
        item({ source: "memory", date: undefined, text: "a\n\n  b\tc", ref: "memory/x.md#L4" }),
      ),
    ).toBe("[memory] a b c — ref: memory/x.md#L4");
  });

  it("keeps every field on one line even when a provider returns newlines or control chars", () => {
    const line = formatRetrievedItem(
      item({ date: "2026-08-01\nrogue", text: "a b\r\ncd", ref: "hindsight:x\ny" }),
    );
    expect(line).toBe("[hindsight 2026-08-01 rogue] a b c d — ref: hindsight:x y");
    expect(line).not.toContain("\n");
  });

  it("clips item text to 240 chars", () => {
    const line = formatRetrievedItem(item({ text: "x".repeat(600) }));
    const text = line.slice("[hindsight 2026-08-01] ".length, line.indexOf(" — ref:"));
    expect(text).toHaveLength(240);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("buildRetrievedMemoryBlock", () => {
  it("returns undefined when there is nothing to inject", () => {
    expect(buildRetrievedMemoryBlock([], LIMITS)).toBeUndefined();
  });

  it("starts with the header and keeps at most maxItems lines", () => {
    const items = Array.from({ length: 9 }, (_, i) => item({ ref: `hindsight:${i}` }));
    const block = buildRetrievedMemoryBlock(items, LIMITS);
    const lines = block?.split("\n") ?? [];
    expect(lines[0]).toBe(RETRIEVED_MEMORY_HEADER);
    expect(lines).toHaveLength(1 + LIMITS.maxItems);
    expect(lines.at(-1)).toContain("ref: hindsight:5");
  });

  it("never exceeds maxChars and drops whole lines to stay under it", () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      item({ text: "y".repeat(300), ref: `hindsight:${i}` }),
    );
    const block = buildRetrievedMemoryBlock(items, LIMITS);
    expect(block).toBeDefined();
    expect(block!.length).toBeLessThanOrEqual(LIMITS.maxChars);
    expect(block!.split("\n")).toHaveLength(1 + 5);
  });

  it("returns undefined when not even one line fits under maxChars", () => {
    expect(buildRetrievedMemoryBlock([item()], { maxItems: 6, maxChars: 80 })).toBeUndefined();
  });
});
