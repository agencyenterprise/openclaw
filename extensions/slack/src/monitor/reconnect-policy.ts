// Slack plugin module implements reconnect policy behavior.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";

const SLACK_AUTH_ERROR_RE =
  /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|user_removed_from_team|team_disabled|missing_scope|cannot_find_service|invalid_token/i;
const NO_ERROR_DETAIL = "no error detail";

export const SLACK_SOCKET_RECONNECT_POLICY = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
} as const;

type SlackSocketDisconnectEvent = "disconnect" | "error" | "stalled";

export type SlackSocketDisconnect = {
  event: SlackSocketDisconnectEvent;
  error?: unknown;
};

export type SlackSocketLivenessOptions = {
  checkIntervalMs: number;
  staleAfterMs: number;
};

type EmitterLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL =
  "https://docs.slack.dev/apis/events-api/using-socket-mode#using-multiple-connections";
const SLACK_SOCKET_HELLO_MARKER = Buffer.from('"hello"');
const SLACK_SOCKET_DISCONNECT_MARKER = Buffer.from('"disconnect"');

function getSocketClient(app: unknown): object | null {
  const receiver = (app as { receiver?: unknown }).receiver;
  const client =
    receiver && typeof receiver === "object"
      ? (receiver as { client?: unknown }).client
      : undefined;
  return client && typeof client === "object" ? client : null;
}

function getSocketEmitter(app: unknown): EmitterLike | null {
  const client = getSocketClient(app);
  if (!client) {
    return null;
  }
  const on = (client as { on?: unknown }).on;
  const off = (client as { off?: unknown }).off;
  if (typeof on !== "function" || typeof off !== "function") {
    return null;
  }
  return {
    on: (event, listener) =>
      (
        on as (this: unknown, event: string, listener: (...args: unknown[]) => void) => unknown
      ).call(client, event, listener),
    off: (event, listener) =>
      (
        off as (this: unknown, event: string, listener: (...args: unknown[]) => void) => unknown
      ).call(client, event, listener),
  };
}

function isBufferArray(value: unknown): value is Buffer[] {
  return Array.isArray(value) && value.every((entry) => Buffer.isBuffer(entry));
}

function toMessageBuffer(message: unknown): Buffer | undefined {
  return Buffer.isBuffer(message)
    ? message
    : message instanceof ArrayBuffer
      ? Buffer.from(message)
      : isBufferArray(message)
        ? Buffer.concat(message)
        : undefined;
}

// Only Slack's control envelopes are parsed; the marker check keeps event traffic cheap.
function parseSlackSocketControlMessage(
  message: unknown,
  marker: Buffer,
  type: "hello" | "disconnect",
): Record<string, unknown> | undefined {
  const buffer = toMessageBuffer(message);
  if (!buffer?.includes(marker)) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
  return isRecord(payload) && payload.type === type ? payload : undefined;
}

function resolveSlackSocketModeConnectionCount(message: unknown): number | undefined {
  const count = parseSlackSocketControlMessage(
    message,
    SLACK_SOCKET_HELLO_MARKER,
    "hello",
  )?.num_connections;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function resolveSlackSocketModeDisconnectReason(message: unknown): string | undefined {
  const payload = parseSlackSocketControlMessage(
    message,
    SLACK_SOCKET_DISCONNECT_MARKER,
    "disconnect",
  );
  if (!payload) {
    return undefined;
  }
  return typeof payload.reason === "string" && payload.reason ? payload.reason : "unspecified";
}

export function formatSlackSocketModeSharedConnectionWarning(activeConnections: number): string {
  return [
    `slack socket mode reports ${activeConnections} active connections for this Slack app`,
    "Slack may deliver each event to any one connection",
    "ensure every OpenClaw gateway sharing this app has equivalent routing and authorization, or use a separate Slack app per gateway, one relay ingress, or HTTP Request URLs behind a load balancer",
    `See ${SLACK_SOCKET_SHARED_CONNECTION_DOCS_URL}`,
  ].join("; ");
}

export function registerSlackSocketModeConnectionDiagnostics(params: {
  app: unknown;
  onSharedConnection: (activeConnections: number) => void;
  onDisconnectRequested?: (reason: string) => void;
}): () => void {
  const emitter = getSocketEmitter(params.app);
  if (!emitter) {
    return () => {};
  }
  let hasWarned = false;
  const listener = (message: unknown, isBinary?: unknown) => {
    if (isBinary === true) {
      return;
    }
    const disconnectReason = resolveSlackSocketModeDisconnectReason(message);
    if (disconnectReason !== undefined) {
      params.onDisconnectRequested?.(disconnectReason);
      return;
    }
    if (hasWarned) {
      return;
    }
    const activeConnections = resolveSlackSocketModeConnectionCount(message);
    if (activeConnections === undefined || activeConnections <= 1) {
      return;
    }
    hasWarned = true;
    params.onSharedConnection(activeConnections);
  };
  emitter.on("ws_message", listener);
  return () => {
    emitter.off("ws_message", listener);
  };
}

export function waitForSlackSocketDisconnect(
  app: unknown,
  abortSignal?: AbortSignal,
): Promise<SlackSocketDisconnect> {
  return new Promise((resolve) => {
    const emitter = getSocketEmitter(app);
    if (!emitter) {
      abortSignal?.addEventListener("abort", () => resolve({ event: "disconnect" }), {
        once: true,
      });
      return;
    }

    const disconnectListener = () => resolveOnce({ event: "disconnect" });
    const errorListener = (error: unknown) => resolveOnce({ event: "error", error });
    const abortListener = () => resolveOnce({ event: "disconnect" });

    const cleanup = () => {
      emitter.off("disconnected", disconnectListener);
      emitter.off("error", errorListener);
      abortSignal?.removeEventListener("abort", abortListener);
    };

    const resolveOnce = (value: SlackSocketDisconnect) => {
      cleanup();
      resolve(value);
    };

    emitter.on("disconnected", disconnectListener);
    emitter.on("error", errorListener);
    abortSignal?.addEventListener("abort", abortListener, { once: true });
  });
}

function requireSocketOpenProbe(app: unknown): () => boolean {
  const client = getSocketClient(app);
  const websocket = client ? (Reflect.get(client, "websocket") as { isActive?: unknown }) : null;
  if (!client || typeof websocket?.isActive !== "function") {
    throw new Error(
      "unsupported @slack/socket-mode client: no websocket with isActive() after a successful start",
    );
  }
  return () => {
    const current = Reflect.get(client, "websocket") as { isActive?: () => unknown } | undefined;
    return current?.isActive?.() === true;
  };
}

/**
 * Resolve with a "stalled" disconnect once the Socket Mode websocket has not been
 * OPEN for `staleAfterMs`, as seen by polls every `checkIntervalMs` (so detection
 * takes up to `staleAfterMs + checkIntervalMs`). The SDK can sit in CONNECTING or
 * CLOSING without ever emitting a close; this turns any such wedge into an
 * ordinary reconnect.
 */
export function watchSlackSocketLiveness(
  app: unknown,
  options: SlackSocketLivenessOptions,
): { promise: Promise<SlackSocketDisconnect>; cancel: () => void } {
  const isOpen = requireSocketOpenProbe(app);
  let timer: ReturnType<typeof setInterval> | undefined;
  const promise = new Promise<SlackSocketDisconnect>((resolve) => {
    let closedSince: number | undefined;
    timer = setInterval(() => {
      if (isOpen()) {
        closedSince = undefined;
        return;
      }
      const now = Date.now();
      closedSince ??= now;
      const closedForMs = now - closedSince;
      if (closedForMs >= options.staleAfterMs) {
        clearInterval(timer);
        resolve({
          event: "stalled",
          error: new Error(
            `Slack Socket Mode websocket not open for ${Math.round(closedForMs / 1000)}s`,
          ),
        });
      }
    }, options.checkIntervalMs);
    timer.unref?.();
  });
  return { promise, cancel: () => clearInterval(timer) };
}

/**
 * Detect permanent Slack account and credential failures.
 * Transient request and HTTP failures stay in OpenClaw's reconnect loop.
 */
export function isNonRecoverableSlackAuthError(error: unknown): boolean {
  return SLACK_AUTH_ERROR_RE.test(formatUnknownError(error, ""));
}

export function formatUnknownError(error: unknown, fallback = NO_ERROR_DETAIL): string {
  return formatSlackError(error, fallback);
}
