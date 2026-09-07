// Starting the repair turn. `enqueueSystemEvent` + `requestHeartbeat` is the pair
// the gateway's own `system-event` method runs for a targeted wake
// (src/gateway/server-methods/system.ts) and the pattern
// `enqueueRestartSentinelWake` follows (src/gateway/server-restart-sentinel.ts).
// `notifications-event` + `immediate` + reason `wake` + a session key is the one
// combination `isTargetedImmediateSystemEventWake` recognizes, so the repair runs
// even for an agent with no scheduled heartbeat and outside its active hours.
//
// The delivery context recovered from the session store carries the Slack channel
// and thread. Without it a heartbeat run deliberately drops the inherited thread
// id (src/infra/outbound/targets.ts), and the repair would lose its thread.
import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { resolveCronStoredDeliveryContext } from "../../../cron/delivery-context.js";
import { requestHeartbeat } from "../../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

/** Queues one repair turn for `sessionKey`. Returns false when the queue rejected it. */
export type RepairTurnSender = (params: { sessionKey: string; text: string }) => boolean;

export const sendRepairTurn: RepairTurnSender = ({ sessionKey, text }) => {
  const cfg = getRuntimeConfigSnapshot();
  const deliveryContext = cfg ? resolveCronStoredDeliveryContext({ cfg, sessionKey }) : undefined;
  const enqueued = enqueueSystemEvent(text, {
    sessionKey,
    ...(deliveryContext ? { deliveryContext } : {}),
  });
  if (!enqueued) {
    return false;
  }
  requestHeartbeat({
    source: "notifications-event",
    intent: "immediate",
    reason: "wake",
    sessionKey,
    heartbeat: { target: "last" },
  });
  return true;
};
