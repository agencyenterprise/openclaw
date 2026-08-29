import { describe, expect, it } from "vitest";
import type { Skill } from "../../skills/loading/skill-contract.js";
import { testing } from "./session-accessor.sqlite-entry-store.js";
import { cloneSessionEntry } from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryJson } from "./session-accessor.sqlite-status.js";
import type { SessionEntry } from "./types.js";

describe("normalizeSessionEntryForSqlitePersistence", () => {
  it("strips runtime-only resolvedSkills before SQLite JSON persistence", () => {
    const resolvedSkills = [
      {
        name: "deploy",
        description: "Deploy",
        filePath: "/skills/deploy/SKILL.md",
        baseDir: "/skills/deploy",
        source: "workspace",
        sourceInfo: {
          path: "/skills/deploy/SKILL.md",
          source: "workspace",
          scope: "project",
          origin: "top-level",
          baseDir: "/skills/deploy",
        },
        disableModelInvocation: false,
      },
    ] satisfies Skill[];
    const entry = {
      sessionId: "session-1",
      updatedAt: 1,
      skillsSnapshot: {
        prompt: "prompt",
        skills: [{ name: "deploy" }],
        resolvedSkills,
      },
    } satisfies SessionEntry;

    const persisted = testing.normalizeSessionEntryForSqlitePersistence(entry);

    expect(persisted.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("resolvedSkills");
    expect(entry.skillsSnapshot?.resolvedSkills).toBe(resolvedSkills);
  });

  it("strips runtime-only resolvedSkills when cloning across the accessor boundary", () => {
    const entry = {
      sessionId: "session-1",
      updatedAt: 1,
      skillsSnapshot: {
        prompt: "prompt",
        skills: [{ name: "deploy" }],
        resolvedSkills: [],
      },
    } satisfies SessionEntry;

    const cloned = cloneSessionEntry(entry);

    expect(cloned).not.toBe(entry);
    expect(cloned.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(entry.skillsSnapshot?.resolvedSkills).toEqual([]);
  });

  it("strips systemPromptReport across the accessor clone boundary", () => {
    const report: NonNullable<SessionEntry["systemPromptReport"]> = {
      source: "run",
      generatedAt: Date.now(),
      bootstrapTruncation: {
        warningMode: "once",
        warningSignaturesSeen: ["sig-a", "sig-b"],
      },
      systemPrompt: { chars: 1, projectContextChars: 1, nonProjectContextChars: 0 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 0, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    };
    const entry = {
      sessionId: "session-1",
      updatedAt: 1,
      systemPromptReport: report,
    } satisfies SessionEntry;
    const cloned = cloneSessionEntry(entry);

    expect(cloned).not.toBe(entry);
    expect(cloned.systemPromptReport).toBeUndefined();
    expect(cloned.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(entry.systemPromptReport).toEqual(report);
  });

  it("keeps malformed legacy warningSignaturesSeen from discarding the row", () => {
    const signatures = Array.from({ length: 40 }, (_, index) => `sig-${index}`);
    const parsed = parseSqliteSessionEntryJson({
      entry_json: JSON.stringify({
        sessionId: "session-legacy",
        systemPromptReport: {
          source: "run",
          generatedAt: Date.now(),
          bootstrapTruncation: {
            warningMode: "once",
            warningSignaturesSeen: [123, "sig-a", {}, ...signatures],
          },
          systemPrompt: { chars: 1, projectContextChars: 1, nonProjectContextChars: 0 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      }),
    });

    expect(parsed?.sessionId).toBe("session-legacy");
    expect(parsed?.systemPromptReport).toBeUndefined();
    expect(parsed?.bootstrapPromptWarningSignaturesSeen).toHaveLength(32);
    expect(parsed?.bootstrapPromptWarningSignaturesSeen?.at(0)).toBe("sig-8");
    expect(parsed?.bootstrapPromptWarningSignaturesSeen?.at(-1)).toBe("sig-39");
  });
});
