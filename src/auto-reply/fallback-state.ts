/** Formats model-fallback notice state for UI/status messages and persisted transition tracking. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatRawAssistantErrorForUi } from "../agents/embedded-agent-helpers.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { FallbackNoticeState } from "../status/fallback-notice-state.js";
import { formatProviderModelRef } from "./model-runtime.js";
import type { RuntimeFallbackAttempt } from "./reply/agent-runner-execution.types.js";

const FALLBACK_REASON_PART_MAX = 80;
const TRANSIENT_FALLBACK_REASONS = new Set([
  "rate_limit",
  "overloaded",
  "timeout",
  "empty_response",
  "no_error_details",
  "unclassified",
]);
const TRANSIENT_ERROR_DETAIL_HINT_RE =
  /\b(?:429|5\d\d|too many requests|usage limit|quota|try again in|retry[- ]after|seconds?|minutes?|hours?|temporarily unavailable|overloaded|service unavailable|throttl)\b/i;

function truncateFallbackReasonPart(value: string, max = FALLBACK_REASON_PART_MAX): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${truncateUtf16Safe(text, max - 1).trimEnd()}…`;
}

function formatFallbackAttemptErrorPreview(attempt: RuntimeFallbackAttempt): string | undefined {
  const rawError = attempt.error?.trim();
  if (!rawError) {
    return undefined;
  }
  if (!attempt.reason || !TRANSIENT_FALLBACK_REASONS.has(attempt.reason)) {
    return undefined;
  }
  // Only expose transient-looking raw details; permanent/auth errors can leak noisy provider text.
  if (!TRANSIENT_ERROR_DETAIL_HINT_RE.test(rawError)) {
    return undefined;
  }
  const formatted = formatRawAssistantErrorForUi(rawError)
    .replace(/^⚠️\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!formatted || /unknown error/i.test(formatted)) {
    return undefined;
  }
  return formatted;
}

function formatFallbackAttemptReason(attempt: RuntimeFallbackAttempt): string {
  const errorPreview = formatFallbackAttemptErrorPreview(attempt);
  if (errorPreview) {
    return errorPreview;
  }
  const reason = attempt.reason?.trim();
  if (reason) {
    return reason.replace(/_/g, " ");
  }
  const code = attempt.code?.trim();
  if (code) {
    return code;
  }
  if (typeof attempt.status === "number") {
    return `HTTP ${attempt.status}`;
  }
  return truncateFallbackReasonPart(attempt.error || "error");
}

function formatFallbackAttemptSummary(attempt: RuntimeFallbackAttempt): string {
  return `${formatProviderModelRef(attempt.provider, attempt.model)} ${formatFallbackAttemptReason(attempt)}`;
}

function buildFallbackReasonSummary(attempts: RuntimeFallbackAttempt[]): string {
  const firstAttempt = attempts[0];
  const firstReason = firstAttempt
    ? formatFallbackAttemptReason(firstAttempt)
    : "selected model unavailable";
  const moreAttempts = attempts.length > 1 ? ` (+${attempts.length - 1} more attempts)` : "";
  return `${truncateFallbackReasonPart(firstReason)}${moreAttempts}`;
}

function buildFallbackAttemptSummaries(attempts: RuntimeFallbackAttempt[]): string[] {
  return attempts.map((attempt) =>
    truncateFallbackReasonPart(formatFallbackAttemptSummary(attempt)),
  );
}

/** Builds the visible notice shown when runtime falls back from the selected model. */
export function buildFallbackNotice(params: {
  selectedProvider: string;
  selectedModel: string;
  activeProvider: string;
  activeModel: string;
  attempts: RuntimeFallbackAttempt[];
  cfg?: OpenClawConfig;
}): string | null {
  const selected = formatProviderModelRef(params.selectedProvider, params.selectedModel);
  const active = formatProviderModelRef(params.activeProvider, params.activeModel);
  if (areRuntimeModelRefsEquivalent(selected, active, { config: params.cfg })) {
    return null;
  }
  const reasonSummary = buildFallbackReasonSummary(params.attempts);
  return `↪️ Model Fallback: ${active} (selected ${selected}; ${reasonSummary})`;
}

/** Builds the visible notice shown when runtime returns to the selected model. */
export function buildFallbackClearedNotice(params: {
  selectedProvider: string;
  selectedModel: string;
  previousActiveModel?: string;
}): string {
  const selected = formatProviderModelRef(params.selectedProvider, params.selectedModel);
  const previous = normalizeOptionalString(params.previousActiveModel);
  if (previous && previous !== selected) {
    return `↪️ Model Fallback cleared: ${selected} (was ${previous})`;
  }
  return `↪️ Model Fallback cleared: ${selected}`;
}

/**
 * Converts a provider model id (e.g. `anthropic/claude-opus-5`, `claude-fable-5-1`) into a
 * plain-English label (`Claude Opus 5`, `Claude Fable 5.1`) so user-facing notices never leak
 * internal identifiers.
 */
function formatPlainModelLabel(modelId: string): string {
  const bare = (modelId.split("/").pop() ?? modelId).trim().replace(/-\d{8}$/, "");
  const tokens = bare.split("-").filter(Boolean);
  if (tokens.length === 0) {
    return modelId;
  }
  return tokens
    .map((token, index) => {
      const isNumeric = /^\d+$/.test(token);
      const previous = index > 0 ? tokens[index - 1] : undefined;
      const prevNumeric = previous !== undefined && /^\d+$/.test(previous);
      const word = isNumeric ? token : token.charAt(0).toUpperCase() + token.slice(1);
      if (index === 0) {
        return word;
      }
      return isNumeric && prevNumeric ? `.${word}` : ` ${word}`;
    })
    .join("");
}

/**
 * Builds the warning shown when Anthropic's server-side safety fallback re-served the turn on a
 * different model. Names the served model in plain words; returns null when no model is served.
 */
export function buildServerSideFallbackNotice(params: {
  fromModel: string | null;
  toModel: string | null;
}): string | null {
  const served = params.toModel ? formatPlainModelLabel(params.toModel) : null;
  if (!served) {
    return null;
  }
  const declined = params.fromModel ? formatPlainModelLabel(params.fromModel) : "the primary model";
  return `⚠️ ${declined} hit a safety guardrail on this request; answered with ${served} instead.`;
}

type ResolvedFallbackTransition = {
  selectedModelRef: string;
  activeModelRef: string;
  fallbackActive: boolean;
  fallbackTransitioned: boolean;
  fallbackCleared: boolean;
  reasonSummary: string;
  attemptSummaries: string[];
  previousState: {
    selectedModel?: string;
    activeModel?: string;
    reason?: string;
  };
  nextState: {
    selectedModel?: string;
    activeModel?: string;
    reason?: string;
  };
  stateChanged: boolean;
};

/** Resolves fallback state transitions and the next persisted notice-state fields. */
export function resolveFallbackTransition(params: {
  selectedProvider: string;
  selectedModel: string;
  activeProvider: string;
  activeModel: string;
  attempts: RuntimeFallbackAttempt[];
  state?: FallbackNoticeState;
  cfg?: OpenClawConfig;
}): ResolvedFallbackTransition {
  const selectedModelRef = formatProviderModelRef(params.selectedProvider, params.selectedModel);
  const activeModelRef = formatProviderModelRef(params.activeProvider, params.activeModel);
  const previousState = {
    selectedModel: normalizeOptionalString(params.state?.fallbackNoticeSelectedModel),
    activeModel: normalizeOptionalString(params.state?.fallbackNoticeActiveModel),
    reason: normalizeOptionalString(params.state?.fallbackNoticeReason),
  };
  const comparisonOptions = { config: params.cfg };
  const fallbackActive = !areRuntimeModelRefsEquivalent(
    selectedModelRef,
    activeModelRef,
    comparisonOptions,
  );
  const fallbackTransitioned =
    fallbackActive &&
    (previousState.selectedModel !== selectedModelRef ||
      previousState.activeModel !== activeModelRef);
  const previousStateMatchesCurrent =
    previousState.selectedModel === selectedModelRef &&
    previousState.activeModel === activeModelRef;
  const previousStateWasRealFallback = previousStateMatchesCurrent
    ? fallbackActive
    : Boolean(
        previousState.selectedModel &&
        previousState.activeModel &&
        !areRuntimeModelRefsEquivalent(
          previousState.selectedModel,
          previousState.activeModel,
          comparisonOptions,
        ),
      );
  const fallbackCleared = !fallbackActive && previousStateWasRealFallback;
  const reasonSummary = buildFallbackReasonSummary(params.attempts);
  const attemptSummaries = buildFallbackAttemptSummaries(params.attempts);
  const nextState = fallbackActive
    ? {
        selectedModel: selectedModelRef,
        activeModel: activeModelRef,
        reason: reasonSummary,
      }
    : {
        selectedModel: undefined,
        activeModel: undefined,
        reason: undefined,
      };
  const stateChanged =
    previousState.selectedModel !== nextState.selectedModel ||
    previousState.activeModel !== nextState.activeModel ||
    previousState.reason !== nextState.reason;
  return {
    selectedModelRef,
    activeModelRef,
    fallbackActive,
    fallbackTransitioned,
    fallbackCleared,
    reasonSummary,
    attemptSummaries,
    previousState,
    nextState,
    stateChanged,
  };
}
