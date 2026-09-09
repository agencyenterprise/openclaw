// Covers whether a deployment has any surface that can answer an exec approval.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasExecApprovalDelivery } from "./exec-approval-availability.js";

function config(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("hasExecApprovalDelivery", () => {
  it("reports an approver when config is unavailable", () => {
    expect(hasExecApprovalDelivery(undefined)).toBe(true);
  });

  it("reports no approver for an empty config", () => {
    expect(hasExecApprovalDelivery(config({}))).toBe(false);
  });

  it("reports an approver when the generic forwarder is enabled", () => {
    expect(hasExecApprovalDelivery(config({ approvals: { exec: { enabled: true } } }))).toBe(true);
  });

  it("reports no approver when the forwarder is present but disabled", () => {
    expect(hasExecApprovalDelivery(config({ approvals: { exec: { enabled: false } } }))).toBe(
      false,
    );
  });

  it("reports no approver for the incident deployment: slack with execApprovals disabled", () => {
    expect(
      hasExecApprovalDelivery(
        config({
          channels: {
            slack: { botToken: "xoxb-token", execApprovals: { enabled: false, approvers: ["U1"] } },
          },
        }),
      ),
    ).toBe(false);
  });

  it("reports an approver when a configured channel leaves execApprovals unset", () => {
    expect(
      hasExecApprovalDelivery(config({ channels: { slack: { botToken: "xoxb-token" } } })),
    ).toBe(true);
  });

  it("treats auto as an available channel approver", () => {
    expect(
      hasExecApprovalDelivery(
        config({ channels: { slack: { botToken: "xoxb", execApprovals: { enabled: "auto" } } } }),
      ),
    ).toBe(true);
  });

  it("ignores a channel that is turned off entirely", () => {
    expect(
      hasExecApprovalDelivery(
        config({ channels: { slack: { enabled: false, botToken: "xoxb" } } }),
      ),
    ).toBe(false);
  });

  it("ignores a channel key with no meaningful configuration", () => {
    expect(hasExecApprovalDelivery(config({ channels: { slack: {} } }))).toBe(false);
  });

  it("reads per-account overrides before the channel default", () => {
    const cfg = config({
      channels: {
        slack: {
          execApprovals: { enabled: false },
          accounts: {
            primary: { botToken: "xoxb-a" },
            secondary: { botToken: "xoxb-b", execApprovals: { enabled: true } },
          },
        },
      },
    });
    expect(hasExecApprovalDelivery(cfg)).toBe(true);
  });

  it("reports no approver when every account inherits a disabled channel default", () => {
    const cfg = config({
      channels: {
        slack: {
          execApprovals: { enabled: false },
          accounts: { primary: { botToken: "xoxb-a" }, secondary: { botToken: "xoxb-b" } },
        },
      },
    });
    expect(hasExecApprovalDelivery(cfg)).toBe(false);
  });
});
