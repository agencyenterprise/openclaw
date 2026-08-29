import { describe, expect, it } from "vitest";
import { testing } from "./session-accessor.sqlite-entry-store.js";
import { cloneSessionEntry } from "./session-accessor.sqlite-scope.js";
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
        },
        disableModelInvocation: false,
      },
    ];
    const entry: SessionEntry = {
      sessionId: "session-1",
      skillsSnapshot: {
        prompt: "prompt",
        skills: [{ name: "deploy" }],
        resolvedSkills,
      },
    };

    const persisted = testing.normalizeSessionEntryForSqlitePersistence(entry);

    expect(persisted.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("resolvedSkills");
    expect(entry.skillsSnapshot?.resolvedSkills).toBe(resolvedSkills);
  });

  it("strips runtime-only resolvedSkills when cloning across the accessor boundary", () => {
    const entry: SessionEntry = {
      sessionId: "session-1",
      skillsSnapshot: {
        prompt: "prompt",
        skills: [{ name: "deploy" }],
        resolvedSkills: [],
      },
    };

    const cloned = cloneSessionEntry(entry);

    expect(cloned).not.toBe(entry);
    expect(cloned.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(entry.skillsSnapshot?.resolvedSkills).toEqual([]);
  });
});
