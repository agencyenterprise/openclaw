// Memory Core helper module supports tools helpers behavior.
import { expect } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { createMemoryGetTool, createMemorySearchTool } from "./tools.js";

export function asOpenClawConfig(config: Partial<OpenClawConfig>): OpenClawConfig {
  return config;
}

export function createDefaultMemoryToolConfig(): OpenClawConfig {
  return asOpenClawConfig({ agents: { list: [{ id: "main", default: true }] } });
}

export function createMemorySearchToolOrThrow(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  oneShotCliRun?: boolean;
}) {
  const tool = createMemorySearchTool({
    config: params?.config ?? createDefaultMemoryToolConfig(),
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentSessionKey ? { agentSessionKey: params.agentSessionKey } : {}),
    ...(params?.oneShotCliRun ? { oneShotCliRun: params.oneShotCliRun } : {}),
  });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createMemoryGetToolOrThrow(
  config: OpenClawConfig = createDefaultMemoryToolConfig(),
) {
  const tool = createMemoryGetTool({ config });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createAutoCitationsMemorySearchTool(agentSessionKey: string) {
  return createMemorySearchToolOrThrow({
    config: asOpenClawConfig({
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    }),
    agentSessionKey,
  });
}

type UnavailableMemorySearchParams = {
  error: string;
  warning: string;
  action: string;
};

/** The bare payload produced by buildMemorySearchUnavailableResult. */
export function buildExpectedUnavailableMemorySearchResult(params: UnavailableMemorySearchParams) {
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: params.error,
    warning: params.warning,
    action: params.action,
    debug: {
      warning: params.warning,
      action: params.action,
      error: params.error,
    },
  };
}

/** The tool payload: the bare unavailable result plus per-backend `sources`. */
export function expectUnavailableMemorySearchDetails(
  details: unknown,
  params: UnavailableMemorySearchParams,
) {
  expect(details).toEqual({
    ...buildExpectedUnavailableMemorySearchResult(params),
    sources: {
      markdown: {
        hits: 0,
        error: params.error,
        warning: params.warning,
        action: params.action,
      },
      hindsight: { enabled: false, hits: 0 },
    },
  });
}
