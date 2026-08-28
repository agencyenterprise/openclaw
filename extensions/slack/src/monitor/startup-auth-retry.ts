/**
 * Boot-time `auth.test` retry for the Slack monitor.
 *
 * A single failed `auth.test` at boot leaves the account with a degraded
 * identity (no bot user id) until the next restart, which silently disables
 * explicit mention detection. On 2026-08-28 the one attempt timed out at 10 s
 * because the gateway's event loop was stalled by startup work, with a valid
 * token. Transport failures are transient; only a platform error (invalid
 * token, revoked app) is a reason to give up.
 */

const RETRYABLE_SLACK_ERROR_CODES = new Set([
  "slack_webapi_request_error",
  "slack_webapi_http_error",
  "slack_webapi_rate_limited_error",
]);

const RETRYABLE_MESSAGE_PATTERN =
  /timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i;

export function isRetryableSlackStartupAuthError(err: unknown): boolean {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === "slack_webapi_platform_error") {
    return false;
  }
  if (typeof code === "string" && RETRYABLE_SLACK_ERROR_CODES.has(code)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return RETRYABLE_MESSAGE_PATTERN.test(message);
}

export async function runSlackStartupAuthTestWithRetry<T>(params: {
  authTest: () => Promise<T>;
  attempts: number;
  delayMs: number;
  onRetry?: (attempt: number, message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const sleep =
    params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= params.attempts; attempt += 1) {
    try {
      return await params.authTest();
    } catch (err) {
      lastError = err;
      if (attempt >= params.attempts || !isRetryableSlackStartupAuthError(err)) {
        throw err;
      }
      params.onRetry?.(attempt, err instanceof Error ? err.message : String(err));
      await sleep(params.delayMs);
    }
  }
  throw lastError;
}
