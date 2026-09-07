import { describe, expect, it } from "vitest";
import { fingerprintOutboundContent, normalizeOutboundContent } from "./content-fingerprint.js";

describe("outbound content fingerprint", () => {
  it("ignores case and whitespace", () => {
    expect(fingerprintOutboundContent("Hello  World")).toBe(
      fingerprintOutboundContent("hello\nworld"),
    );
  });

  it("ignores dates, clock times, Slack ts and permalinks", () => {
    const first =
      "Restart attempted at 2026-08-25T10:00:00Z (14:05 UTC), see https://agencyenterprise.slack.com/archives/C0A3C98HS48/p1787680929480709 msg 1787680929.480709";
    const second =
      "Restart attempted at 2026-08-25T21:00:00Z (23:59 UTC), see https://agencyenterprise.slack.com/archives/C0A3C98HS48/p1787690000000000 msg 1787690000.000000";
    expect(fingerprintOutboundContent(first)).toBe(fingerprintOutboundContent(second));
  });

  it("keeps every other number, including durations and counters", () => {
    expect(fingerprintOutboundContent("Foundry stale for 368 min")).not.toBe(
      fingerprintOutboundContent("Foundry stale for 1219 min"),
    );
    expect(fingerprintOutboundContent("p = 0.03 on wave 4")).not.toBe(
      fingerprintOutboundContent("p = 0.04 on wave 4"),
    );
    expect(fingerprintOutboundContent("restart in 5 min")).not.toBe(
      fingerprintOutboundContent("restart in 60 min"),
    );
    expect(fingerprintOutboundContent("deploy release-2026-09-03-rc1")).not.toBe(
      fingerprintOutboundContent("deploy release-2026-09-04-rc1"),
    );
  });

  it("exposes the normalized form", () => {
    expect(normalizeOutboundContent("Stale 5 min\nat 12:30 UTC on 2026-09-03")).toBe(
      "stale5minaton",
    );
  });
});
