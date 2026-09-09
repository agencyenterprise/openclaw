// Covers whether a deployment has any surface that can answer an exec approval.
// Answering false suppresses the approvals store, so it must rest on positive
// evidence that the operator turned channel approvals off - never on absence.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasExecApprovalDelivery,
  warnWhenExecApprovalsCannotBeDelivered,
} from "./exec-approval-availability.js";

function config(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("hasExecApprovalDelivery", () => {
  it("assumes an approver when config is unavailable", () => {
    expect(hasExecApprovalDelivery(undefined)).toBe(true);
  });

  it("assumes an approver for an empty config", () => {
    expect(hasExecApprovalDelivery(config({}))).toBe(true);
  });

  it("assumes an approver when nothing turns channel approvals off", () => {
    expect(hasExecApprovalDelivery(config({ approvals: { exec: { enabled: false } } }))).toBe(true);
  });

  it("assumes an approver for a channel that never mentions execApprovals", () => {
    expect(
      hasExecApprovalDelivery(config({ channels: { slack: { botToken: "xoxb-token" } } })),
    ).toBe(true);
  });

  it("assumes an approver for a channel turned off without disabling approvals", () => {
    expect(
      hasExecApprovalDelivery(
        config({ channels: { slack: { enabled: false, botToken: "xoxb" } } }),
      ),
    ).toBe(true);
  });

  it("reports an approver when the generic forwarder is enabled", () => {
    expect(
      hasExecApprovalDelivery(
        config({
          approvals: { exec: { enabled: true } },
          channels: { slack: { botToken: "xoxb", execApprovals: { enabled: false } } },
        }),
      ),
    ).toBe(true);
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

  it("reports no approver when the only channel is off and its approvals are disabled", () => {
    expect(
      hasExecApprovalDelivery(
        config({
          channels: {
            slack: { enabled: false, botToken: "xoxb", execApprovals: { enabled: false } },
          },
        }),
      ),
    ).toBe(false);
  });

  it("treats auto on a second channel as an available approver", () => {
    expect(
      hasExecApprovalDelivery(
        config({
          channels: {
            slack: { botToken: "xoxb", execApprovals: { enabled: false } },
            telegram: { botToken: "tg-token", execApprovals: { enabled: "auto" } },
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps a second channel that never disabled approvals as an approver", () => {
    expect(
      hasExecApprovalDelivery(
        config({
          channels: {
            slack: { botToken: "xoxb", execApprovals: { enabled: false } },
            discord: { botToken: "dc-token" },
          },
        }),
      ),
    ).toBe(true);
  });

  it("reads per-account overrides before the channel default", () => {
    expect(
      hasExecApprovalDelivery(
        config({
          channels: {
            slack: {
              execApprovals: { enabled: false },
              accounts: {
                primary: { botToken: "xoxb-a" },
                secondary: { botToken: "xoxb-b", execApprovals: { enabled: true } },
              },
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("reports no approver when every account inherits a disabled channel default", () => {
    expect(
      hasExecApprovalDelivery(
        config({
          channels: {
            slack: {
              execApprovals: { enabled: false },
              accounts: { primary: { botToken: "xoxb-a" }, secondary: { botToken: "xoxb-b" } },
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("reports no approver when a single account disables approvals for the only channel", () => {
    expect(
      hasExecApprovalDelivery(
        config({
          channels: {
            slack: {
              accounts: { primary: { botToken: "xoxb-a", execApprovals: { enabled: false } } },
            },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("warnWhenExecApprovalsCannotBeDelivered", () => {
  function capture(cfg: unknown): { warned: boolean; messages: string[] } {
    const messages: string[] = [];
    const warned = warnWhenExecApprovalsCannotBeDelivered({
      cfg: config(cfg),
      warn: (message) => messages.push(message),
    });
    return { warned, messages };
  }

  it("warns when approvals stay enabled but nothing in config can deliver them", () => {
    const result = capture({
      channels: { slack: { botToken: "xoxb", execApprovals: { enabled: false } } },
    });
    expect(result.warned).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toContain("tools.exec.approvalsDisabled");
  });

  it("stays quiet once the operator has declared there is no approver", () => {
    expect(
      capture({
        tools: { exec: { approvalsDisabled: true } },
        channels: { slack: { botToken: "xoxb", execApprovals: { enabled: false } } },
      }).warned,
    ).toBe(false);
  });

  it("stays quiet when an approver can deliver", () => {
    expect(capture({ channels: { slack: { botToken: "xoxb" } } }).warned).toBe(false);
  });

  it("stays quiet when config is unavailable", () => {
    expect(
      warnWhenExecApprovalsCannotBeDelivered({
        cfg: undefined,
        warn: () => {
          throw new Error("must not warn without config");
        },
      }),
    ).toBe(false);
  });
});
