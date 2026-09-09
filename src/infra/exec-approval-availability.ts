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
 * Answering false is an authorization decision, so it is only returned on
 * positive evidence that the operator turned channel approvals off. Missing
 * configuration is never such evidence: paired devices, the approvals socket
 * and connected operator clients are runtime state no config read can see.
 *
 * Known gap: a channel configured purely through environment variables has no
 * `channels.<id>` entry, so it is invisible here. It is only reachable when
 * some other channel carries an explicit `execApprovals.enabled: false`.
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
