import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingress: vi.fn(),
  finalize: vi.fn(),
  dedupe: vi.fn(),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommandFromIngress: mocks.ingress }));
vi.mock("../../runtime.js", () => ({ defaultRuntime: {} }));
vi.mock("../../tasks/detached-task-runtime.js", () => ({ createRunningTaskRun: () => true }));
vi.mock("../../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (x: unknown) => x,
}));
vi.mock("../../infra/agent-events.js", () => ({ clearAgentRunContext: vi.fn() }));
vi.mock("../ws-log.js", () => ({ formatForLog: String }));
vi.mock("./agent-dedupe.js", () => ({ setGatewayDedupeEntries: mocks.dedupe }));
vi.mock("./agent-task-tracking.js", () => ({
  tryFinalizeTrackedAgentTask: mocks.finalize,
  resolveFailedTrackedAgentTaskStatus: () => "failed",
}));
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";

describe("resolved agent result uses normalized terminal status everywhere", () => {
  it.each([
    {
      name: "observed blocked tool turn",
      meta: {
        aborted: false,
        replayInvalid: true,
        livenessState: "blocked",
        stopReason: "toolUse",
      },
      status: "error",
      summary: "blocked",
      task: "failed",
    },
    {
      name: "provider timeout without aborted",
      meta: { timeoutPhase: "provider", providerStarted: true },
      status: "timeout",
      summary: "hard_timeout",
      task: "timed_out",
    },
    {
      name: "explicit abort compatibility",
      meta: { aborted: true },
      status: "timeout",
      summary: "aborted",
      reason: "timed_out",
      task: "timed_out",
    },
    {
      name: "successful completion",
      meta: {},
      status: "ok",
      summary: "completed",
      task: "succeeded",
    },
    {
      name: "intentional tool yield",
      meta: { yielded: true, livenessState: "paused", stopReason: "end_turn" },
      status: "ok",
      summary: "completed",
      task: "succeeded",
    },
    {
      name: "resolved provider error",
      meta: { error: "fixture failure" },
      status: "error",
      summary: "failed",
      task: "failed",
    },
  ])("$name", async ({ meta, status, summary, task, reason }) => {
    vi.clearAllMocks();
    mocks.ingress.mockResolvedValue({ meta });
    const respond = vi.fn();
    const onSettled = vi.fn(() => true);
    dispatchAgentRunFromGateway({
      ingressOpts: { sessionKey: "fixture", message: "no provider" },
      runId: "fixture",
      dedupeKeys: ["fixture"],
      abortController: new AbortController(),
      cleanupAbortController: vi.fn(),
      respond,
      onSettled,
      taskTrackingMode: "cli",
      context: { deps: {}, dedupe: new Map(), logGateway: { warn: vi.fn() } },
    } as unknown as Parameters<typeof dispatchAgentRunFromGateway>[0]);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ status, summary });
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: task, terminalSummary: summary }),
    );
    expect(mocks.dedupe).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ payload: expect.objectContaining({ status, summary }) }),
      }),
    );
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalOutcome: expect.objectContaining({ status, reason: reason ?? summary }),
      }),
    );
  });
});
