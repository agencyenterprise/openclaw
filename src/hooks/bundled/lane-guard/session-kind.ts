// Which kind of session a command came from, which is what decides whether a
// refusal cancels it or is only recorded. `PluginHookToolContext` carries no
// discriminator for this (src/plugins/hook-types.ts), so the session key the
// runner built is the only evidence the guard has.
import { isCronSessionKey, parseAgentSessionKey } from "../../../routing/session-key.js";

export const LANE_SESSION_KINDS = ["heartbeat", "cron", "human"] as const;

export type LaneSessionKind = (typeof LANE_SESSION_KINDS)[number];

/**
 * The heartbeat runner *appends* `:heartbeat` to the session it wakes
 * (`resolveIsolatedHeartbeatSessionKey`, src/infra/heartbeat-runner.ts), and a
 * `:thread:<id>` suffix can follow it. Matching the appended marker rather than
 * the word anywhere keeps a cron job that happens to be named `heartbeat`
 * (`cron:heartbeat:run:<id>`) out.
 */
const HEARTBEAT_MARKER_RE = /(?:^|:)heartbeat(?::thread:[^:]+)?$/i;

/** Cron before it is agent-scoped: `cron:<jobId>` (src/cron/job-session-bindings.ts). */
const UNSCOPED_CRON_RE = /^cron:/i;

/** The part after `agent:<agentId>:`, or the whole key when it is not agent-scoped. */
function sessionKeyRest(sessionKey: string | undefined): string {
  const raw = sessionKey?.trim() ?? "";
  return parseAgentSessionKey(raw)?.rest ?? raw;
}

export function isHeartbeatSessionKey(sessionKey: string | undefined): boolean {
  return HEARTBEAT_MARKER_RE.test(sessionKeyRest(sessionKey));
}

/**
 * `isCronSessionKey` answers only for an agent-scoped key
 * (`agent:<agentId>:cron:<jobId>[:run:<runId>]`), which is what
 * `resolveCronAgentSessionKey` builds for an isolated run. The unscoped
 * `cron:<jobId>` form also reaches a session, so it counts as cron too.
 */
export function isCronKindSessionKey(sessionKey: string | undefined): boolean {
  return isCronSessionKey(sessionKey) || UNSCOPED_CRON_RE.test(sessionKey?.trim() ?? "");
}

/**
 * Heartbeat wins over cron: a cron session the heartbeat runner woke is still
 * unattended work, and the two kinds are enforced alike by default.
 *
 * `human` is the fallback, so an unrecognised key lands there. That is
 * deliberate but it is a real trade-off: a heartbeat that runs without
 * `heartbeat.isolatedSession` reuses its conversation's key and is
 * indistinguishable from a person's turn, so it reads as `human` and is only
 * audited. `alwaysCancel` still holds in every kind, which is what keeps the
 * outward-facing classes gated whatever the key looks like.
 */
export function classifyLaneSessionKind(sessionKey: string | undefined): LaneSessionKind {
  if (isHeartbeatSessionKey(sessionKey)) {
    return "heartbeat";
  }
  return isCronKindSessionKey(sessionKey) ? "cron" : "human";
}
