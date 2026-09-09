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
 * Whether any configured surface can receive an exec approval request.
 *
 * Two mechanisms deliver one: the generic approval forwarder
 * (`approvals.exec.enabled`, opt-in) and channel-native approval UI
 * (`channels.<id>.execApprovals.enabled`, opt-out). When neither exists nobody
 * can answer a prompt, so the approvals store cannot change an exec decision
 * that config already resolved to "full" with ask "off" - and a store that
 * cannot change the decision must never be able to block the command.
 */
export function hasExecApprovalDelivery(cfg: OpenClawConfig | undefined): boolean {
  if (!cfg) {
    // Without config we cannot prove there is no approver; assume there is one.
    return true;
  }
  if (cfg.approvals?.exec?.enabled === true) {
    return true;
  }
  const channels = isRecord(cfg.channels) ? cfg.channels : {};
  return Object.values(channels).some((channel) => channelCanDeliverExecApprovals(channel));
}
