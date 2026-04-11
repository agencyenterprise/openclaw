/**
 * Pending reactions persistence — crash recovery for ack reactions.
 *
 * When the gateway places an ack reaction on an incoming message, the
 * channel/messageTs/emoji is recorded here. On normal completion the
 * StatusReactionController clears the reaction. But if the gateway
 * crashes mid-dispatch, the reaction stays on the message forever.
 *
 * On gateway startup, any entries in this file are stale (from a previous
 * incarnation) and their reactions should be removed via Slack API.
 *
 * Write-path: dispatch.ts (inline helpers that write the same JSON file).
 * Read-path: handler.ts gateway:startup (imports this module).
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/pending-reactions");

interface PendingReaction {
  channel: string;
  messageTs: string;
  emoji: string;
  addedAt: string;
}

function getFilePath(): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ?? path.join(require("node:os").homedir(), ".openclaw");
  return path.join(stateDir, "pending-reactions.json");
}

/**
 * Load all pending reactions from disk (called on startup).
 * Returns all entries, then clears the file.
 * Any entries here are from a previous gateway incarnation — their
 * reactions should be removed via Slack API.
 */
export function loadAndConsumePendingReactions(): PendingReaction[] {
  const filePath = getFilePath();
  let data: Record<string, PendingReaction> = {};
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }

  const entries = Object.values(data);

  // Clear the file — entries are consumed
  try {
    fs.writeFileSync(filePath, "{}");
  } catch {}

  if (entries.length > 0) {
    log.info(`loaded ${entries.length} pending reactions from disk`);
  }
  return entries;
}
