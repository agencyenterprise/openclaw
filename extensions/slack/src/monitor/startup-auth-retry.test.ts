import { describe, expect, it, vi } from "vitest";
import {
  isRetryableSlackStartupAuthError,
  runSlackStartupAuthTestWithRetry,
} from "./startup-auth-retry.js";

function slackError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("runSlackStartupAuthTestWithRetry", () => {
  it("retries a transport timeout and returns the first successful identity", async () => {
    const authTest = vi
      .fn<() => Promise<{ user_id: string }>>()
      .mockRejectedValueOnce(
        slackError(
          "slack_webapi_request_error",
          "A request error occurred: timeout of 10000ms exceeded",
        ),
      )
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ user_id: "U123" });
    const onRetry = vi.fn();
    const sleep = vi.fn(async () => {});

    const result = await runSlackStartupAuthTestWithRetry({
      authTest,
      attempts: 5,
      delayMs: 15_000,
      onRetry,
      sleep,
    });

    expect(result).toEqual({ user_id: "U123" });
    expect(authTest).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      1,
      "A request error occurred: timeout of 10000ms exceeded",
    );
  });

  it("does not retry a platform error such as an invalid token", async () => {
    const authTest = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(
        slackError("slack_webapi_platform_error", "An API error occurred: invalid_auth"),
      );
    const sleep = vi.fn(async () => {});

    await expect(
      runSlackStartupAuthTestWithRetry({ authTest, attempts: 5, delayMs: 1, sleep }),
    ).rejects.toThrow("invalid_auth");
    expect(authTest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the configured number of attempts", async () => {
    const authTest = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(slackError("slack_webapi_request_error", "ETIMEDOUT"));
    const sleep = vi.fn(async () => {});

    await expect(
      runSlackStartupAuthTestWithRetry({ authTest, attempts: 3, delayMs: 1, sleep }),
    ).rejects.toThrow("ETIMEDOUT");
    expect(authTest).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("isRetryableSlackStartupAuthError", () => {
  it("classifies transport, rate-limit and DNS failures as retryable", () => {
    expect(isRetryableSlackStartupAuthError(slackError("slack_webapi_request_error", "x"))).toBe(
      true,
    );
    expect(
      isRetryableSlackStartupAuthError(slackError("slack_webapi_rate_limited_error", "x")),
    ).toBe(true);
    expect(isRetryableSlackStartupAuthError(new Error("getaddrinfo EAI_AGAIN slack.com"))).toBe(
      true,
    );
    expect(isRetryableSlackStartupAuthError("timeout of 10000ms exceeded")).toBe(true);
  });

  it("classifies platform errors and unknown errors as not retryable", () => {
    expect(
      isRetryableSlackStartupAuthError(slackError("slack_webapi_platform_error", "invalid_auth")),
    ).toBe(false);
    expect(isRetryableSlackStartupAuthError(new Error("auth.test returned no user_id"))).toBe(
      false,
    );
  });
});
