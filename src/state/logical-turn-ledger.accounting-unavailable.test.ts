import { afterEach, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: vi.fn(() => logger) }));

const {
  LOGICAL_ACCOUNTING_UNAVAILABLE_TAG,
  createLogicalTurnLedger,
  markLogicalDispatchAccountingUnavailable,
  settleLogicalTurnLedger,
} = await import("./logical-turn-ledger.js");

const ACCOUNTING_UNAVAILABLE = Symbol.for("openclaw.threadDispatch.accountingUnavailable");
afterEach(() => {
  const state = (globalThis as Record<symbol, { reasons: Set<string> } | undefined>)[
    ACCOUNTING_UNAVAILABLE
  ];
  state?.reasons.clear();
  vi.clearAllMocks();
});

it("logs one tagged error line per process, then warns only for a new reason", () => {
  markLogicalDispatchAccountingUnavailable("slack: WebClient.makeRequest is missing");
  markLogicalDispatchAccountingUnavailable("slack: WebClient.makeRequest is missing");
  markLogicalDispatchAccountingUnavailable("slack: WebClient.makeRequest is not writable");
  expect(LOGICAL_ACCOUNTING_UNAVAILABLE_TAG).toBe("LOGICAL_ACCOUNTING_UNAVAILABLE");
  expect(logger.error).toHaveBeenCalledOnce();
  expect(logger.error.mock.calls[0]?.[0]).toMatch(
    /^LOGICAL_ACCOUNTING_UNAVAILABLE send accounting unavailable process-wide; .*reason=slack: WebClient\.makeRequest is missing$/,
  );
  expect(logger.warn).toHaveBeenCalledOnce();
  expect(logger.warn.mock.calls[0]?.[0]).toMatch(/^LOGICAL_ACCOUNTING_UNAVAILABLE .*not writable$/);
});

it("while unavailable, every turn in the process settles UNKNOWN", async () => {
  markLogicalDispatchAccountingUnavailable("slack: WebClient.makeRequest is missing");
  for (const scope of ["slack/C1/1.1", "slack/C2/2.2"]) {
    const ledger = createLogicalTurnLedger(`claim-${scope}`, scope);
    await expect(settleLogicalTurnLedger(ledger, true)).resolves.toBeUndefined();
  }
});
