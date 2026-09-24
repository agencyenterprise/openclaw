// Slack plugin module accounts every Slack Web API write against the thread-dispatch turn it belongs to.
import { WebClient } from "@slack/web-api";
import {
  beginLogicalDispatchEffect,
  markLogicalDispatchAccountingUnavailable,
  type LogicalEffectHandle,
  type LogicalEffectOutcome,
} from "openclaw/plugin-sdk/reply-runtime";
import { SLACK_READ_METHODS, SLACK_WRITE_METHODS } from "./slack-api-methods.js";

type MakeRequest = (
  this: WebClient,
  url: string,
  body?: unknown,
  ...rest: unknown[]
) => Promise<unknown>;

const SLACK_API_PATH_PREFIX = "/api/";

// A method this module does not list (one newer than the installed library) reads
// when its last name segment is one of these verbs, and writes otherwise.
const SLACK_READ_VERB = /^(get|list|info|history|replies|read)(?![a-z])/;

export type SlackRequestKind = "read" | "write";

export function slackMethodOf(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  return pathname.startsWith(SLACK_API_PATH_PREFIX)
    ? pathname.slice(SLACK_API_PATH_PREFIX.length)
    : undefined;
}

/**
 * A request is a write when its method is a listed write, or when it is neither a
 * listed read nor (for an unlisted method) named like a read. A request that is
 * not a Web API method (the file-upload POST) is a write.
 */
export function classifySlackRequest(url: string): SlackRequestKind {
  const method = slackMethodOf(url);
  if (!method || SLACK_WRITE_METHODS.has(method)) {
    return "write";
  }
  if (SLACK_READ_METHODS.has(method)) {
    return "read";
  }
  return SLACK_READ_VERB.test(method.slice(method.lastIndexOf(".") + 1)) ? "read" : "write";
}

/**
 * The Web API answer body of a resolved `makeRequest`: the HTTP response's `data`,
 * an object or (as web-api's own `buildResult` allows) a JSON string.
 */
function slackAnswerBody(response: unknown): unknown {
  const data = (response as { data?: unknown } | null | undefined)?.data;
  return typeof data === "string" ? JSON.parse(data) : data;
}

/**
 * The outcome of a Web API method call Slack answered. Only a structurally valid
 * answer counts: `ok: true` means the write landed and `ok: false` is a platform
 * refusal (channel_not_found, not_in_channel, invalid_auth, ...) that created
 * nothing. Anything else (no body, a body that is not JSON, a missing or
 * non-boolean `ok`, a body that throws when read) is unknown.
 */
export function slackAnswerOutcome(response: unknown): LogicalEffectOutcome {
  try {
    const body = slackAnswerBody(response);
    const ok =
      typeof body === "object" && body !== null ? (body as { ok?: unknown }).ok : undefined;
    if (ok === true) {
      return "completed";
    }
    return ok === false ? "not_sent" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The outcome of a file-upload POST to the external `upload_url`. That endpoint
 * answers with plain text ("OK - <bytes>"), not a Web API body, and web-api
 * itself treats HTTP 200 as the upload having landed; anything else is unknown.
 */
export function slackUploadOutcome(response: unknown): LogicalEffectOutcome {
  try {
    return (response as { status?: unknown } | null | undefined)?.status === 200
      ? "completed"
      : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * A rejected request is unknown unless Slack itself refused it before acting:
 * web-api's rate-limit rejection (HTTP 429, raised only when the client rejects
 * rate-limited calls instead of retrying them).
 */
export function slackRejectionOutcome(error: unknown): LogicalEffectOutcome {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "slack_webapi_rate_limited_error" ? "not_sent" : "unknown";
}

/** Settles one turn send from its request: answered, refused, or unknown. */
export function accountTurnWrite(
  send: () => Promise<unknown>,
  settle: LogicalEffectHandle["settle"],
  answerOutcome: (response: unknown) => LogicalEffectOutcome = slackAnswerOutcome,
): Promise<unknown> {
  let request: Promise<unknown>;
  try {
    request = send();
  } catch (error) {
    // The transport is opaque: a synchronous throw proves nothing about the wire.
    settle("unknown");
    throw error;
  }
  return request.then(
    (response) => {
      let outcome: LogicalEffectOutcome = "unknown";
      try {
        outcome = answerOutcome(response);
      } finally {
        settle(outcome);
      }
      return response;
    },
    (error: unknown) => {
      settle(slackRejectionOutcome(error));
      throw error;
    },
  );
}

const ACCOUNTED = Symbol.for("openclaw.slack.writeAccounting.makeRequest");

function accountingUnavailable(reason: string): void {
  markLogicalDispatchAccountingUnavailable(`slack: ${reason}`);
}

/**
 * Wraps `WebClient#makeRequest`, the single transport step behind every Web API
 * method and file upload of every WebClient instance (ours and Bolt's). It runs
 * synchronously in the caller's async context, so a write is attributed to the
 * turn that issued it; a write outside every turn runs untracked. A resolved
 * request settles on its answer (see `slackAnswerOutcome`); a rejected one may
 * have reached Slack with its answer lost, so its outcome is unknown. The wrap is marked with a global
 * symbol, so every loaded copy of this module installs it once. It never throws:
 * if the transport cannot be wrapped, accounting is marked unavailable and every
 * turn settles UNKNOWN.
 */
export function installSlackWriteAccounting(): void {
  try {
    wrapSlackTransport();
  } catch (error) {
    accountingUnavailable(`WebClient.makeRequest cannot be wrapped: ${String(error)}`);
  }
}

function wrapSlackTransport(): void {
  const prototype = WebClient.prototype as unknown as {
    makeRequest?: MakeRequest & { [ACCOUNTED]?: true };
  };
  const makeRequest = prototype.makeRequest;
  if (typeof makeRequest !== "function") {
    accountingUnavailable("WebClient.makeRequest is missing");
    return;
  }
  if (makeRequest[ACCOUNTED]) {
    return;
  }
  const accountedMakeRequest: MakeRequest = function (url, body, ...rest) {
    const send = () => makeRequest.call(this, url, body, ...rest);
    if (classifySlackRequest(url) !== "write") {
      return send();
    }
    const method = slackMethodOf(url);
    const effect = beginLogicalDispatchEffect(`slack ${method ?? "upload"}`);
    if (!effect) {
      return send();
    }
    return accountTurnWrite(send, effect.settle, method ? slackAnswerOutcome : slackUploadOutcome);
  };
  const wrapped = Object.assign(accountedMakeRequest, { [ACCOUNTED]: true as const });
  prototype.makeRequest = wrapped;
  if (prototype.makeRequest !== wrapped) {
    accountingUnavailable("WebClient.makeRequest is not writable");
  }
}
