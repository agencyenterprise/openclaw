// Covers the inbound turn that loses the session claim race to an already-running turn.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import {
  createReplyRestartRecoveryClaimController,
  RestartRecoveryClaimBusyError,
} from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const SESSION_KEY = "agent:main:main:thread:C0AHSKBNDB6:1788473062.847669";
const SESSION_ID = "session";
const INBOUND_SOURCE_TURN_ID = "channel-user:v1:1788774766.101659";
const INBOUND_DELIVERY_CONTEXT: DeliveryContext = {
  accountId: "default",
  channel: "slack",
  threadId: "1788473062.847669",
  to: "C0AHSKBNDB6",
};

/** Session state left behind by a live `openclaw agent --session-key ... --deliver` turn. */
function createLiveDeliverTurnEntry(): SessionEntry {
  return {
    abortedLastRun: false,
    restartRecoveryDeliveryContext: INBOUND_DELIVERY_CONTEXT,
    restartRecoveryDeliveryRunId: "hcom-bridge-run",
    restartRecoveryDeliverySourceRunId: "hcom-bridge-source",
    sessionId: SESSION_ID,
    status: "running",
    updatedAt: Date.now(),
  };
}

async function createSessionStoreFile(entry: SessionEntry): Promise<string> {
  const storePath = join(tempDirs.make("openclaw-claim-busy-"), "sessions.json");
  await replaceSessionEntry({ storePath, sessionKey: SESSION_KEY }, entry);
  return storePath;
}

function createSourceKeyedRecorder(sourceTurnId: string): UserTurnTranscriptRecorder {
  return {
    getPersistedMessage: () => ({ idempotencyKey: sourceTurnId }),
    hasPersisted: () => false,
    persistApproved: vi.fn(async () => undefined),
  } as unknown as UserTurnTranscriptRecorder;
}

describe("createReplyRestartRecoveryClaimController", () => {
  it("raises a retryable busy error when a live turn already owns the session claim", async () => {
    const storedEntry = createLiveDeliverTurnEntry();
    const storePath = await createSessionStoreFile(storedEntry);
    let entry = storedEntry;
    const controller = createReplyRestartRecoveryClaimController({
      beforeAgentReplyState: "admitted",
      getEntry: () => entry,
      getSessionId: () => SESSION_ID,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => INBOUND_DELIVERY_CONTEXT,
      sessionKey: SESSION_KEY,
      setEntry: (next) => {
        entry = next;
      },
      sourceTurnId: INBOUND_SOURCE_TURN_ID,
      storePath,
    });

    const admission = controller.admitUserTurn(createSourceKeyedRecorder(INBOUND_SOURCE_TURN_ID));

    await expect(admission).rejects.toBeInstanceOf(RestartRecoveryClaimBusyError);
    // The message shape is the contract channel ingress classifies retries on.
    await expect(admission).rejects.toThrow(`restart recovery claim busy for ${SESSION_KEY}`);
    // The running turn keeps its claim, so the inbound turn is retryable rather than lost.
    expect(
      loadSessionEntry({ storePath, sessionKey: SESSION_KEY, readConsistency: "latest" }),
    ).toMatchObject({
      restartRecoveryDeliveryRunId: "hcom-bridge-run",
      restartRecoveryDeliverySourceRunId: "hcom-bridge-source",
      status: "running",
    });
  });
});
