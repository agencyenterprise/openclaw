/** Resolve dispatch authority from the persisted job, never the active UI session. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronAgentSessionKey } from "../cron/isolated-agent/session-key.js";
import { resolveCronSessionTargetSessionKey } from "../cron/session-target.js";
import type { CronJob } from "../cron/types.js";

export function resolveCronDispatchOrigin(
  job: CronJob,
  agentId: string,
  cfg: OpenClawConfig,
): string {
  const explicit = resolveCronSessionTargetSessionKey(job.sessionTarget);
  const source = explicit ?? job.sessionKey?.trim();
  // A current target without its persisted origin cannot be proved unrelated.
  if (!source && job.sessionTarget === "current") throw new Error("THREAD_DISPATCH_ORIGIN_MISSING");
  const key =
    source ||
    (job.sessionTarget === "main"
      ? "main"
      : job.sessionTarget === "isolated"
        ? `cron:${job.id}`
        : undefined);
  if (!key) throw new Error("THREAD_DISPATCH_ORIGIN_MISSING");
  return resolveCronAgentSessionKey({
    sessionKey: key,
    agentId,
    mainKey: cfg.session?.mainKey,
    cfg,
  });
}
