import { describe, expect, it } from "vitest";
import { LruMap } from "./lru-map.js";

describe("LruMap", () => {
  it("evicts the least recently used entry, treating reads as use", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1);
    map.set("c", 3);
    expect(map.has("b")).toBe(false);
    expect(map.has("a")).toBe(true);
    expect(map.has("c")).toBe(true);
  });

  it("stores undefined values distinguishably from missing keys", () => {
    const map = new LruMap<string, string | undefined>(2);
    map.set("a", undefined);
    expect(map.has("a")).toBe(true);
    expect(map.get("a")).toBeUndefined();
    expect(map.has("b")).toBe(false);
  });
});
