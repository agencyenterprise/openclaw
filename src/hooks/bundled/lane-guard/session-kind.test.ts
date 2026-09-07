import { describe, expect, it } from "vitest";
import { classifyLaneSessionKind, LANE_SESSION_KINDS } from "./session-kind.js";

describe("lane-guard session kind", () => {
  it.each([
    // resolveIsolatedHeartbeatSessionKey appends `:heartbeat` to the woken session.
    ["agent:main:main:heartbeat"],
    ["agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609:heartbeat"],
    ["agent:main:slack:direct:u0a1b2c3:heartbeat"],
    // A thread suffix can follow the marker, so it is a segment, not just a suffix.
    ["agent:main:main:heartbeat:thread:1786591963.108609"],
    ["AGENT:MAIN:MAIN:HEARTBEAT"],
  ])("reads %s as a heartbeat session", (sessionKey) => {
    expect(classifyLaneSessionKind(sessionKey)).toBe("heartbeat");
  });

  it.each([
    // resolveCronAgentSessionKey, plus the per-run suffix an isolated run adds.
    ["agent:main:cron:nightly-harvest:run:20260903T100000"],
    ["agent:main:cron:job-1"],
    ["agent:worker-2:cron:job-1:run:run-1"],
    // The unscoped form a cron job binds before it is agent-scoped.
    ["cron:nightly-harvest"],
  ])("reads %s as a cron session", (sessionKey) => {
    expect(classifyLaneSessionKind(sessionKey)).toBe("cron");
  });

  it.each([
    ["agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609"],
    ["agent:main:slack:direct:u0a1b2c3"],
    ["agent:main:main"],
    ["agent:main:acp:8f1c2b0e"],
    // An agent that happens to be named "heartbeat" is not a heartbeat session.
    ["agent:heartbeat:main"],
    [undefined],
    [""],
  ])("reads %s as a human session", (sessionKey) => {
    expect(classifyLaneSessionKind(sessionKey)).toBe("human");
  });

  it("prefers heartbeat over cron when a heartbeat woke a cron session", () => {
    expect(classifyLaneSessionKind("agent:main:cron:job-1:heartbeat")).toBe("heartbeat");
  });

  it("reads a cron job merely named heartbeat as cron, since the marker is appended", () => {
    expect(classifyLaneSessionKind("agent:main:cron:heartbeat:run:r1")).toBe("cron");
    expect(classifyLaneSessionKind("agent:main:cron:heartbeat:job-2")).toBe("cron");
  });

  it("names exactly the kinds enforcement is configured per", () => {
    expect(LANE_SESSION_KINDS).toEqual(["heartbeat", "cron", "human"]);
  });
});
