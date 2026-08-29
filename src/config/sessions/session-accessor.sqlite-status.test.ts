import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSqliteSessionEntryJson, testing } from "./session-accessor.sqlite-status.js";

function fixedLengthString(prefix: string, index: number, length: number): string {
  const suffix = `-${index}`;
  return `${prefix}${"x".repeat(Math.max(0, length - prefix.length - suffix.length))}${suffix}`;
}

describe("parseSqliteSessionEntryJson", () => {
  beforeEach(() => {
    testing.resetSessionEntryStringInternCache();
  });

  it("canonicalizes repeated skills snapshot strings during JSON materialization", () => {
    const prompt = "available skills\n".repeat(5000);
    const entryJson = JSON.stringify({
      skillsSnapshot: {
        prompt,
        skills: [
          {
            name: "slack",
            primaryEnv: "openclaw-workspace",
            requiredEnv: ["openclaw-workspace"],
          },
        ],
        skillFilter: ["slack"],
        nodeSkillsEligibility: { canExec: true, node: "openclaw-workspace" },
        resolvedSkills: [
          {
            name: "slack",
            description: "Send messages",
            filePath: "/repo/skills/slack/SKILL.md",
            baseDir: "/repo/skills/slack",
            source: "openclaw-bundled",
            sourceInfo: {
              path: "/repo/skills/slack/SKILL.md",
              source: "openclaw-bundled",
              scope: "project",
              origin: "top-level",
              baseDir: "/repo/skills/slack",
            },
            disableModelInvocation: false,
          },
        ],
      },
    });

    const first = parseSqliteSessionEntryJson({ entry_json: entryJson });
    const afterFirst = testing.sessionEntryStringInternStats();
    const second = parseSqliteSessionEntryJson({ entry_json: entryJson });
    const afterSecond = testing.sessionEntryStringInternStats();

    expect(first?.skillsSnapshot?.prompt).toBe(second?.skillsSnapshot?.prompt);
    expect(first?.skillsSnapshot?.skills[0]?.name).toBe(second?.skillsSnapshot?.skills[0]?.name);
    expect(first?.skillsSnapshot?.skills[0]?.primaryEnv).toBe(
      second?.skillsSnapshot?.skills[0]?.primaryEnv,
    );
    expect(first?.skillsSnapshot?.skills[0]?.requiredEnv?.[0]).toBe(
      second?.skillsSnapshot?.skills[0]?.requiredEnv?.[0],
    );
    expect(first?.skillsSnapshot?.skillFilter?.[0]).toBe(second?.skillsSnapshot?.skillFilter?.[0]);
    expect(first?.skillsSnapshot?.nodeSkillsEligibility?.node).toBe(
      second?.skillsSnapshot?.nodeSkillsEligibility?.node,
    );
    expect(first?.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(second?.skillsSnapshot?.resolvedSkills).toBeUndefined();
    expect(testing.internSessionEntryString(prompt)).toBe(first?.skillsSnapshot?.prompt);
    expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits);
    expect(afterSecond.retainedUtf16Bytes).toBeLessThanOrEqual(afterSecond.maxUtf16Bytes);
    expect(afterSecond.size).toBeGreaterThan(0);
  });

  it("skips oversized strings instead of retaining them in the intern cache", () => {
    const oversized = "x".repeat(
      testing.sessionEntryStringInternStats().maxStringUtf16Bytes / 2 + 1,
    );

    testing.internSessionEntryString(oversized);

    expect(testing.sessionEntryStringInternStats()).toMatchObject({
      hits: 0,
      retainedUtf16Bytes: 0,
      size: 0,
    });
  });

  it("evicts oldest entries when the count budget is exceeded", () => {
    for (let index = 0; index < 4100; index += 1) {
      testing.internSessionEntryString(`fifo-${index}`);
    }
    const afterPressure = testing.sessionEntryStringInternStats();

    testing.internSessionEntryString("fifo-0");
    const afterOldestRetry = testing.sessionEntryStringInternStats();
    testing.internSessionEntryString("fifo-4099");
    const afterNewestRetry = testing.sessionEntryStringInternStats();

    expect(afterPressure.size).toBe(4096);
    expect(afterOldestRetry.hits).toBe(afterPressure.hits);
    expect(afterNewestRetry.hits).toBe(afterOldestRetry.hits + 1);
    expect(afterNewestRetry.retainedUtf16Bytes).toBeLessThanOrEqual(afterNewestRetry.maxUtf16Bytes);
  });

  it("evicts oldest entries when the retained byte budget is exceeded", () => {
    const stats = testing.sessionEntryStringInternStats();
    const stringLength = stats.maxStringUtf16Bytes / 2;
    for (let index = 0; index < 40; index += 1) {
      testing.internSessionEntryString(fixedLengthString("byte-budget", index, stringLength));
    }
    const afterPressure = testing.sessionEntryStringInternStats();

    testing.internSessionEntryString(fixedLengthString("byte-budget", 0, stringLength));
    const afterOldestRetry = testing.sessionEntryStringInternStats();
    testing.internSessionEntryString(fixedLengthString("byte-budget", 39, stringLength));
    const afterNewestRetry = testing.sessionEntryStringInternStats();

    expect(afterPressure.size).toBeLessThan(40);
    expect(afterPressure.retainedUtf16Bytes).toBeLessThanOrEqual(afterPressure.maxUtf16Bytes);
    expect(afterOldestRetry.hits).toBe(afterPressure.hits);
    expect(afterNewestRetry.hits).toBe(afterOldestRetry.hits + 1);
    expect(afterNewestRetry.retainedUtf16Bytes).toBeLessThanOrEqual(afterNewestRetry.maxUtf16Bytes);
  });

  it("keeps repeated parsed prompts to one V8 string backing", () => {
    const scriptPath = path.join(
      os.tmpdir(),
      `openclaw-session-intern-child-${process.pid}-${Date.now()}.cjs`,
    );
    fs.writeFileSync(
      scriptPath,
      `
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const v8 = require("node:v8");

(async () => {
  const mode = process.argv[2];
  const parserUrl = pathToFileURL(path.resolve(process.cwd(), "src/config/sessions/session-accessor.sqlite-status.ts")).href;
  const { parseSqliteSessionEntryJson } = await import(parserUrl);
  const marker = "OPENCLAW_HEAP_INTERN_CHILD_" + process.pid + "_" + Date.now();
  const prompt = marker + "_" + "p".repeat(48 * 1024);
  const row = { entry_json: JSON.stringify({ skillsSnapshot: { prompt, skills: [] } }) };
  function parseRow() {
    return mode === "intern" ? parseSqliteSessionEntryJson(row) : JSON.parse(row.entry_json);
  }
  const entries = Array.from({ length: 80 }, parseRow);
  const snapshotPath = v8.writeHeapSnapshot(path.join(os.tmpdir(), "openclaw-session-intern-child-" + process.pid + ".heapsnapshot"));
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    const nodeFields = snapshot.snapshot.meta.node_fields;
    const nodeTypes = snapshot.snapshot.meta.node_types;
    const typeIndex = nodeFields.indexOf("type");
    const nameIndex = nodeFields.indexOf("name");
    const fieldCount = nodeFields.length;
    let markerStringNodes = 0;
    for (let index = 0; index < snapshot.nodes.length; index += fieldCount) {
      const type = nodeTypes[typeIndex][snapshot.nodes[index + typeIndex]];
      const name = snapshot.strings[snapshot.nodes[index + nameIndex]];
      if ((type === "string" || type === "sliced string" || type === "concatenated string") && name.includes(marker)) {
        markerStringNodes += 1;
      }
    }
    console.log(JSON.stringify({ entries: entries.length, markerStringNodes }));
  } finally {
    fs.unlinkSync(snapshotPath);
  }
})();
`,
      "utf8",
    );
    try {
      const runChild = (mode: string) => {
        const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, mode], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as { entries: number; markerStringNodes: number };
      };

      const control = runChild("control");
      const interned = runChild("intern");

      expect(control.entries).toBe(80);
      expect(interned.entries).toBe(80);
      expect(control.markerStringNodes).toBeGreaterThan(40);
      expect(interned.markerStringNodes).toBeLessThan(8);
    } finally {
      fs.unlinkSync(scriptPath);
    }
  });
});
