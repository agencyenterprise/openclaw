#!/usr/bin/env python3
"""Make opus-4-8 use the adaptive thinking format (like opus-4-7) instead of the
legacy thinking.type.enabled that opus-4-8 rejects. Surgical, asserted edits."""
import io, sys

ROOT = "/home/ubuntu/openclaw-fork-merge"

def patch(path, replacements):
    full = f"{ROOT}/{path}"
    s = open(full, encoding="utf-8").read()
    for old, new, n in replacements:
        cnt = s.count(old)
        assert cnt == n, f"{path}: expected {n} of <<{old[:60]}...>> found {cnt}"
        s = s.replace(old, new)
    open(full, "w", encoding="utf-8").write(s)
    print("patched", path)

# ---- A) src/agents/anthropic-transport-stream.ts (the actual format bug) ----
patch("src/agents/anthropic-transport-stream.ts", [
    (
'''function isClaudeOpus47Model(modelId: string): boolean {
  return modelId.includes("opus-4-7") || modelId.includes("opus-4.7");
}
''',
'''function isClaudeOpus47Model(modelId: string): boolean {
  return modelId.includes("opus-4-7") || modelId.includes("opus-4.7");
}

function isClaudeOpus48Model(modelId: string): boolean {
  return modelId.includes("opus-4-8") || modelId.includes("opus-4.8");
}
''', 1),
    (
'''  return (
    isClaudeOpus47Model(modelId) ||
    isClaudeOpus46Model(modelId) ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );''',
'''  return (
    isClaudeOpus48Model(modelId) ||
    isClaudeOpus47Model(modelId) ||
    isClaudeOpus46Model(modelId) ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );''', 1),
    (
'''      if (isClaudeOpus47Model(modelId)) {
        return "xhigh";
      }''',
'''      if (isClaudeOpus47Model(modelId) || isClaudeOpus48Model(modelId)) {
        return "xhigh";
      }''', 1),
])

# ---- B) src/agents/model-thinking-default.ts (default "off", like opus-4-7) ----
patch("src/agents/model-thinking-default.ts", [
    (
'''    normalizedProvider === "anthropic" &&
    (normalizedModel.startsWith("claude-opus-4-7") || normalizedModel.startsWith("claude-opus-4.7"))
  ) {
    return "off";''',
'''    normalizedProvider === "anthropic" &&
    (normalizedModel.startsWith("claude-opus-4-7") ||
      normalizedModel.startsWith("claude-opus-4.7") ||
      normalizedModel.startsWith("claude-opus-4-8") ||
      normalizedModel.startsWith("claude-opus-4.8"))
  ) {
    return "off";''', 1),
])

# ---- D) src/plugin-sdk/provider-model-shared.ts (thinking profile: levels + off default) ----
patch("src/plugin-sdk/provider-model-shared.ts", [
    (
'const CLAUDE_OPUS_47_MODEL_PREFIXES = ["claude-opus-4-7", "claude-opus-4.7"] as const;',
'''const CLAUDE_OPUS_47_MODEL_PREFIXES = [
  "claude-opus-4-7",
  "claude-opus-4.7",
  // opus-4-8 is a drop-in successor to 4-7: same adaptive-thinking profile + "off" default.
  "claude-opus-4-8",
  "claude-opus-4.8",
] as const;''', 1),
])

print("ALL PATCHES APPLIED OK")
