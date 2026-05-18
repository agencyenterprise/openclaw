/**
 * Reviewer Recovery Hook — re-engage interrupted Slack threads after gateway restart.
 *
 * On every gateway:startup, scans pending-reactions.json + active-threads.json
 * for threads that were mid-dispatch when the previous gateway died. For each:
 *   1. Cleans up orphan status reactions from Slack.
 *   2. Dispatches "Gateway restarted. Continue where you left off." via the
 *      reviewer-dispatch global (Symbol.for("openclaw.reviewerDispatch")).
 *
 * Originally part of the monolithic reviewer hook (now reviewer.disabled/).
 * Extracted as a standalone bundle so recovery survives the reviewer migration.
 */

import type { OpenClawConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import type { InternalHookEvent } from "../../internal-hooks.js";
import { addThread, loadAndConsumeThreads } from "./active-threads.js";
import { loadAndConsumePendingReactions } from "./pending-reactions.js";

const log = createSubsystemLogger("hooks/reviewer-recovery");

const STATUS_EMOJIS = [
  "eyes",
  "thinking_face",
  "fire",
  "male-technologist",
  "female-technologist",
  "zap",
  "globe_with_meridians",
  "thumbsup",
  "scream",
  "yawning_face",
  "fearful",
  "hourglass_flowing_sand",
  "warning",
  "writing_hand",
  "brain",
  "hammer_and_wrench",
  "computer",
  "white_check_mark",
  "x",
];

const handler: HookHandler = async (event: InternalHookEvent) => {
  if (event.type !== "gateway" || event.action !== "startup") {
    return;
  }

  const cfg = event.context.cfg as OpenClawConfig | undefined;
  let botToken: string | undefined;
  if (cfg) {
    const chCfg = (cfg as Record<string, unknown>).channels as Record<string, unknown> | undefined;
    const slkCfg = chCfg?.slack as Record<string, unknown> | undefined;
    botToken = slkCfg?.botToken as string | undefined;
  }

  const pendingReactions = loadAndConsumePendingReactions();
  const interruptedThreads: Array<{ channelId: string; threadTs: string }> = [];

  if (pendingReactions.length > 0) {
    log.info(`gateway startup: cleaning ${pendingReactions.length} orphan ack reactions`);

    if (botToken) {
      for (const reaction of pendingReactions) {
        const { channel, messageTs, emoji } = reaction;
        const threadTs = (reaction as Record<string, string>).threadTs ?? messageTs;

        const emojisToRemove = new Set([emoji, ...STATUS_EMOJIS]);
        for (const emojiName of emojisToRemove) {
          try {
            const res = await fetch("https://slack.com/api/reactions.remove", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${botToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ channel, timestamp: messageTs, name: emojiName }),
            });
            const rd = (await res.json()) as { ok?: boolean; error?: string };
            if (rd.ok) {
              log.info(`removed orphan :${emojiName}: from ${channel}:${messageTs}`);
            }
          } catch (err) {
            log.warn(`orphan reaction remove failed: ${String(err)}`);
          }
        }

        if (threadTs) {
          interruptedThreads.push({ channelId: channel, threadTs });
          log.info(`thread ${channel}:${threadTs} needs re-engagement (pending ack survived restart)`);
        }
      }
    } else {
      log.warn("gateway startup: no Slack bot token — cannot clean orphan reactions");
    }
  }

  const reviewerThreads = loadAndConsumeThreads();
  const seen = new Set<string>();
  const allThreads: Array<{ channelId: string; threadTs: string }> = [];

  for (const t of interruptedThreads) {
    const key = `${t.channelId}:${t.threadTs}`;
    if (!seen.has(key)) {
      seen.add(key);
      allThreads.push(t);
    }
  }
  for (const t of reviewerThreads) {
    const key = `${t.channelId}:${t.threadTs}`;
    if (!seen.has(key)) {
      seen.add(key);
      allThreads.push(t);
    }
  }

  if (allThreads.length === 0) {
    return;
  }

  log.info(
    `gateway startup: respawning ${allThreads.length} threads ` +
      `(${interruptedThreads.length} interrupted + ${reviewerThreads.length} reviewer)`,
  );

  const dispatchKey = Symbol.for("openclaw.reviewerDispatch");
  type DispatchFn = (p: {
    channelId: string;
    threadTs: string;
    text: string;
  }) => Promise<boolean>;
  let dispatchFn: DispatchFn | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    dispatchFn = (globalThis as Record<symbol, DispatchFn | undefined>)[dispatchKey];
    if (dispatchFn) {
      log.info(`reviewer dispatch ready after ${attempt + 1}s`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!dispatchFn) {
    log.warn("gateway startup: reviewer dispatch not available after 30s — persisting threads for next boot");
    for (const { channelId, threadTs } of allThreads) {
      addThread(channelId, threadTs);
    }
    return;
  }

  for (const { channelId, threadTs } of allThreads) {
    try {
      const dispatched = await dispatchFn({
        channelId,
        threadTs,
        text: "Gateway restarted. Continue where you left off.",
      });
      if (dispatched) {
        log.info(`respawned thread ${channelId}:${threadTs}`);
      } else {
        addThread(channelId, threadTs);
        log.warn(`failed to respawn ${channelId}:${threadTs}: dispatch returned false`);
      }
    } catch (err) {
      addThread(channelId, threadTs);
      log.warn(`failed to respawn ${channelId}:${threadTs}: ${String(err)}`);
    }
  }
};

export default handler;
