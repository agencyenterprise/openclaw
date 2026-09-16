/** Monitor lifecycle for the explicitly selected Slack journal canary. */
import { isAbortRequestText } from "openclaw/plugin-sdk/reply-runtime";
import { randomUUID } from "node:crypto";
import type { SlackIngressEnvelope, SlackIngressQueue, SlackIngressScope } from "./durable-ingress.js";
import { createSlackDurableIngress, wrapSlackDurableReceiver } from "./durable-ingress.js";
import { dispatchSlackIngressClaim, dispatchSlackControlProbe } from "./durable-adoption.js";
import { startSlackIngressDrain } from "./durable-ingress-drain.js";

export function createSlackDurableMonitor(params: {
  scope: SlackIngressScope;
  queue: SlackIngressQueue;
  onHeld: () => void;
  getIgnoredBotIdentity?: () => { botUserId?: string; botId?: string } | undefined;
}) {
  const controller = new AbortController();
  const ownerId = `slack-monitor:${process.pid}:${randomUUID()}`;
  let app: { processEvent(event: SlackIngressEnvelope): Promise<unknown> } | undefined;
  let started = false;
  let done: Promise<void> | undefined;
  const probeControl = async (body: Record<string, unknown>) => {
    const event = body.event as { text?: unknown } | undefined;
    if (typeof event?.text !== "string" || !isAbortRequestText(event.text)) return "NOT_CONTROL" as const;
    if (!app) return "UNVERIFIED" as const;
    const result = await dispatchSlackControlProbe(body, (envelope) => app!.processEvent(envelope));
    return result.disposition;
  };
  const journal = createSlackDurableIngress({
    ...params,
    delegate: async (event) => {
      if (!app) throw new Error("SLACK_INGRESS_MONITOR_NOT_BOUND");
      await app.processEvent(event);
    },
  });
  return {
    wrapReceiver(receiver: {
      init(app: { processEvent(event: SlackIngressEnvelope): Promise<unknown> }): void;
      start(): unknown;
      stop(): unknown;
    }) {
      if (started) throw new Error("SLACK_INGRESS_MONITOR_ALREADY_STARTED");
      return wrapSlackDurableReceiver({ receiver, scope: params.scope, queue: params.queue, probeControl,
        getIgnoredBotIdentity: params.getIgnoredBotIdentity });
    },
    bindApp(value: { processEvent(event: SlackIngressEnvelope): Promise<unknown> }) {
      if (app || started) throw new Error("SLACK_INGRESS_MONITOR_ALREADY_BOUND");
      app = value;
    },
    start() {
      if (!app || started || controller.signal.aborted)
        throw new Error("SLACK_INGRESS_MONITOR_START_REFUSED");
      started = true;
      const originalApp = app;
      done = startSlackIngressDrain({
        signal: controller.signal,
        claimOne: () => journal.claimOne(ownerId),
        dispatch: (claim) => dispatchSlackIngressClaim({
          claim,
          queue: params.queue,
          // Actual Bolt auth/listeners are re-entered; never dispatch directly to the agent.
          dispatch: (event) => originalApp.processEvent(event),
        }),
        onHeld: params.onHeld,
      }).done;
      return done;
    },
    stop() {
      // Stop future claims and sleeps. In-flight work retains ownership until its real outcome.
      controller.abort();
    },
    get done() { return done; },
  };
}
