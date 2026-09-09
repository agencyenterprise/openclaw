// Answers whether any configured surface can receive an exec approval request.
import { hasMeaningfulChannelConfigShallow } from "../config/channel-configured-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";

function execApprovalsExplicitlyDisabled(record: Record<string, unknown>): boolean {
  const execApprovals = record.execApprovals;
  return isRecord(execApprovals) && execApprovals.enabled === false;
}

/** Channel-native approvals are opt-out: unset and "auto" both mean available. */
function surfaceCanDeliver(
  surface: Record<string, unknown>,
  inherited: Record<string, unknown>,
): boolean {
  if (surface.enabled === false) {
    return false;
  }
  return !execApprovalsExplicitlyDisabled(isRecord(surface.execApprovals) ? surface : inherited);
}

function channelCanDeliverExecApprovals(channel: unknown): boolean {
  if (!isRecord(channel) || !hasMeaningfulChannelConfigShallow(channel)) {
    return false;
  }
  if (channel.enabled === false) {
    return false;
  }
  const accounts = isRecord(channel.accounts) ? Object.values(channel.accounts) : [];
  if (accounts.length === 0) {
    return surfaceCanDeliver(channel, channel);
  }
  return accounts.some((account) => isRecord(account) && surfaceCanDeliver(account, channel));
}

/**
 * Whether any surface can receive an exec approval request.
 *
 * Two mechanisms deliver one: the generic approval forwarder
 * (`approvals.exec.enabled`, opt-in) and channel-native approval UI
 * (`channels.<id>.execApprovals.enabled`, opt-out). When neither exists nobody
 * can answer a prompt, so the approvals store cannot change an exec decision
 * that config already resolved to "full" with ask "off" - and a store that
 * cannot change the decision must never be able to block the command.
 *
 * This is a diagnostic, not an authorization decision. It reads static config
 * only, and static config cannot see a channel configured through environment
 * variables, the approvals socket, paired devices, or connected operator
 * clients - so a false here means "nothing in config can deliver", never
 * "nothing can deliver". The exec path must not bypass the approvals store on
 * this answer; only an explicit `tools.exec.approvalsDisabled` does that.
 */
export function hasExecApprovalDelivery(cfg: OpenClawConfig | undefined): boolean {
  if (!cfg) {
    return true;
  }
  if (cfg.approvals?.exec?.enabled === true) {
    return true;
  }
  const configured = (isRecord(cfg.channels) ? Object.values(cfg.channels) : []).filter(
    (channel): channel is Record<string, unknown> =>
      isRecord(channel) && hasMeaningfulChannelConfigShallow(channel),
  );
  if (!configured.some((channel) => hasExplicitExecApprovalsDisable(channel))) {
    // Nobody said "off", so nothing here proves an approver is absent.
    return true;
  }
  return configured.some((channel) => channelCanDeliverExecApprovals(channel));
}

/** Whether a channel or one of its accounts explicitly turns exec approvals off. */
function hasExplicitExecApprovalsDisable(channel: Record<string, unknown>): boolean {
  if (execApprovalsExplicitlyDisabled(channel)) {
    return true;
  }
  const accounts = isRecord(channel.accounts) ? Object.values(channel.accounts) : [];
  return accounts.some((account) => isRecord(account) && execApprovalsExplicitlyDisabled(account));
}

/**
 * Warn once per gateway start when exec approvals are left enabled while
 * nothing in config can deliver a request. Without this the deployment looks
 * gated but every prompt would go unanswered until it timed out, which is the
 * state that made a stuck approvals lock look like a policy denial.
 *
 * Returns whether it warned, so callers and tests can assert on it.
 */
export function warnWhenExecApprovalsCannotBeDelivered(params: {
  cfg: OpenClawConfig | undefined;
  warn: (message: string) => void;
}): boolean {
  if (params.cfg?.tools?.exec?.approvalsDisabled === true) {
    // The operator already declared there is no approver.
    return false;
  }
  if (hasExecApprovalDelivery(params.cfg)) {
    return false;
  }
  params.warn(
    [
      "exec approvals are enabled but nothing in config can deliver an approval request:",
      "approvals.exec.enabled is unset and every configured channel disables execApprovals.",
      "An exec that asks for approval will go unanswered until it times out.",
      "Configure an approver, tighten tools.exec.security, or set",
      "tools.exec.approvalsDisabled: true to declare that this deployment has no approver.",
    ].join(" "),
  );
  return true;
}
