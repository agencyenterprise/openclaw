/**
 * Embedded-agent run orchestration implementation.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { getRuntimeConfigSnapshot } from "../../config/config.js";
import { revokeMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import {
  captureAgentRunLifecycleGeneration,
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../plugins/before-agent-reply.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { readEndedCleanupProof } from "../../state/native-cleanup-evidence.js";
import { bindCurrentNativeOwnerDeadline } from "../../state/thread-dispatch.js";
import { hasProtectedDispatchOwner } from "../../state/thread-dispatch.js";
import { hasCronDispatchOwner, runCronDispatchAttempt } from "../../state/thread-dispatch.js";
import {
  dispatchHash,
  loadDispatchConfig,
  hasLogicalDispatchOwner,
  runLogicalNativeAttempt,
  withThreadDispatch,
} from "../../state/thread-dispatch.js";
import { resolveUserPath } from "../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agent-scope.js";
import {
  applyAgentRunSessionTargetIdentity,
  resolveAgentRunSessionTarget,
} from "../run-session-target.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import {
  resolveSessionSuspensionTarget,
  suspendSession,
  type SessionSuspensionParams,
} from "../session-suspension.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { runEmbeddedAgentViaCliBackendIfEligible } from "./cli-backend-dispatch.js";
import { waitForDeferredTurnMaintenanceForSession } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import {
  readNativeThrownCleanupReceipt,
  withNativeCleanupTracking,
  readNativeFailedCleanupReceipt,
} from "./native-cleanup-proof.js";
import { executePreparedEmbeddedRun } from "./run-execution.js";
import {
  createEmbeddedRunStageSummaryEmitter,
  createEmbeddedRunStageTracker,
} from "./run/attempt-stage-timing.js";
import { hasEmbeddedRunConfiguredModelFallbacks } from "./run/fallbacks.js";
import type {
  RunEmbeddedAgentInternalParams,
  RunEmbeddedAgentParamsWithSessionFile,
} from "./run/internal-params.js";
import { createEmbeddedRunLaneController } from "./run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";
import { createEmbeddedRunProgressController } from "./run/progress-controller.js";
import { createRecoveryMessageActionTurnCapability } from "./run/recovery-message-action-capability.js";
import { resolveInitialEmbeddedRunModel } from "./run/runtime-resolution.js";
import { assertAgentHarnessRunAdmission, backfillSessionKey } from "./run/session-bootstrap.js";
import type { EmbeddedAgentRunResult } from "./types.js";

/** A native run refused because its logical turn was already settled: nothing ran, nothing to deliver. */
function refusedAfterTurnSettled(): EmbeddedAgentRunResult {
  return { payloads: [], meta: { durationMs: 0, aborted: true, livenessState: "abandoned" } };
}

const COMPLETED_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "end_turn", "completed"]);
/** Only the embedded harness verifies its own cleanup; a plugin harness attempt counts as cleaned up once it returns. */
const EMBEDDED_HARNESS_ID = "openclaw";

/**
 * Whether a returned run may settle TERMINAL: one of the completed stop reasons, or
 * "toolUse", which ends the loop when every tool in the final batch returned
 * `terminate: true` (for example an edit or write that changed nothing). "toolUse"
 * counts only for the embedded harness and with the cleanup tracker's ended-run proof.
 */
function isCompletedRun(result: EmbeddedAgentRunResult, cleanupIdentity: string): boolean {
  const meta = result.meta;
  if (!meta || meta.aborted || meta.yielded || meta.error || meta.pendingToolCalls?.length) {
    return false;
  }
  if (COMPLETED_STOP_REASONS.has(meta.stopReason ?? "")) {
    return true;
  }
  return (
    meta.stopReason === "toolUse" &&
    meta.agentMeta?.agentHarnessId === EMBEDDED_HARNESS_ID &&
    readEndedCleanupProof(result, cleanupIdentity) !== undefined
  );
}

export function runEmbeddedAgent(
  paramsInput: RunEmbeddedAgentParams,
): Promise<EmbeddedAgentRunResult> {
  const internalParamsInput = paramsInput as RunEmbeddedAgentInternalParams;
  const requestedProvider = normalizeOptionalString(internalParamsInput.provider);
  const requestedModel = normalizeOptionalString(internalParamsInput.model);
  const needsConfiguredDefault =
    !internalParamsInput.config && !requestedProvider && !requestedModel;
  const config =
    internalParamsInput.config ??
    (needsConfiguredDefault ? (getRuntimeConfigSnapshot() ?? undefined) : undefined);
  const lifecycleGeneration =
    internalParamsInput.lifecycleGeneration ??
    captureAgentRunLifecycleGeneration(internalParamsInput.runId);
  const cleanupIdentity = dispatchHash({
    runId: internalParamsInput.runId,
    sessionId: internalParamsInput.sessionId,
    lifecycleGeneration,
  });
  const runPlain = (nativeCleanupIdentity?: string) =>
    withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
      runEmbeddedAgentInternal({
        ...internalParamsInput,
        config,
        lifecycleGeneration,
        nativeCleanupIdentity,
      }),
    );
  const runTracked = () => {
    if (!hasProtectedDispatchOwner()) return runPlain();
    bindCurrentNativeOwnerDeadline(internalParamsInput.timeoutMs);
    return withNativeCleanupTracking(cleanupIdentity, () => runPlain(cleanupIdentity));
  };
  if (hasCronDispatchOwner()) {
    return runCronDispatchAttempt({
      sessionKey: backfillSessionKey({
        config,
        sessionId: internalParamsInput.sessionId,
        sessionKey: internalParamsInput.sessionKey,
        agentId: internalParamsInput.agentId,
      }),
      run: runTracked,
      failedErrorReceipt: (error) => readNativeThrownCleanupReceipt(error, cleanupIdentity),
      failedTerminalReceipt: (result) => readNativeFailedCleanupReceipt(result, cleanupIdentity),
      terminalReceipt: (result) => {
        if (!isCompletedRun(result, cleanupIdentity)) {
          return undefined;
        }
        return dispatchHash({
          kind: "cron_attempt_terminal",
          runId: internalParamsInput.runId,
          sessionKey: internalParamsInput.sessionKey,
          lifecycleGeneration,
          stopReason: result.meta.stopReason,
        });
      },
    });
  }
  if (hasLogicalDispatchOwner()) {
    // Inherited authority must be checked even if mutable host opt-in changed.
    return runLogicalNativeAttempt({
      sessionKey: backfillSessionKey({
        config,
        sessionId: internalParamsInput.sessionId,
        sessionKey: internalParamsInput.sessionKey,
        agentId: internalParamsInput.agentId,
      }),
      run: runTracked,
      cleanupIdentity,
      refused: refusedAfterTurnSettled,
    })!;
  }
  const dispatchConfig = loadDispatchConfig();
  if (!dispatchConfig) {
    return runPlain();
  }
  const dispatchSessionKey = backfillSessionKey({
    config,
    sessionId: internalParamsInput.sessionId,
    sessionKey: internalParamsInput.sessionKey,
    agentId: internalParamsInput.agentId,
  });
  return withThreadDispatch({
    config: dispatchConfig,
    sessionKey: dispatchSessionKey,
    operationId: `native:${internalParamsInput.runId}`,
    timeoutMs: internalParamsInput.timeoutMs,
    kind: "native",
    identity: {
      runId: internalParamsInput.runId,
      sessionKey: dispatchSessionKey,
      sessionId: internalParamsInput.sessionId,
      prompt: internalParamsInput.prompt,
    },
    run: runTracked,
    failedErrorReceipt: (error) => readNativeThrownCleanupReceipt(error, cleanupIdentity),
    terminalReceipt: (result) => {
      const failedReceipt = readNativeFailedCleanupReceipt(result, cleanupIdentity);
      if (failedReceipt) return failedReceipt;
      // replayInvalid forbids repeating side effects; it does not mean this
      // awaited successful turn is still active. Child claims stay separate.
      if (!isCompletedRun(result, cleanupIdentity)) {
        return undefined;
      }
      // This releases only the observed native turn. Child/external UNKNOWN
      // claims remain independent blockers for retirement.
      return dispatchHash({
        kind: "native_terminal",
        runId: internalParamsInput.runId,
        sessionKey: dispatchSessionKey,
        sessionId: internalParamsInput.sessionId,
        lifecycleGeneration,
        stopReason: result.meta.stopReason,
        durationMs: result.meta.durationMs,
      });
    },
  });
}

async function runEmbeddedAgentInternal(
  paramsInput: RunEmbeddedAgentInternalParams,
): Promise<EmbeddedAgentRunResult> {
  const paramsBase = applyAgentRunSessionTargetIdentity(paramsInput);
  const skillWorkshopProposalMutationBudget = paramsBase.skillWorkshopProposalOnly
    ? (paramsBase.skillWorkshopProposalMutationBudget ?? { remaining: 1 })
    : undefined;
  let lifecycleGeneration = paramsBase.lifecycleGeneration!;
  const queuedLifecycleGeneration = getAgentEventLifecycleGeneration();
  // Resolve sessionKey early so all downstream consumers (hooks, LCM, compaction)
  // receive a non-null key even when callers omit it. See #60552.
  const effectiveSessionKey = backfillSessionKey({
    config: paramsBase.config,
    sessionId: paramsBase.sessionId,
    sessionKey: paramsBase.sessionKey,
    agentId: paramsBase.agentId,
  });
  assertAgentHarnessRunAdmission({ ...paramsBase, sessionKey: effectiveSessionKey });
  const runSessionTarget = await resolveAgentRunSessionTarget({
    ...paramsBase,
    sessionKey: effectiveSessionKey,
  });
  let params: RunEmbeddedAgentParamsWithSessionFile = {
    ...paramsBase,
    agentId: paramsBase.agentId ?? runSessionTarget.agentId,
    sessionId: runSessionTarget.sessionId,
    sessionKey: normalizeOptionalString(effectiveSessionKey ?? runSessionTarget.sessionKey),
    sessionFile: runSessionTarget.sessionFile,
    skillWorkshopProposalMutationBudget,
  };
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  // Outer fallback attempts defer session suspension only while another
  // candidate remains. Direct and final-candidate runs suspend normally.
  const failureSuspension = resolveSessionSuspensionTarget();
  const suspendForFailure = (suspensionParams: Omit<SessionSuspensionParams, "laneId">) => {
    const suspension = { ...suspensionParams, laneId: globalLane };
    if (failureSuspension.mode === "defer") {
      failureSuspension.defer(suspension);
      return;
    }
    void suspendSession(suspension);
  };
  const laneController = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane,
    initialQueuedLifecycleGeneration: queuedLifecycleGeneration,
    sessionLane,
    setLifecycleGeneration: (generation) => {
      lifecycleGeneration = generation;
    },
    setParams: (nextParams) => {
      params = nextParams;
    },
  });
  const { enqueueGlobal, enqueueSession, noteLaneTaskProgress, throwIfAborted } = laneController;
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
  throwIfAborted();

  const recoveryMessageActionTurnCapability = createRecoveryMessageActionTurnCapability(params);
  if (recoveryMessageActionTurnCapability) {
    // A recovered run reconstructs this capability from the exact durable
    // source claim; revocation below keeps it scoped to this run lifetime.
    params = { ...params, messageActionTurnCapability: recoveryMessageActionTurnCapability };
  }

  return enqueueSession(async () => {
    throwIfAborted();
    // Same-session reads below must see any prior deferred transcript rewrite.
    // Checkpoint before the global lane so unrelated sessions can still start
    // while this session waits on its own maintenance lane.
    params.replyOperation?.markWaitingForDeferredMaintenance();
    try {
      await waitForDeferredTurnMaintenanceForSession(params.sessionKey);
    } finally {
      params.replyOperation?.markDeferredMaintenanceWaitEnded();
    }
    throwIfAborted();
    return enqueueGlobal(async () => {
      throwIfAborted();
      // Subscription-scoped claude-cli auth executes via the CLI backend;
      // resolved post-admission so dispatched runs obey the same lifecycle,
      // placement, and concurrency gates as native embedded runs.
      const cliDispatched = await runEmbeddedAgentViaCliBackendIfEligible(params);
      if (cliDispatched) {
        return cliDispatched;
      }
      const started = Date.now();
      const startupStages = createEmbeddedRunStageTracker();
      const progressController = createEmbeddedRunProgressController({
        attempt: params,
        noteLaneTaskProgress,
        startedAtMs: started,
      });
      const { notifyExecutionPhase } = progressController;
      const emitStartupStageSummary = createEmbeddedRunStageSummaryEmitter({
        label: "startup stages",
        log,
        runId: params.runId,
        sessionId: params.sessionId,
        tracker: startupStages,
      });
      params.onExecutionStarted?.({ lifecycleGeneration });
      notifyExecutionPhase("runner_entered");
      const workspaceResolution = resolveRunWorkspaceDir({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const resolvedWorkspace = workspaceResolution.workspaceDir;
      const canonicalWorkspace = resolveUserPath(
        resolveAgentWorkspaceDir(params.config ?? {}, workspaceResolution.agentId),
      );
      const isCanonicalWorkspace = canonicalWorkspace === resolvedWorkspace;
      const redactedSessionId = redactRunIdentifier(params.sessionId);
      const redactedSessionKey = redactRunIdentifier(params.sessionKey);
      const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
      if (workspaceResolution.usedFallback) {
        log.warn(
          `[workspace-fallback] caller=runEmbeddedAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }
      startupStages.mark("workspace");
      notifyExecutionPhase("workspace");
      ensureRuntimePluginsLoaded({
        config: params.config,
        workspaceDir: resolvedWorkspace,
        allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
      });
      startupStages.mark("runtime-plugins");
      notifyExecutionPhase("runtime_plugins");

      const { provider, modelId } = resolveInitialEmbeddedRunModel({
        config: params.config,
        agentId: workspaceResolution.agentId,
        provider: params.provider,
        model: params.model,
      });
      const agentDir =
        params.agentDir ?? resolveAgentDir(params.config ?? {}, workspaceResolution.agentId);
      const normalizedSessionKey = params.sessionKey?.trim();
      const fallbackConfigured = hasEmbeddedRunConfiguredModelFallbacks({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: normalizedSessionKey,
        modelFallbacksOverride: params.modelFallbacksOverride,
      });
      const resolvedSessionKey =
        normalizedSessionKey ?? params.sessionTarget?.sessionKey ?? params.sessionId;
      const hookRunner = getGlobalHookRunner();
      const hookCtx = {
        runId: params.runId,
        jobId: params.jobId,
        agentId: workspaceResolution.agentId,
        sessionKey: resolvedSessionKey,
        sessionId: params.sessionId,
        workspaceDir: resolvedWorkspace,
        modelProviderId: provider,
        modelId,
        trigger: params.trigger,
        ...buildAgentHookContextChannelFields(params),
        ...buildAgentHookContextIdentityFields({
          trigger: params.trigger,
          senderId: params.senderId,
          chatId: params.chatId,
          channelContext: params.channelContext,
        }),
      };
      const hookResult = await runBeforeAgentReplyForTurn({
        runId: params.runId,
        trigger: params.trigger,
        event: { cleanedBody: params.prompt },
        context: hookCtx,
        onDispatch: () => notifyExecutionPhase("before_agent_reply", { provider, model: modelId }),
        onDeclined: () => notifyExecutionPhase("runtime_plugins", { provider, model: modelId }),
      });
      if (hookResult?.handled) {
        return {
          payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
          meta: {
            durationMs: Date.now() - started,
            agentMeta: {
              sessionId: params.sessionId,
              provider,
              model: modelId,
            },
            finalAssistantVisibleText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
            finalAssistantRawText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
          },
        };
      }

      return executePreparedEmbeddedRun({
        runParams: params,
        provider,
        modelId,
        agentDir,
        workspaceResolution,
        workspaceDir: resolvedWorkspace,
        isCanonicalWorkspace,
        globalLane,
        hookRunner,
        hookContext: hookCtx,
        fallbackConfigured,
        isProbeSession,
        resolvedSessionKey,
        resolvedToolResultFormat,
        startedAtMs: started,
        startupStages,
        emitStartupStageSummary,
        progressController,
        laneController,
        lifecycleGeneration,
        suspendForFailure,
      });
    });
  }).finally(() => {
    revokeMessageActionTurnCapability(recoveryMessageActionTurnCapability);
  });
}
