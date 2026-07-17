import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export type SlackInboundRecoveryEntry = {
  channel: string;
  threadTs?: string;
  messageTs: string;
  user?: string;
  textLen: number;
  source: "app_mention";
};

type SlackInboundRecoveryLogOptions = {
  targetPath?: string;
  maxBytes?: number;
  nowMs?: number;
};

export function appendSlackInboundRecoveryLog(
  entry: SlackInboundRecoveryEntry,
  options: SlackInboundRecoveryLogOptions = {},
): boolean {
  try {
    const target =
      options.targetPath ??
      process.env.OPENCLAW_INBOUND_LOG_PATH ??
      path.join(os.homedir(), ".openclaw", "inbound-log.jsonl");
    const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const line = `${JSON.stringify({ version: 1, ts: options.nowMs ?? Date.now(), ...entry })}\n`;
    const lineBytes = Buffer.byteLength(line);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (fs.existsSync(target) && fs.statSync(target).size + lineBytes > maxBytes) {
      fs.renameSync(target, `${target}.1`);
    }
    fs.appendFileSync(target, line, { encoding: "utf8", flag: "a", mode: 0o600 });
    fs.chmodSync(target, 0o600);
    return true;
  } catch {
    return false;
  }
}
