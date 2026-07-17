import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendSlackInboundRecoveryLog } from "./inbound-recovery-log.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-inbound-recovery-"));
  tempDirs.push(dir);
  return path.join(dir, "nested", "inbound-log.jsonl");
}

describe("appendSlackInboundRecoveryLog", () => {
  it("persists the reviewer recovery schema with restrictive permissions", () => {
    const targetPath = makeTarget();
    const ok = appendSlackInboundRecoveryLog(
      {
        channel: "C123",
        threadTs: "100.1",
        messageTs: "100.2",
        user: "U123",
        textLen: 17,
        source: "app_mention",
      },
      { targetPath, nowMs: 1234 },
    );

    expect(ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(targetPath, "utf8"))).toEqual({
      version: 1,
      ts: 1234,
      channel: "C123",
      threadTs: "100.1",
      messageTs: "100.2",
      user: "U123",
      textLen: 17,
      source: "app_mention",
    });
    expect(fs.statSync(targetPath).mode & 0o777).toBe(0o600);
  });

  it("rotates the bounded journal before appending", () => {
    const targetPath = makeTarget();
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "old-record\n");

    const ok = appendSlackInboundRecoveryLog(
      {
        channel: "C123",
        messageTs: "100.2",
        textLen: 1,
        source: "app_mention",
      },
      { targetPath, maxBytes: 12, nowMs: 1234 },
    );

    expect(ok).toBe(true);
    expect(fs.readFileSync(`${targetPath}.1`, "utf8")).toBe("old-record\n");
    expect(fs.readFileSync(targetPath, "utf8")).toContain('"version":1');
  });

  it("fails closed without throwing into Slack dispatch", () => {
    expect(
      appendSlackInboundRecoveryLog(
        { channel: "C123", messageTs: "100.2", textLen: 1, source: "app_mention" },
        { targetPath: "/dev/null/inbound-log.jsonl" },
      ),
    ).toBe(false);
  });
});
