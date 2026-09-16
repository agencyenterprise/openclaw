import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { loadDispatchConfig } from "openclaw/plugin-sdk/reply-runtime";
import type { SlackIngressScope } from "./durable-ingress.js";
export type SlackDurableMonitorConfig = { version: 1; scope: SlackIngressScope; sessionKey: string; stateDir: string };
const reject = (): never => { throw new Error("SLACK_DURABLE_MONITOR_CONFIG_REFUSED"); };
export function loadSlackDurableMonitorConfig(accountId: string, mode: string): SlackDurableMonitorConfig | undefined {
  const filename = process.env.OPENCLAW_SLACK_DURABLE_INGRESS_CONFIG;
  if (filename === undefined) return undefined;
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(filename)) return reject();
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) return reject();
    const bytes = Buffer.alloc(16_385);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 16_384 || count !== stat.size) return reject();
    const value = JSON.parse(bytes.subarray(0, count).toString("utf8")) as SlackDurableMonitorConfig;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join() !== "scope,sessionKey,stateDir,version" || value.version !== 1 ||
        !value.scope || typeof value.scope !== "object" || Array.isArray(value.scope) ||
        Object.keys(value.scope).sort().join() !== "accountId,appId,channelId,teamId,threadTs") return reject();
    const scope = value.scope;
    if (Object.values(scope).some(v => typeof v !== "string" || !v || v !== v.trim() || v.length > 256) ||
        !/^T[A-Z0-9]+$/.test(scope.teamId) || !/^A[A-Z0-9]+$/.test(scope.appId) ||
        !/^[CGD][A-Z0-9]+$/.test(scope.channelId) || !/^\d+\.\d{6}$/.test(scope.threadTs)) return reject();
    // A global opt-in targets one account; other accounts keep their normal transport.
    if (scope.accountId !== accountId) return undefined;
    if (mode !== "socket" || typeof value.sessionKey !== "string" || !value.sessionKey ||
        value.sessionKey !== value.sessionKey.trim() || value.sessionKey.length > 512 ||
        typeof value.stateDir !== "string" || !path.isAbsolute(value.stateDir)) return reject();
    const directory = lstatSync(value.stateDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
        (process.getuid && directory.uid !== process.getuid())) return reject();
    const fence = loadDispatchConfig();
    const scopeKey = `slack/${scope.channelId}/${scope.threadTs}`;
    if (!fence || fence.sessionScopes[value.sessionKey] !== scopeKey || !Object.hasOwn(fence.scopes, scopeKey)) return reject();
    return Object.freeze({ ...value, scope: Object.freeze({ ...scope }) });
  } catch { return reject(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
