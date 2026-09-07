import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLessonCandidate,
  createLessonCaptureHandler,
  LESSON_CANDIDATES_FILE,
  type LessonCandidate,
} from "./capture.js";
import { compileLessonTriggers, DEFAULT_LESSON_TRIGGERS } from "./triggers.js";

const SESSION = "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609";
const NOW = new Date("2026-09-03T12:00:00.000Z");

let workspaceDir = "";

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lesson-capture-"));
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

function turn(role: "user" | "assistant", text: string, asBlocks = false) {
  return { role, content: asBlocks ? [{ type: "text", text }] : text };
}

async function readCandidates(): Promise<LessonCandidate[]> {
  const content = await fs.readFile(
    path.join(workspaceDir, "state", LESSON_CANDIDATES_FILE),
    "utf-8",
  );
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LessonCandidate);
}

describe("buildLessonCandidate", () => {
  it("captures a closure verdict from the last assistant message", () => {
    const candidate = buildLessonCandidate({
      messages: [
        turn("user", "status now?"),
        turn("assistant", "Wave 4 finished. Lane VSB-002 CLOSED: p=0.03, effect held.", true),
      ],
      sessionKey: SESSION,
      triggers: DEFAULT_LESSON_TRIGGERS,
      now: NOW,
    });
    expect(candidate).toMatchObject({
      session_key: SESSION,
      channel: "C0A3C98HS48",
      thread_ts: "1786591963.108609",
      trigger: "assistant:CLOSED",
      created_at: NOW.toISOString(),
      status: "candidate",
    });
    expect(candidate?.excerpt).toContain("assistant: Wave 4 finished");
    expect(candidate?.excerpt).toContain("human: status now?");
  });

  it("captures a human correction even when the assistant text has no trigger", () => {
    const candidate = buildLessonCandidate({
      messages: [
        turn("assistant", "The sweep died; I restarted it."),
        turn("user", "this was bad, the sweep never died. This should never happen."),
        turn("assistant", "Understood, I reported blind while my shell was down."),
      ],
      sessionKey: SESSION,
      triggers: DEFAULT_LESSON_TRIGGERS,
      now: NOW,
    });
    expect(candidate?.trigger).toBe("human:should never");
  });

  it("recognizes an explicit human Correction: and lets it win over a result-like reply", () => {
    const candidate = buildLessonCandidate({
      messages: [
        turn("user", "Correction: the labeled probe does not cap the readout."),
        turn("assistant", "Understood. Updated result: the review was wrong on novelty."),
      ],
      sessionKey: SESSION,
      triggers: DEFAULT_LESSON_TRIGGERS,
      now: NOW,
    });
    expect(candidate?.trigger).toBe("human:Correction:");
  });

  it("matches uppercase patterns case-sensitively and others case-insensitively", () => {
    const compiled = compileLessonTriggers(DEFAULT_LESSON_TRIGGERS);
    expect(compiled.result.find((t) => t.name === "assistant:CLOSED")?.pattern.test("closed")).toBe(
      false,
    );
    expect(compiled.result.find((t) => t.name.includes("verdict"))?.pattern.test("VERDICT")).toBe(
      true,
    );
  });

  it("returns nothing for an ordinary turn and keeps the excerpt bounded", () => {
    expect(
      buildLessonCandidate({
        messages: [turn("user", "hi"), turn("assistant", "Hello, how can I help?")],
        sessionKey: SESSION,
        triggers: DEFAULT_LESSON_TRIGGERS,
        now: NOW,
      }),
    ).toBeUndefined();

    const candidate = buildLessonCandidate({
      messages: [turn("assistant", `${"a".repeat(3000)} verdict: pass`)],
      sessionKey: SESSION,
      triggers: DEFAULT_LESSON_TRIGGERS,
      now: NOW,
    });
    expect(candidate?.excerpt.length).toBeLessThanOrEqual(1500 + "assistant: ".length);
    expect(candidate?.excerpt.endsWith("verdict: pass")).toBe(true);
  });

  it("rejects an invalid trigger pattern loudly", () => {
    expect(() => compileLessonTriggers({ resultTriggers: ["("], correctionTriggers: [] })).toThrow(
      /invalid assistant trigger/,
    );
  });
});

describe("createLessonCaptureHandler", () => {
  it("writes one candidate per session, trigger and triggering message", async () => {
    const handler = createLessonCaptureHandler({
      resolveWorkspaceDir: () => workspaceDir,
      resolveTriggers: () => DEFAULT_LESSON_TRIGGERS,
      now: () => NOW,
    });
    const event = {
      messages: [
        turn("user", "verdict?"),
        turn("assistant", "Verdict: the probe caps the readout."),
      ],
      success: true,
    };
    const ctx = { sessionKey: SESSION };

    await handler(event, ctx);
    await handler(event, ctx);
    await handler(
      { ...event, messages: [turn("assistant", "Verdict: reversed after Lolo's correction.")] },
      ctx,
    );

    const candidates = await readCandidates();
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(2);
  });

  it("prefers the workspace from the agent context and keeps failed turns", async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "lesson-capture-ctx-"));
    try {
      const handler = createLessonCaptureHandler({
        resolveWorkspaceDir: () => workspaceDir,
        resolveTriggers: () => DEFAULT_LESSON_TRIGGERS,
      });
      const messages = [turn("user", "that is wrong"), turn("assistant", "Retrying.")];

      await handler({ messages, success: false }, { sessionKey: SESSION, workspaceDir: otherDir });

      await expect(fs.access(path.join(workspaceDir, "state"))).rejects.toThrow();
      const content = await fs.readFile(
        path.join(otherDir, "state", LESSON_CANDIDATES_FILE),
        "utf-8",
      );
      expect(content).toContain('"trigger":"human:\\\\bwrong\\\\b"');
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });
});
