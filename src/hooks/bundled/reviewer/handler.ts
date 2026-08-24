/* oxlint-disable -- Preserved Fractal reviewer overlay; behavior is covered by focused tests and will be split into lint-sized modules separately. */
/**
 * Reviewer Hook — Fable-5 post-turn quality gate.
 *
 * Fires on every message:sent event. When the agent finishes a turn and
 * delivers a response, this hook calls Fable-5 to evaluate the response.
 * If approved, reacts with :approved_by_fractal_reviewer:.
 * If continuation is needed, injects feedback via the reviewer dispatch
 * mechanism (bypassing Slack's self-message limitation).
 *
 * No debounce — fires immediately on the last message:sent of each dispatch.
 * The internal hook only fires ONCE per dispatch cycle (after all block
 * replies are delivered), so there's no need to debounce.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveAgentMaxConcurrent } from "../../../config/agent-limits.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { runTasksWithConcurrency } from "../../../utils/run-with-concurrency.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import type { InternalHookEvent, MessageSentHookContext } from "../../internal-hooks.js";
import {
  upsertInflightTurn,
  closeInflightTurn,
  closeInflightTurnIfUnchanged,
  getOpenInflightTurn,
  markInflightAttempt,
  recoverInflightTurns,
  checkpointInflightLedger,
} from "./inflight-ledger.js";

const log = createSubsystemLogger("hooks/reviewer");

// ── Types ───────────────────────────────────────────────────────────

interface ReviewerConfig {
  enabled?: boolean;
  model?: string;
  maxIterations?: number;
  approveEmoji?: string;
  systemPromptPath?: string;
}

interface ReviewResult {
  action: "approve" | "continue";
  message?: string;
  confidence?: number;
  suggestions?: string;
}

// ── State ───────────────────────────────────────────────────────────

const iterationCounts = new Map<string, { count: number; triggerHumanTs: string }>();
const activeReviews = new Set<string>();
const pendingReviews = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; event: InternalHookEvent }
>();
const REVIEW_DEBOUNCE_MS = 10_000; // Wait 10s after last message:sent before reviewing

// ── Default system prompt ───────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `# Reviewer — Quality Gate for FractalAI

You are a senior quality reviewer for the FractalAI assistant.
You review the assistant's ENTIRE turn in a Slack thread after it finishes.

## Your Job
Evaluate whether Opus:
1. Actually DID what was asked (not just described it)
2. Used tools correctly and verified results
3. Addressed ALL parts of the user's request
4. Made accurate claims supported by evidence

## Response Format
Respond with a valid JSON object. No other text.

APPROVED (target ~90% of reviews):
{"action":"approve","message":"","confidence":0.95}

CONTINUE (only for genuine gaps):
{"action":"continue","message":"Specific actionable feedback here","confidence":0.8}

## Guidelines
- Be constructive: state what's MISSING, not what's wrong
- Never nitpick formatting, tone, or style
- If the user seems satisfied, approve
- Tool errors that the agent already handled → approve
- Claims without evidence → flag
- Incomplete task execution → flag
- The TOOL ACTIVITY section only contains calls from the CURRENT agent turn. Previous turns' tool calls are not included.`;

// ── Helpers ─────────────────────────────────────────────────────────

function resolveReviewerConfig(cfg: OpenClawConfig): ReviewerConfig | undefined {
  // Read from hooks.internal.entries.reviewer config
  const hooksCfg = resolveHookConfig(cfg, "reviewer") as ReviewerConfig | undefined;
  if (!hooksCfg?.enabled) {
    return undefined;
  }
  return hooksCfg;
}

function loadSystemPrompt(config: ReviewerConfig, workspaceDir?: string): string {
  if (config.systemPromptPath && workspaceDir) {
    const promptPath = path.isAbsolute(config.systemPromptPath)
      ? config.systemPromptPath
      : path.join(workspaceDir, config.systemPromptPath);
    try {
      return fs.readFileSync(promptPath, "utf-8").trim();
    } catch {
      log.warn(`Failed to load reviewer prompt from ${promptPath}, using default`);
    }
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function resolveOpenAIApiKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  // Try loading from common env files
  const os = require("node:os");
  const envPaths = [
    path.join(os.homedir(), ".hermes", ".env"),
    path.join(os.homedir(), ".openclaw-test", ".env"),
    path.join(os.homedir(), ".openclaw", ".env"),
  ];
  for (const envPath of envPaths) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("OPENAI_API_KEY=")) {
          const val = trimmed
            .slice("OPENAI_API_KEY=".length)
            .trim()
            .replace(/^["']|["']$/g, "");
          if (val) {
            process.env.OPENAI_API_KEY = val;
            return val;
          }
        }
      }
    } catch {}
  }
  return undefined;
}

function resolveLangfuseConfig():
  | { secretKey: string; publicKey: string; baseUrl: string }
  | undefined {
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://us.cloud.langfuse.com";
  if (!secretKey || !publicKey) {
    return undefined;
  }
  return { secretKey, publicKey, baseUrl };
}

function sendLangfuseTrace(params: {
  langfuse: { secretKey: string; publicKey: string; baseUrl: string };
  traceId: string;
  model: string;
  input: Array<{ role: string; content: string }>;
  output: string;
  usage: { input?: number; output?: number };
  threadTs: string;
  channelId?: string;
  action: string;
  iteration?: number;
  threadMessageCount?: number;
}): void {
  const {
    langfuse,
    traceId,
    model,
    input,
    output,
    usage,
    threadTs,
    channelId,
    action,
    iteration,
    threadMessageCount,
  } = params;
  const auth = Buffer.from(`${langfuse.publicKey}:${langfuse.secretKey}`).toString("base64");
  const now = new Date().toISOString();
  // sessionId groups all reviews for the same Slack thread in Langfuse
  const sessionId = `thread-${threadTs}`;
  const tags = ["reviewer", action, ...(channelId ? [`ch:${channelId}`] : [])];
  const body = {
    batch: [
      {
        id: `${traceId}-trace`,
        type: "trace-create",
        timestamp: now,
        body: {
          id: traceId,
          name: "reviewer",
          sessionId,
          tags,
          input,
          output: { action, message: output },
          metadata: { threadTs, channelId, action, model, iteration, threadMessageCount },
        },
      },
      {
        id: `${traceId}-gen`,
        type: "generation-create",
        timestamp: now,
        body: {
          id: `${traceId}-gen`,
          traceId,
          name: "review-call",
          model,
          startTime: now,
          endTime: now,
          input,
          output,
          usage: { input: usage.input, output: usage.output, unit: "TOKENS" },
          metadata: { threadTs, channelId, action, iteration, threadMessageCount },
        },
      },
    ],
  };
  fetch(`${langfuse.baseUrl}/api/public/ingestion`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => log.warn(`langfuse trace failed: ${String(err)}`));
}

// ── Tool call and subagent extraction from local OpenClaw state ───────

function compactForReviewer(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars)}... (${compact.length} chars total)`;
}

function formatToolCallForReviewer(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "exec") {
    return `[CALL exec]: ${String(args.command ?? "").slice(0, 1000)}`;
  }
  if (toolName === "memory_search") {
    return `[CALL memory_search]: query="${args.query ?? ""}"`;
  }
  if (toolName === "read") {
    return `[CALL read]: ${args.path ?? args.file_path ?? ""}`;
  }
  if (toolName === "write") {
    const content = String(args.content ?? "");
    const writeContent = content.slice(0, 2000);
    return `[CALL write]: ${args.path ?? ""} (${content.length} chars)\n${writeContent}${content.length > 2000 ? "\n... (truncated)" : ""}`;
  }
  if (toolName === "message") {
    const action = args.action ?? "send";
    if (action === "send") {
      return "";
    }
    return `[CALL message ${action}]: ${compactForReviewer(args, 500)}`;
  }

  const lowerName = toolName.toLowerCase();
  if (
    lowerName.includes("spawn") ||
    lowerName.includes("subagent") ||
    lowerName.includes("codex")
  ) {
    const label = args.label ?? args.name ?? args.agentName ?? "";
    const model = args.model ?? args.modelName ?? "";
    const task =
      args.task ?? args.message ?? args.prompt ?? args.input ?? args.instructions ?? args;
    return `[CALL ${toolName}]: label="${label}" model="${model}" task="${compactForReviewer(task, 2000)}"`;
  }

  return `[CALL ${toolName}]: ${compactForReviewer(args, 1000)}`;
}

function extractSubagentRunsForThread(
  stateDir: string,
  threadTs: string,
  sessionKey?: string,
): string[] {
  try {
    const registryPath = path.join(stateDir, "subagents", "runs.json");
    if (!fs.existsSync(registryPath)) {
      return [];
    }

    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    const rawRuns = Object.values(registry.runs ?? registry);
    const threadSessionFragment = `:thread:${threadTs}`;

    const matchedRuns = rawRuns
      .filter((run: any) => {
        const requester = String(run?.requesterSessionKey ?? "");
        const controller = String(run?.controllerSessionKey ?? "");
        const child = String(run?.childSessionKey ?? "");
        const originThread = String(run?.requesterOrigin?.threadId ?? "");
        if (originThread === threadTs) {
          return true;
        }
        if (
          requester.includes(threadSessionFragment) ||
          controller.includes(threadSessionFragment) ||
          child.includes(threadSessionFragment)
        ) {
          return true;
        }
        return Boolean(
          sessionKey &&
          (requester === sessionKey || controller === sessionKey || child === sessionKey),
        );
      })
      .toSorted((a: any, b: any) => Number(a?.createdAt ?? 0) - Number(b?.createdAt ?? 0))
      .slice(-25);

    const entries: string[] = [];
    for (const run of matchedRuns as any[]) {
      const label = run.label ?? "";
      const model = run.model ?? "";
      const status = run.outcome?.status ?? run.endedReason ?? (run.endedAt ? "ended" : "active");
      const created = run.createdAt ? new Date(Number(run.createdAt)).toISOString() : "";
      const ended = run.endedAt ? new Date(Number(run.endedAt)).toISOString() : "active";
      const child = run.childSessionKey ?? "";
      const task = compactForReviewer(run.task ?? "", 1500);
      entries.push(
        `[SUBAGENT run]: label="${label}" runId="${run.runId ?? ""}" model="${model}" status="${status}" created="${created}" ended="${ended}" childSession="${child}" task="${task}"`,
      );

      if (run.frozenResultText) {
        entries.push(
          `[SUBAGENT result]: label="${label}" runId="${run.runId ?? ""}" ${compactForReviewer(run.frozenResultText, 2000)}`,
        );
      }
    }
    return entries;
  } catch (err) {
    log.warn(`extractSubagentRuns failed: ${String(err)}`);
    return [];
  }
}

function resolveReviewerArtifactPath(rawPath: string, workspaceDir: string): string | undefined {
  const cleaned = rawPath
    .replace(/^[`'"(<]+/, "")
    .replace(/[>`'"),.;:]+$/, "")
    .replace(/\{md,json\}$/, "md")
    .replace(/\{json,md\}$/, "md");
  if (!/\.(md|markdown|txt|json)$/i.test(cleaned)) {
    return undefined;
  }

  const resolved = path.resolve(
    cleaned.startsWith("/") ? cleaned : path.join(workspaceDir, cleaned),
  );
  const workspaceRoot = path.resolve(workspaceDir);
  const tmpRoot = path.resolve("/tmp");
  if (
    resolved !== workspaceRoot &&
    !resolved.startsWith(`${workspaceRoot}${path.sep}`) &&
    !resolved.startsWith(`${tmpRoot}${path.sep}`)
  ) {
    return undefined;
  }
  return resolved;
}

function extractReferencedArtifactsForReviewer(
  workspaceDir: string | undefined,
  stateDir: string,
  threadMessages: Array<{ text: string }>,
  toolEntries: string[],
): string[] {
  try {
    const resolvedWorkspace = workspaceDir ?? path.join(stateDir, "workspace");
    const textSources = [...threadMessages.map((m) => m.text ?? ""), ...toolEntries].join("\n");
    const artifactPattern =
      /(?:\/home\/ubuntu\/\.openclaw\/workspace\/|\/tmp\/|(?:papers|reports|memory|outputs|repos|scripts)\/)[^\s`'"<>)]*\.(?:md|markdown|txt|json|\{md,json\}|\{json,md\})/g;
    const matches = textSources.match(artifactPattern) ?? [];
    const seen = new Set<string>();
    const entries: string[] = [];

    for (const raw of matches) {
      const resolved = resolveReviewerArtifactPath(raw, resolvedWorkspace);
      if (!resolved || seen.has(resolved) || !fs.existsSync(resolved)) {
        continue;
      }
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > 2_000_000) {
        continue;
      }
      seen.add(resolved);
      const content = fs.readFileSync(resolved, "utf-8");
      const maxChars = 50_000;
      const body =
        content.length > maxChars
          ? `${content.slice(0, maxChars)}\n... (${content.length} chars total)`
          : content;
      const display = resolved.startsWith(`${resolvedWorkspace}${path.sep}`)
        ? path.relative(resolvedWorkspace, resolved)
        : resolved;
      entries.push(`[ARTIFACT ${display} (${content.length} chars)]\n${body}`);
      if (entries.length >= 5) {
        break;
      }
    }
    return entries;
  } catch (err) {
    log.warn(`extractReferencedArtifacts failed: ${String(err)}`);
    return [];
  }
}

function extractToolCallsFromSession(
  stateDir: string,
  threadTs: string,
  sessionKey?: string,
): string[] {
  try {
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    const candidates = files
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .toSorted((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    // Also resolve session file from sessions.json if we have a sessionKey
    let sessionFileFromIndex: string | undefined;
    if (sessionKey) {
      try {
        const indexPath = path.join(sessionsDir, "sessions.json");
        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        const sessions = index.sessions ?? index;
        if (Array.isArray(sessions)) {
          for (const s of sessions) {
            if (s.key === sessionKey || s.sessionKey === sessionKey) {
              sessionFileFromIndex = s.sessionFile ?? s.file;
              break;
            }
          }
        }
      } catch {}
    }

    const entries: string[] = [];

    const extractFromFile = (filePath: string): boolean => {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "message") {
            continue;
          }
          const msg = entry.message;
          const role = msg?.role ?? "";
          const blocks = msg?.content;

          // Extract tool calls (assistant role)
          if (role === "assistant" && Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block?.type !== "toolCall") {
                continue;
              }
              const toolName = block.name ?? "";
              const args = block.arguments ?? {};
              const callStr = formatToolCallForReviewer(toolName, args);
              if (callStr) {
                entries.push(callStr);
              }
            }
          }

          // Extract tool results (toolResult role)
          if (role === "toolResult") {
            let resultText = "";
            if (Array.isArray(blocks)) {
              for (const block of blocks) {
                if (block?.type === "text") {
                  resultText += block.text ?? "";
                }
              }
            } else if (typeof blocks === "string") {
              resultText = blocks;
            }
            if (resultText) {
              const truncated =
                resultText.length > 2000
                  ? resultText.slice(0, 2000) + `... (${resultText.length} chars total)`
                  : resultText;
              entries.push(`[RESULT]: ${truncated}`);
            }
          }
        } catch {}
      }
      return entries.length > 0;
    };

    // Strategy 1: Find session matching threadTs (thread-level sessions)
    for (const { name } of candidates) {
      const filePath = path.join(sessionsDir, name);
      const isTopicMatch = name.includes(threadTs.replace(".", ""));
      if (isTopicMatch) {
        if (extractFromFile(filePath)) {
          return entries;
        }
      }
    }

    // Strategy 2: Search file content for threadTs
    for (const { name } of candidates) {
      const filePath = path.join(sessionsDir, name);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        if (content.includes(threadTs) && extractFromFile(filePath)) {
          return entries;
        }
      } catch {}
    }

    // Strategy 3: Use the session file from sessions.json index (channel-level session)
    if (sessionFileFromIndex) {
      const resolvedPath = sessionFileFromIndex.startsWith("/")
        ? sessionFileFromIndex
        : path.join(sessionsDir, sessionFileFromIndex);
      try {
        if (fs.existsSync(resolvedPath) && extractFromFile(resolvedPath)) {
          return entries;
        }
      } catch {}
    }

    // Strategy 4: Fall back to most recent active session (likely the one that just finished)
    const mostRecentCandidate = candidates[0];
    if (entries.length === 0 && mostRecentCandidate) {
      const mostRecent = path.join(sessionsDir, mostRecentCandidate.name);
      extractFromFile(mostRecent);
    }

    return entries;
  } catch (err) {
    log.warn(`extractToolCalls failed: ${String(err)}`);
    return [];
  }
}

// ── Hindsight memory pre-fetch ──────────────────────────────────────

async function queryHindsight(query: string): Promise<string[]> {
  try {
    const body = JSON.stringify({
      query,
      budget: "high",
      limit: 5,
    });
    const res = await fetch("http://localhost:8888/v1/default/banks/openclaw/memories/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log.warn(`Hindsight recall returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { results?: Array<{ text?: string; memory?: string }> };
    const results = data.results ?? [];
    return results
      .filter((r) => r.text || r.memory)
      .slice(0, 5)
      .map((r) => ((r.text ?? r.memory) as string).slice(0, 300));
  } catch (err) {
    log.warn(`Hindsight query failed: ${String(err)}`);
    return [];
  }
}

function usesOpenAIChatReviewerModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith("gpt-") || m.startsWith("openai/");
}

function normalizeOpenAIChatReviewerModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.toLowerCase().startsWith("openai/") ? trimmed.slice("openai/".length) : trimmed;
}

function extractJsonObjectText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
}

async function callReviewer(params: {
  cfg: OpenClawConfig;
  model: string;
  systemPrompt: string;
  threadMessages: Array<{ role: string; text: string; ts?: string }>;
  threadTs: string;
  channelId?: string;
  iteration?: number;
  toolCalls?: string[];
  memories?: string[];
}): Promise<ReviewResult> {
  // Full thread with human-readable timestamps so the reviewer can gauge recency.
  const transcript = params.threadMessages
    .map((m) => {
      const tag = m.ts
        ? `@ ${new Date(Number(m.ts) * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
        : "";
      return `[${m.role} ${tag}]: ${m.text}`;
    })
    .join("\n\n");

  // Build tool activity section if available — 100K token budget moving window.
  // Newest entries are kept; oldest are dropped when budget is exceeded.
  // ~4 chars per token, so 100K tokens ≈ 400K chars budget for tool activity.
  let toolSection = "";
  if (params.toolCalls && params.toolCalls.length > 0) {
    const TOKEN_BUDGET_CHARS = 120_000; // ~30K tokens; keep reviewer prompt bounded
    // Walk backwards (newest first), accumulate until budget is spent
    const selected: string[] = [];
    let charCount = 0;
    for (let i = params.toolCalls.length - 1; i >= 0; i--) {
      const entry = params.toolCalls[i];
      if (entry === undefined) {
        continue;
      }
      if (charCount + entry.length > TOKEN_BUDGET_CHARS) {
        break; // Budget exhausted — older entries are dropped
      }
      selected.unshift(entry); // Prepend to maintain chronological order
      charCount += entry.length;
    }
    const dropped = params.toolCalls.length - selected.length;
    const header =
      dropped > 0
        ? `(showing ${selected.length}/${params.toolCalls.length} tool calls — ${dropped} older calls trimmed to fit reviewer prompt budget)`
        : `(${selected.length} tool calls from current turn)`;
    toolSection = `\n\n--- AGENT TOOL ACTIVITY ${header} ---\n${selected.join("\n")}\n--- END TOOL ACTIVITY ---`;
  }

  // Build memory section from Hindsight pre-fetch
  let memorySection = "";
  if (params.memories && params.memories.length > 0) {
    memorySection = `\n\n--- RELEVANT MEMORIES (retrieved from Hindsight semantic memory) ---
These are past learnings, rules, and observations that Opus saved during previous work. They were retrieved by searching for topics related to this thread. Use them to evaluate whether Opus is following known rules, repeating past mistakes, or missing context it should already have.
${params.memories.map((m, i) => `${i + 1}. ${m}`).join("\n")}
--- END MEMORIES ---`;
  }

  const userContent = `Review this conversation thread. The assistant is Opus.

--- THREAD ---
${transcript}
--- END ---${toolSection}${memorySection}

Evaluate the assistant's last response. Respond with JSON only. Hard output limit: if action=continue, keep message under 700 characters and name only the concrete next correction. Do not include analysis, long evidence dumps, or multi-paragraph explanations.`;
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: userContent },
  ];

  // Reviewer is a structured-output JSON classifier. GPT-5.5 uses OpenAI JSON mode;
  // other configured models go through OpenClaw's model runtime and are parsed from text.
  let finishReason: string | undefined = "stop";
  let rawOutput = "{}";
  let usageForTrace: { input?: number; output?: number } = {};

  if (usesOpenAIChatReviewerModel(params.model)) {
    const apiKey = resolveOpenAIApiKey();
    if (!apiKey) {
      log.warn("No OpenAI API key found — auto-approving");
      return { action: "approve", message: "", confidence: 1.0 };
    }
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });
    const openAIModel = normalizeOpenAIChatReviewerModel(params.model);
    const callBody = {
      model: openAIModel,
      messages,
      max_completion_tokens: 4000,
      response_format: { type: "json_object" as const },
    };
    log.info(
      `reviewer call: model=${params.model} resolved=${openAIModel} message_count=${messages.length} body_keys=${Object.keys(callBody).join(",")}`,
    );
    log.info(
      `reviewer call body (sans messages): ${JSON.stringify({ ...callBody, messages: undefined })}`,
    );
    let response;
    try {
      response = await client.chat.completions.create(callBody);
      log.info(
        `reviewer response ok: choices=${response.choices?.length ?? 0} model_returned=${response.model ?? "?"} finish=${response.choices?.[0]?.finish_reason ?? "?"}`,
      );
    } catch (err: unknown) {
      const errAny = err as { message?: string; status?: number; error?: unknown };
      log.error(
        `reviewer call THREW: status=${errAny.status ?? "?"} message=${errAny.message ?? String(err)} body_was=${JSON.stringify({ ...callBody, messages: "[...]" })}`,
      );
      throw err;
    }

    finishReason = response.choices[0]?.finish_reason;
    rawOutput = response.choices[0]?.message?.content ?? "{}";
    usageForTrace = {
      input: response.usage?.prompt_tokens,
      output: response.usage?.completion_tokens,
    };

    if (finishReason && finishReason !== "stop") {
      log.warn(
        `reviewer response ended with finish=${finishReason}; retrying internally with compact prompt`,
      );
      const compactTranscript = params.threadMessages
        .slice(-60)
        .map((m) => {
          const tag = m.ts ? `@ ${new Date(Number(m.ts) * 1000).toISOString()}` : "";
          return `[${m.role} ${tag}]: ${m.text.slice(0, 700)}`;
        })
        .join("\n\n");
      const retryMessages: Array<{ role: "system" | "user"; content: string }> = [
        {
          role: "system",
          content:
            params.systemPrompt +
            "\n\nYour previous JSON response was truncated. Return exactly one compact JSON object. If action=continue, message must be under 600 characters and contain only the next concrete correction. No analysis prose.",
        },
        {
          role: "user",
          content: `Compact retry for reviewer decision. Thread root: ${params.threadTs}. Use the last 60 messages below plus known rules.\n\n--- RECENT THREAD ---\n${compactTranscript}\n--- END ---\n\nReturn JSON only.`,
        },
      ];
      try {
        const retryResponse = await client.chat.completions.create({
          model: openAIModel,
          messages: retryMessages,
          max_completion_tokens: 1200,
          response_format: { type: "json_object" as const },
        });
        response = retryResponse;
        finishReason = response.choices[0]?.finish_reason;
        rawOutput = response.choices[0]?.message?.content ?? "{}";
        usageForTrace = {
          input: response.usage?.prompt_tokens,
          output: response.usage?.completion_tokens,
        };
        log.info(`reviewer compact retry ok: finish=${finishReason ?? "?"}`);
      } catch (err: unknown) {
        log.error(`reviewer compact retry THREW: ${String(err)}`);
      }
    }
  } else {
    const { createRuntimeLlm } = await import("../../../plugins/runtime/runtime-llm.runtime.js");
    const llm = createRuntimeLlm({
      getConfig: () => params.cfg,
      authority: {
        caller: { kind: "host", id: "reviewer", name: "Reviewer Hook" },
        allowComplete: true,
        allowModelOverride: true,
        allowedModels: [params.model],
      },
    });
    log.info(`reviewer call: model=${params.model} via OpenClaw LLM runtime`);
    const runtimeResult = await llm.complete({
      model: params.model,
      systemPrompt:
        params.systemPrompt +
        "\n\nReturn exactly one valid JSON object and no surrounding prose or markdown fences.",
      messages: [{ role: "user", content: userContent }],
      maxTokens: 4000,
      purpose: "reviewer-quality-gate",
    });
    rawOutput = runtimeResult.text || "{}";
    finishReason = "stop";
    usageForTrace = {
      input: runtimeResult.usage?.inputTokens,
      output: runtimeResult.usage?.outputTokens,
    };
    log.info(
      `reviewer response ok: provider=${runtimeResult.provider} model_returned=${runtimeResult.model}`,
    );
  }

  let result: ReviewResult;
  if (finishReason && finishReason !== "stop") {
    log.warn(
      `reviewer compact retry still ended with finish=${finishReason}; forcing concise corrective continue`,
    );
    result = {
      action: "continue",
      message:
        "Reviewer internal retry failed. Do a concise self-audit of the last turn against SOUL/reviewer rules, fix any concrete gap now, and do not ask A/B unless there is a hard blocker.",
      confidence: 0,
    };
  } else {
    try {
      result = JSON.parse(extractJsonObjectText(rawOutput)) as ReviewResult;
    } catch (err) {
      log.warn(`reviewer JSON parse failed; forcing continue: ${String(err)}`);
      result = {
        action: "continue",
        message:
          "Reviewer output was not valid JSON. Do a concise self-audit of the last turn, fix any concrete gap now, and do not treat the prior turn as approved.",
        confidence: 0,
      };
    }
  }

  // Fire-and-forget Langfuse trace
  const langfuse = resolveLangfuseConfig();
  if (langfuse) {
    const traceId = `reviewer-${params.threadTs}-${Date.now()}`;
    sendLangfuseTrace({
      langfuse,
      traceId,
      model: params.model,
      input: messages,
      output: rawOutput,
      usage: usageForTrace,
      threadTs: params.threadTs,
      channelId: params.channelId,
      action: result.action,
      iteration: params.iteration,
      threadMessageCount: params.threadMessages.length,
    });
    log.info(`langfuse trace sent: ${traceId}`);
  } else {
    log.warn("no langfuse config — skipping trace");
  }

  return result;
}

// Did the agent answer the most recent reviewer continue?
// Legacy/public mode uses the reviewer's visible Slack post as a clock-free marker. Private
// mode edits the prior bot answer in place, so Slack's `edited.ts` must be newer than the
// durable dispatch timestamp. A later human message does not un-answer either form.
export async function reviewerContinueAnswered(params: {
  token: string;
  botUserId: string;
  channelId: string;
  threadTs: string;
  dispatchedAtMs?: number;
}): Promise<boolean> {
  try {
    const messages = await fetchSlackThread(
      params.token,
      params.channelId,
      params.threadTs,
      params.botUserId,
    );
    let latestReviewerTs = 0;
    for (const m of messages) {
      if (m.role === "Assistant" && isReviewerFeedbackText(m.text)) {
        const ts = Number.parseFloat(m.ts ?? "0");
        if (Number.isFinite(ts)) latestReviewerTs = Math.max(latestReviewerTs, ts);
      }
    }
    if (latestReviewerTs > 0) {
      return messages.some(
        (m) =>
          m.role === "Assistant" &&
          !isReviewerFeedbackText(m.text) &&
          m.ts !== undefined &&
          Number.parseFloat(m.ts) > latestReviewerTs,
      );
    }
    if (!params.dispatchedAtMs) {
      return false;
    }
    const dispatchSlackTs = params.dispatchedAtMs / 1000;
    return messages.some((m) => {
      if (m.role !== "Assistant" || isReviewerFeedbackText(m.text) || !m.editedTs) {
        return false;
      }
      const editedTs = Number.parseFloat(m.editedTs);
      return Number.isFinite(editedTs) && editedTs >= dispatchSlackTs - 2;
    });
  } catch (err) {
    log.warn(
      `continue-answered probe failed for ${params.channelId}:${params.threadTs}: ${String(err)}`,
    );
    return false; // uncertain → NOT answered → re-engage / keep the row (no-loss bias)
  }
}

// Has an "engage" row been answered? (A mention/review-start row, where the bot owes a
// reply to the thread itself.) "Answered" = the bot's latest non-reviewer reply is newer
// than the latest non-bot (actionable) message — i.e. the bot has responded to the most
// recent human input. The durable row can be recreated after a reply during hook/restart
// races, so its opened_at timestamp must not override Slack's authoritative ordering.
// A trailing unanswered human message keeps it open (re-engage).
// On any Slack error we return false (NOT answered → re-engage / keep). Never throws.
export async function engageAnswered(params: {
  token: string;
  botUserId: string;
  channelId: string;
  threadTs: string;
}): Promise<boolean> {
  try {
    const messages = await fetchSlackThread(
      params.token,
      params.channelId,
      params.threadTs,
      params.botUserId,
    );
    let latestAssistantTs = 0;
    let latestActionableTs = 0;
    for (const m of messages) {
      const ts = Number.parseFloat(m.ts ?? "0");
      if (!Number.isFinite(ts)) continue;
      if (m.role === "Assistant" && !isReviewerFeedbackText(m.text)) {
        latestAssistantTs = Math.max(latestAssistantTs, ts);
      } else {
        latestActionableTs = Math.max(latestActionableTs, ts);
      }
    }
    return latestAssistantTs > latestActionableTs;
  } catch (err) {
    log.warn(
      `engage-answered probe failed for ${params.channelId}:${params.threadTs}: ${String(err)}`,
    );
    return false; // uncertain → NOT answered → re-engage / keep the row (no-loss bias)
  }
}

// Pick the kind-appropriate "answered?" probe for an in-flight row.
async function inflightRowAnswered(
  token: string,
  botUserId: string,
  channelId: string,
  threadTs: string,
  row: { kind: string; last_dispatch: number; opened_at: number },
): Promise<boolean> {
  return row.kind === "engage"
    ? engageAnswered({ token, botUserId, channelId, threadTs })
    : reviewerContinueAnswered({
        token,
        botUserId,
        channelId,
        threadTs,
        dispatchedAtMs: row.last_dispatch,
      });
}

async function fetchSlackThread(
  token: string,
  channelId: string,
  threadTs: string,
  botUserId?: string,
): Promise<Array<{ role: string; text: string; ts?: string; editedTs?: string }>> {
  const allMessages: Array<{
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    edited?: { ts?: string };
  }> = [];
  let cursor: string | undefined;

  // Paginate to get ALL messages (Slack returns oldest-first, max 200 per page)
  do {
    const params = new URLSearchParams({ channel: channelId, ts: threadTs, limit: "200" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const res = await fetch(`https://slack.com/api/conversations.replies?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as {
      ok?: boolean;
      messages?: Array<{
        user?: string;
        bot_id?: string;
        text?: string;
        ts?: string;
        edited?: { ts?: string };
      }>;
      error?: string;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) {
      const error = data.error ?? "unknown";
      log.warn(`conversations.replies failed: ${error}`);
      throw new Error(`Slack thread fetch failed for ${channelId}:${threadTs}: ${error}`);
    }
    allMessages.push(...(data.messages ?? []));
    cursor = data.has_more ? data.response_metadata?.next_cursor : undefined;
  } while (cursor);

  log.info(`fetchSlackThread: ${allMessages.length} messages fetched (paginated)`);
  return allMessages.map((m) => ({
    role: classifySlackThreadMessageRole(m, botUserId),
    text: m.text ?? "(no text)",
    ts: m.ts,
    editedTs: m.edited?.ts,
  }));
}

export function classifySlackThreadMessageRole(
  message: { user?: string; bot_id?: string },
  botUserId?: string,
): string {
  const isAssistant = Boolean(message.bot_id) || Boolean(botUserId && message.user === botUserId);
  return isAssistant ? "Assistant" : `User (${message.user ?? "unknown"})`;
}

function isReviewerFeedbackText(text: string | undefined): boolean {
  const normalized = (text ?? "").trim();
  return normalized.startsWith("🔍 *Reviewer:*") || normalized.startsWith(":mag: *Reviewer:*");
}

function isUserVisibleAssistantAnswer(text: string | undefined): boolean {
  const normalized = (text ?? "").trim();
  if (!normalized || isReviewerFeedbackText(normalized)) {
    return false;
  }
  return !/^(?:⚠️|:warning:)\s*(?:✉️|:email:)\s*Message failed\s*$/iu.test(normalized);
}

function latestAssistantText(threadMessages: Array<{ role: string; text?: string }>): string {
  return (
    threadMessages
      .filter((m) => m.role === "Assistant" && isUserVisibleAssistantAnswer(m.text))
      .pop()?.text ?? ""
  );
}

export function forceContinueForFalseDecisionAsk(
  threadMessages: Array<{ role: string; text?: string }>,
): string | null {
  const text = latestAssistantText(threadMessages);
  if (!text) {
    return null;
  }
  const asksHumanToChoose =
    /\b(decision asked|your call|which (?:way|one|option)|pick (?:one|a|b|c)|should i|want me to|if you say go|on ["']?go["']?|green-?light|approve option|expand .*\bclose|close .*\bexpand)\b/i.test(
      text,
    );
  if (!asksHumanToChoose) {
    return null;
  }
  const saysWorkIsCheapOrRecommended =
    /\b(cheap|reversible|trivial|in[- ]scope|already[- ]aligned|recommended|recommendation|my read|right call|should be run|same turn|no approval|pre[- ]authorized)\b/i.test(
      text,
    ) || /\$\s*(?:0(?:\.\d+)?|[1-9](?:\.\d+)?)(?:\b|\s|[-–—])/i.test(text);
  if (!saysWorkIsCheapOrRecommended) {
    return null;
  }
  const genuineHardGate =
    /\b(human design review|credential|access credential|destructive|external side effect|legal|security|privacy|cannot proceed|hard block)\b/i.test(
      text,
    );
  if (genuineHardGate) {
    return null;
  }
  return "False decision-ask: the latest reply asks humans to choose even though its own text frames the recommended next step as cheap/reversible/in-scope. Execute the recommended branch now or name a genuine hard blocker; do not stop at `your call`/`go?`.";
}

async function slackReact(
  token: string,
  channelId: string,
  ts: string,
  emoji: string,
): Promise<void> {
  try {
    const res = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId, timestamp: ts, name: emoji }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!data.ok) {
      log.warn(`reactions.add failed for :${emoji}: on ${ts}: ${data.error ?? "unknown"}`);
      // If custom emoji doesn't exist, fall back to a standard one
      if (data.error === "invalid_name") {
        await fetch("https://slack.com/api/reactions.add", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ channel: channelId, timestamp: ts, name: "white_check_mark" }),
        });
      }
    } else {
      log.info(`reaction :${emoji}: added to ${ts}`);
    }
  } catch (err) {
    log.warn(`slackReact error: ${String(err)}`);
  }
}

// Judd's Slack user id. Per the HARD "never @-mention Judd" rule (Flavio, 2026-06-18),
// the reviewer must be STRUCTURALLY incapable of emitting a live Judd ping — including
// when it merely *quotes* a `<@U02AX1XQ1>` token while flagging a (real or hallucinated)
// violation. The prompt-level rule is not enough: an LLM quoting the offending token will
// reproduce it verbatim, and Slack renders `<@ID>` as a live ping regardless of code/quote
// styling. So we defang at the post chokepoint. Reference incident: 2026-06-18 thread
// 1780509725.395419 — reviewer falsely claimed a Judd ping and, while "quoting" it, pinged
// Judd for real.
const JUDD_USER_ID = "U02AX1XQ1";

// Convert any live `<@U02AX1XQ1>` (with or without a `|label`) into an inert plain-text
// reference that Slack will NOT turn into a notification.
export function defangJuddMention(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(new RegExp(`<@${JUDD_USER_ID}(\\|[^>]*)?>`, "g"), "`@Judd`");
}

async function slackPost(
  token: string,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: channelId,
      thread_ts: threadTs,
      text: defangJuddMention(text),
    }),
  });
}

function loadOpenClawConfigFromDisk(): OpenClawConfig | undefined {
  try {
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ?? path.join(require("node:os").homedir(), ".openclaw");
    const cfgPath = path.join(stateDir, "openclaw.json");
    return JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as OpenClawConfig;
  } catch {
    return undefined;
  }
}

function getSlackBotToken(cfg: OpenClawConfig | undefined): string | undefined {
  const chCfg = (cfg as Record<string, unknown> | undefined)?.channels as
    | Record<string, unknown>
    | undefined;
  const slkCfg = chCfg?.slack as Record<string, unknown> | undefined;
  return slkCfg?.botToken as string | undefined;
}

function extractSessionChannelId(sessionKey: string | undefined): string | undefined {
  const m = (sessionKey ?? "").match(/channel:(c[a-z0-9]+)/i);
  return m?.[1]?.toUpperCase();
}

function extractSessionThreadTs(sessionKey: string | undefined): string | undefined {
  return (sessionKey ?? "").match(/thread:(\d+\.\d+)/)?.[1];
}

async function resolveSlackBotUserId(token: string | undefined): Promise<string | undefined> {
  if (!token) {
    return undefined;
  }
  try {
    const authRes = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const authData = (await authRes.json()) as { ok?: boolean; user_id?: string };
    return authData.ok && authData.user_id ? authData.user_id : undefined;
  } catch {
    return undefined;
  }
}

async function probeCanonicalSlackThreadTs(
  token: string,
  channelId: string,
  candidateTs: string,
): Promise<string | undefined> {
  if (!/^\d+\.\d+$/.test(candidateTs)) {
    return undefined;
  }
  const fetchSlackJson = async (url: URL) => {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await res.json()) as {
      ok?: boolean;
      error?: string;
      messages?: Array<{ ts?: string; thread_ts?: string }>;
    };
  };
  const canonicalFromMessages = (
    data: { messages?: Array<{ ts?: string; thread_ts?: string }> },
    preferExact: boolean,
  ) => {
    const messages = data.messages ?? [];
    const exact = messages.find((entry) => entry.ts === candidateTs);
    const selected = preferExact ? exact : (exact ?? messages[0]);
    return selected?.thread_ts ?? selected?.ts;
  };
  try {
    const url = new URL("https://slack.com/api/conversations.replies");
    url.searchParams.set("channel", channelId);
    url.searchParams.set("ts", candidateTs);
    url.searchParams.set("limit", "1");
    const data = await fetchSlackJson(url);
    if (!data.ok) {
      log.warn(
        `canonical thread probe failed for ${channelId}:${candidateTs}: ${data.error ?? "unknown"}`,
      );
    } else {
      const canonical = canonicalFromMessages(data, false);
      if (canonical && canonical !== candidateTs) {
        log.info(`canonicalized Slack thread ${channelId}:${candidateTs} -> ${canonical}`);
        return canonical;
      }
      if (canonical) {
        return canonical;
      }
    }

    const historyUrl = new URL("https://slack.com/api/conversations.history");
    historyUrl.searchParams.set("channel", channelId);
    historyUrl.searchParams.set("latest", candidateTs);
    historyUrl.searchParams.set("oldest", candidateTs);
    historyUrl.searchParams.set("inclusive", "true");
    historyUrl.searchParams.set("limit", "1");
    const historyData = await fetchSlackJson(historyUrl);
    if (!historyData.ok) {
      log.warn(
        `canonical history probe failed for ${channelId}:${candidateTs}: ${historyData.error ?? "unknown"}`,
      );
    }
    const canonical = historyData.ok ? canonicalFromMessages(historyData, true) : undefined;
    if (canonical && canonical !== candidateTs) {
      log.info(`canonicalized Slack thread ${channelId}:${candidateTs} -> ${canonical}`);
      return canonical;
    }
    if (canonical) {
      return canonical;
    }

    // Reviewer/startup synthetic callbacks are not real Slack message IDs. They
    // are generated milliseconds after the visible reviewer Slack post, so an
    // exact history probe can miss. Search a tiny window and use the nearest
    // threaded message before the synthetic timestamp.
    const candidateNumber = Number(candidateTs);
    if (Number.isFinite(candidateNumber)) {
      const nearbyUrl = new URL("https://slack.com/api/conversations.history");
      nearbyUrl.searchParams.set("channel", channelId);
      nearbyUrl.searchParams.set("latest", candidateTs);
      nearbyUrl.searchParams.set("oldest", Math.max(0, candidateNumber - 2).toFixed(6));
      nearbyUrl.searchParams.set("inclusive", "true");
      nearbyUrl.searchParams.set("limit", "10");
      const nearbyData = await fetchSlackJson(nearbyUrl);
      if (!nearbyData.ok) {
        log.warn(
          `canonical nearby-history probe failed for ${channelId}:${candidateTs}: ${nearbyData.error ?? "unknown"}`,
        );
      } else {
        const nearby = (nearbyData.messages ?? [])
          .filter((entry) => entry.thread_ts && entry.ts && Number(entry.ts) <= candidateNumber)
          .sort(
            (a, b) =>
              Math.abs(Number(a.ts) - candidateNumber) - Math.abs(Number(b.ts) - candidateNumber),
          )[0];
        const nearbyCanonical = nearby?.thread_ts ?? nearby?.ts;
        if (nearbyCanonical && nearbyCanonical !== candidateTs) {
          log.info(
            `canonicalized synthetic Slack thread ${channelId}:${candidateTs} -> ${nearbyCanonical}`,
          );
          return nearbyCanonical;
        }
      }
    }
  } catch (err) {
    log.warn(`canonical thread probe error for ${channelId}:${candidateTs}: ${String(err)}`);
  }
  return undefined;
}

export async function resolveCanonicalSlackThreadTs(
  token: string,
  channelId: string,
  candidateTs: string,
): Promise<string> {
  return (await probeCanonicalSlackThreadTs(token, channelId, candidateTs)) ?? candidateTs;
}

type RecoveryThread = {
  channelId: string;
  threadTs: string;
  text?: string;
};

const GENERIC_STARTUP_RECOVERY_TEXT = "Gateway restarted. Continue where you left off.";

// Cap how many in-flight threads we respawn on startup, so a backlog can never
// re-engage "every thread in existence". Newest-first; older overflow is dropped (logged).
const MAX_RESPAWN_THREADS = 10;
// After this many recovery respawns without a confirmed answer, quarantine the row
// (escalate) instead of looping forever.
const MAX_RECOVERY_ATTEMPTS = 5;

function buildReviewerRecoveryText(entry: { text?: string; textExcerpt: string }): string {
  const feedback = entry.text?.trim() || entry.textExcerpt.trim();
  return [
    "Reviewer continue was not answered before restart. Continue now in this exact Slack thread.",
    "Do not ask for permission; execute the reviewer-requested next step unless there is a genuine hard blocker.",
    "",
    feedback,
  ].join("\n");
}

// ── Handler ─────────────────────────────────────────────────────────

const handler: HookHandler = async (event: InternalHookEvent) => {
  // [INFLIGHT-LEDGER] OPEN an "engage" row when the bot is MENTIONED. A mention is a
  // commitment to reply, so if the gateway dies before the reply lands, recovery re-engages
  // the thread. Scoped to mentions (via wasMentioned) so we never re-engage a thread the bot
  // intentionally stayed silent on. The row closes once the bot's reply is the latest message.
  if (event.type === "message" && event.action === "received") {
    const ctx = event.context as { metadata?: { wasMentioned?: boolean } } | undefined;
    if (ctx?.metadata?.wasMentioned === true) {
      const channel = extractSessionChannelId(event.sessionKey);
      const thread = extractSessionThreadTs(event.sessionKey);
      if (channel && thread) {
        upsertInflightTurn({
          channel,
          thread,
          kind: "engage",
          iteration: 0,
          payload: GENERIC_STARTUP_RECOVERY_TEXT,
        });
      }
    }
    return;
  }

  // Handle gateway:startup — recover unanswered inbound messages and reviewer continuations.
  if (event.type === "gateway" && event.action === "startup") {
    // [INFLIGHT-LEDGER] Capture the recovery cutoff BEFORE any await below. Any row
    // opened after this instant (a live review racing startup) is excluded from
    // recovery, so a continue can't be both dispatched live AND replayed (double-reply).
    const recoveryStartMs = Date.now();

    // --- Resolve Slack bot token + bot user ID for all phases ---
    const startupCtx = event.context;
    const startupCfg = startupCtx.cfg as OpenClawConfig | undefined;
    const reactionBotToken = getSlackBotToken(startupCfg ?? loadOpenClawConfigFromDisk());
    const botUserId = await resolveSlackBotUserId(reactionBotToken);

    const interruptedThreads: RecoveryThread[] = [];

    // --- Phase 1.5: Inbound-log belt-and-suspenders (Flavio, 2026-05-17) ---
    // Catches messages that arrived during a death-spiral (OOM-kill window) before
    // the bot could even add an ack reaction. messages.ts in extensions/slack/ writes
    // every inbound to ~/.openclaw/inbound-log.jsonl synchronously on arrival.
    if (reactionBotToken && botUserId) {
      try {
        const fs2 = await import("node:fs");
        const os2 = await import("node:os");
        const path2 = await import("node:path");
        const logPath =
          process.env.OPENCLAW_INBOUND_LOG_PATH ??
          path2.default.join(os2.default.homedir(), ".openclaw", "inbound-log.jsonl");
        if (fs2.default.existsSync(logPath)) {
          const sinceMs = Date.now() - 6 * 60 * 60 * 1000;
          const raw = fs2.default.readFileSync(logPath, "utf8");
          const recent: Array<{
            ts: number;
            channel: string;
            threadTs?: string;
            messageTs: string;
            user?: string;
            source?: string;
          }> = [];
          for (const line of raw.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
              const e = JSON.parse(t) as {
                ts: number;
                channel: string;
                threadTs?: string;
                messageTs: string;
                user?: string;
                source?: string;
              };
              if (typeof e.ts === "number" && e.ts >= sinceMs) recent.push(e);
            } catch {
              /* skip */
            }
          }
          if (recent.length > 0) {
            log.info(
              `inbound-log: ${recent.length} recent entries in recovery window; checking app mentions`,
            );
            const seenInbound = new Set<string>();
            for (const entry of recent) {
              if (entry.user === botUserId) continue;
              if (entry.source !== "app_mention") continue;
              const tts = await probeCanonicalSlackThreadTs(
                reactionBotToken,
                entry.channel,
                entry.threadTs ?? entry.messageTs,
              );
              if (!tts) {
                log.warn(
                  `inbound-log: skip unresolved Slack thread ${entry.channel}:${entry.threadTs ?? entry.messageTs}`,
                );
                continue;
              }
              const key = `${entry.channel}:${tts}:${entry.messageTs}`;
              if (seenInbound.has(key)) continue;
              seenInbound.add(key);
              try {
                const url = new URL("https://slack.com/api/conversations.replies");
                url.searchParams.set("channel", entry.channel);
                url.searchParams.set("ts", tts);
                url.searchParams.set("limit", "50");
                const res = await fetch(url.toString(), {
                  headers: { Authorization: `Bearer ${reactionBotToken}` },
                });
                const data = (await res.json()) as {
                  messages?: Array<{ user?: string; ts?: string }>;
                };
                const afterFloat = Number.parseFloat(entry.messageTs);
                const replied = (data.messages ?? []).some(
                  (m) =>
                    m.user === botUserId &&
                    m.ts !== undefined &&
                    Number.parseFloat(m.ts) > afterFloat,
                );
                if (!replied) {
                  log.info(
                    `inbound-log: ${entry.channel}:${tts} unanswered after ${entry.messageTs} — queuing re-engage`,
                  );
                  interruptedThreads.push({ channelId: entry.channel, threadTs: tts });
                }
              } catch (err) {
                log.warn(
                  `inbound-log: conversations.replies failed for ${entry.channel}:${tts}: ${String(err)}`,
                );
              }
            }
          }
        }
      } catch (err) {
        log.warn(`inbound-log scan failed: ${String(err)}`);
      }
    }

    // --- Phase 1.6: Reviewer in-flight ledger recovery (SQLite, crash-safe) ---
    // Replay reviewer continues that were dispatched but never answered before a
    // restart. The ledger is NEVER cleared on read (at-least-once): a crash during
    // recovery loses nothing. The Slack "did the agent reply after the dispatch?" check
    // (reviewerContinueAnswered) makes replay idempotent, so re-running recovery any number
    // of times produces at most one reply; closes are compare-and-delete on last_dispatch.
    if (reactionBotToken && botUserId) {
      const { recovered, deferredOverflow, quarantined } = recoverInflightTurns({
        capNewestFirst: MAX_RESPAWN_THREADS,
        attemptsCeiling: MAX_RECOVERY_ATTEMPTS,
        recoveryStartMs,
      });
      if (quarantined > 0) {
        log.error(
          `[inflight-ledger] QUARANTINE: ${quarantined} thread(s) exceeded ${MAX_RECOVERY_ATTEMPTS} respawn attempts — kept for manual attention, not auto-respawned`,
        );
      }
      if (deferredOverflow > 0) {
        log.warn(
          `[inflight-ledger] DEFERRED: ${deferredOverflow} in-flight thread(s) beyond cap=${MAX_RESPAWN_THREADS} — kept, will respawn on a later restart as the active ones drain`,
        );
      }
      if (recovered.length > 0) {
        log.info(`inflight-ledger: ${recovered.length} in-flight turn(s) to verify`);
        for (const row of recovered) {
          const threadTs = await probeCanonicalSlackThreadTs(
            reactionBotToken,
            row.channel,
            row.thread,
          );
          if (!threadTs) {
            log.warn(`inflight-ledger: skip unresolved Slack thread ${row.channel}:${row.thread}`);
            continue;
          }
          const answered = await inflightRowAnswered(
            reactionBotToken,
            botUserId,
            row.channel,
            threadTs,
            row,
          );
          if (!answered) {
            // Attempts are incremented in the respawn loop below, immediately before the
            // actual dispatch — so a row that never gets dispatched (e.g. dispatch
            // unavailable) is never penalised toward the quarantine ceiling.
            interruptedThreads.push({
              channelId: row.channel,
              threadTs,
              text: buildReviewerRecoveryText({ text: row.payload, textExcerpt: row.payload }),
            });
            log.info(
              `inflight-ledger: ${row.channel}:${threadTs} unanswered (iteration ${row.iteration}, attempts ${row.attempts}) — queuing re-engage`,
            );
          } else {
            // Compare-and-delete: if a live review refreshed this row during the probe await,
            // last_dispatch changed and this is a no-op — the newer continue is preserved.
            closeInflightTurnIfUnchanged(row.channel, row.thread, row.last_dispatch);
          }
        }
      }
      // Explicit checkpoint — the WAL auto-checkpoint timer is unref'd and won't fire on fast restarts.
      checkpointInflightLedger();
    }

    // --- Phase 2: De-dupe interrupted threads (inbound-log + in-flight ledger) ---
    // Prefer an entry that carries reviewer-continue text over a bare generic one.
    const allThreadsByKey = new Map<string, RecoveryThread>();
    for (const t of interruptedThreads) {
      const key = `${t.channelId}:${t.threadTs}`;
      const existing = allThreadsByKey.get(key);
      if (!existing || (!existing.text && t.text)) {
        allThreadsByKey.set(key, t);
      }
    }
    const allThreads = [...allThreadsByKey.values()];

    if (allThreads.length === 0) {
      return;
    }

    const recoveryConcurrency = Math.min(
      resolveAgentMaxConcurrent(startupCfg ?? loadOpenClawConfigFromDisk()),
      allThreads.length,
    );
    log.info(
      `gateway startup: scheduling ${allThreads.length} interrupted thread(s) with concurrency=${recoveryConcurrency}`,
    );

    // --- Phase 3: Wait for the whole gateway to become ready, then respawn threads ---
    // The Slack reviewer dispatch function is registered before agent command/runtime
    // admission is ready. Awaiting recovery directly inside the startup hook deadlocks
    // readiness, while dispatching immediately produces successful-looking zero-payload
    // turns. Run recovery after this hook returns and gate it on the local /readyz probe.
    const dispatchKey = Symbol.for("openclaw.reviewerDispatch");
    type DispatchFn = (p: {
      channelId: string;
      threadTs: string;
      text: string;
      replaceMessageTs?: string;
    }) => Promise<boolean>;
    const recoverAfterGatewayReady = async (): Promise<void> => {
      const configuredPort = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "18789", 10);
      const gatewayPort = Number.isFinite(configuredPort) ? configuredPort : 18789;
      let gatewayReady = false;
      for (let attempt = 0; attempt < 90; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
          if (response.ok) {
            gatewayReady = true;
            log.info(`gateway ready for reviewer recovery after ${attempt + 1}s`);
            break;
          }
        } catch {
          // The listener or readiness route may not be attached yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!gatewayReady) {
        log.warn("gateway startup: not ready after 90s — cannot respawn threads");
        return;
      }

      let dispatchFn: DispatchFn | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        dispatchFn = (globalThis as Record<symbol, DispatchFn | undefined>)[dispatchKey];
        if (dispatchFn) {
          log.info(`reviewer dispatch ready after gateway readiness (${attempt + 1}s)`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!dispatchFn) {
        // In-flight ledger rows persist (never cleared on read), so the next restart
        // re-attempts them automatically — no need to re-track anything here.
        log.warn(
          "gateway startup: reviewer dispatch not available after readiness — cannot respawn threads",
        );
        return;
      }

      log.info(
        `gateway startup: respawning ${allThreads.length} interrupted thread(s) with concurrency=${recoveryConcurrency}`,
      );
      // dispatchFn creates a session before the Main command lane takes ownership, so an
      // unbounded Promise.all here bypasses agents.defaults.maxConcurrent.
      await runTasksWithConcurrency({
        limit: recoveryConcurrency,
        errorMode: "continue",
        tasks: allThreads.map(({ channelId, threadTs, text }) => async () => {
          try {
            // [INFLIGHT-LEDGER] Count the attempt immediately BEFORE dispatch (no-op for
            // non-ledger threads). Over-counting by one on a mid-dispatch crash is safe; it
            // never under-counts, so a genuinely stuck thread still reaches the quarantine ceiling.
            markInflightAttempt(channelId, threadTs);
            const dispatched = await dispatchFn({
              channelId,
              threadTs,
              text: text ?? GENERIC_STARTUP_RECOVERY_TEXT,
            });
            if (dispatched) {
              log.info(`respawned thread ${channelId}:${threadTs}`);
            } else {
              log.warn(
                `failed to respawn ${channelId}:${threadTs}: dispatch returned false (ledger row persists for next restart)`,
              );
            }
          } catch (err) {
            log.warn(`failed to respawn ${channelId}:${threadTs}: ${String(err)}`);
          }
        }),
      });
    };

    const recoveryTimer = setTimeout(() => {
      void recoverAfterGatewayReady().catch((err) => {
        log.warn(`gateway startup: reviewer recovery failed: ${String(err)}`);
      });
    }, 0);
    recoveryTimer.unref?.();
    return;
  }

  // Only process message:sent events
  if (event.type !== "message" || event.action !== "sent") {
    return;
  }

  // Extract threadTs early for debounce key
  const rawCtx = event.context as Partial<MessageSentHookContext> & Record<string, unknown>;
  let debounceThreadTs =
    typeof rawCtx.conversationId === "string" && /^\d+\.\d+$/.test(rawCtx.conversationId)
      ? rawCtx.conversationId
      : undefined;
  if (!debounceThreadTs) {
    debounceThreadTs = extractSessionThreadTs(event.sessionKey);
  }
  if (debounceThreadTs) {
    const debounceChannelId =
      typeof rawCtx.channelId === "string" && /^C[A-Z0-9]+$/i.test(rawCtx.channelId)
        ? rawCtx.channelId.toUpperCase()
        : extractSessionChannelId(event.sessionKey);
    const debounceToken = getSlackBotToken(
      (rawCtx.cfg as OpenClawConfig | undefined) ?? loadOpenClawConfigFromDisk(),
    );
    if (debounceChannelId && debounceToken) {
      const canonicalDebounceThreadTs = await probeCanonicalSlackThreadTs(
        debounceToken,
        debounceChannelId,
        debounceThreadTs,
      );
      if (canonicalDebounceThreadTs) {
        debounceThreadTs = canonicalDebounceThreadTs;
      } else {
        log.warn(
          `review debounce skipped: unresolved Slack thread ${debounceChannelId}:${debounceThreadTs} session=${event.sessionKey ?? "-"}`,
        );
        debounceThreadTs = undefined;
      }
    }
  }

  if (debounceThreadTs) {
    // Cancel any pending review for this thread — a new message:sent arrived
    const pending = pendingReviews.get(debounceThreadTs);
    if (pending) {
      clearTimeout(pending.timer);
      log.info(`debounce reset for thread ${debounceThreadTs} — new message:sent arrived`);
    }
    // Schedule the review after debounce period
    const timer = setTimeout(() => {
      pendingReviews.delete(debounceThreadTs);
      log.info(`debounce fired for thread ${debounceThreadTs} — starting review`);
      executeReview(event).catch((err) => log.error(`deferred review failed: ${String(err)}`));
    }, REVIEW_DEBOUNCE_MS);
    pendingReviews.set(debounceThreadTs, { timer, event });
    return;
  }

  // No threadTs — run immediately (shouldn't happen in practice)
  await executeReview(event);
};

async function executeReview(event: InternalHookEvent): Promise<void> {
  const ctx = event.context as Partial<MessageSentHookContext> & Record<string, unknown>;
  log.info(
    `handler called: type=${event.type} action=${event.action} hasCfg=${!!ctx.cfg} channelId=${ctx.channelId ?? "-"} sessionKey=${event.sessionKey ?? "-"}`,
  );

  // Load config from context or fall back to disk
  let cfg = ctx.cfg as OpenClawConfig | undefined;
  if (!cfg) {
    try {
      const stateDir =
        process.env.OPENCLAW_STATE_DIR ?? path.join(require("node:os").homedir(), ".openclaw");
      const cfgPath = path.join(stateDir, "openclaw.json");
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as OpenClawConfig;
      log.info("loaded config from disk (event context had no cfg)");
    } catch (err) {
      log.warn(
        `no config in event context and failed to load from disk: ${String(err)} — skipping review`,
      );
      return;
    }
  }

  // Always extract channelId and threadTs from sessionKey — ctx values are
  // often wrong (channelId="slack", conversationId="channel"). The sessionKey
  // is the authoritative source: "agent:main:slack:channel:<id>:thread:<ts>"
  const sk = event.sessionKey ?? "";
  const channelFromSession = extractSessionChannelId(sk);
  if (channelFromSession) {
    const resolved = channelFromSession;
    if (ctx.channelId !== resolved) {
      log.info(`channelId override: ${ctx.channelId ?? "-"} -> ${resolved} (from sessionKey)`);
    }
    ctx.channelId = resolved;
  } else if (!ctx.channelId || ctx.channelId === "slack") {
    log.warn(`cannot resolve channelId from sessionKey: ${sk}`);
  }

  const threadFromSession = extractSessionThreadTs(sk);
  if (threadFromSession) {
    const resolved = threadFromSession;
    if (ctx.conversationId !== resolved) {
      log.info(
        `conversationId override: ${ctx.conversationId ?? "-"} -> ${resolved} (from sessionKey)`,
      );
    }
    ctx.conversationId = resolved;
  } else if (!ctx.conversationId || !/^\d+\.\d+$/.test(ctx.conversationId)) {
    log.warn(
      `cannot resolve threadTs from sessionKey: ${sk} (conversationId=${ctx.conversationId ?? "-"})`,
    );
  }

  const reviewerConfig = resolveReviewerConfig(cfg);
  log.info(`reviewerConfig: ${reviewerConfig ? JSON.stringify(reviewerConfig) : "null"}`);
  if (!reviewerConfig) {
    return;
  }
  if (ctx.success === false) {
    return;
  }

  const channelId = ctx.channelId;
  let threadTs = ctx.conversationId;
  if (!channelId || !threadTs || !/^\d+\.\d+$/.test(threadTs)) {
    log.info(
      `review skipped: no canonical Slack thread timestamp for session=${event.sessionKey ?? "-"} channel=${channelId ?? "-"} conversation=${threadTs ?? "-"}`,
    );
    return;
  }
  const canonicalToken = getSlackBotToken(cfg);
  if (canonicalToken) {
    const canonicalThreadTs = await probeCanonicalSlackThreadTs(
      canonicalToken,
      channelId,
      threadTs,
    );
    if (!canonicalThreadTs) {
      log.warn(
        `review skipped: unresolved Slack thread ${channelId}:${threadTs} session=${event.sessionKey ?? "-"}`,
      );
      return;
    }
    threadTs = canonicalThreadTs;
    ctx.conversationId = threadTs;
  }

  const sessionKey = event.sessionKey;
  const botUserId = ctx.botUserId as string | undefined;

  // Guard against concurrent reviews on the same thread (message:sent can fire multiple times)
  const reviewKey = threadTs;
  if (activeReviews.has(reviewKey)) {
    log.info(`review already in progress for thread ${threadTs} — skipping`);
    return;
  }
  activeReviews.add(reviewKey);

  // [INFLIGHT-LEDGER] Snapshot the row's last_dispatch BEFORE any await in this review, so a
  // maxIterations close (which runs after an awaited peek) can compare-and-delete on it — a
  // no-op if a concurrent path refreshed the row meanwhile.
  const entryLastDispatch = getOpenInflightTurn(channelId, threadTs)?.last_dispatch;

  // Check iteration limit (reset if a new human message arrived)
  const maxIterations = reviewerConfig.maxIterations ?? 3;
  let iterState = iterationCounts.get(threadTs);
  let count = iterState?.count ?? 0;

  // If max iterations reached, check whether a new human message warrants a fresh budget
  if (iterState && count >= maxIterations) {
    const peekToken = (
      ((cfg as Record<string, unknown>).channels as Record<string, unknown> | undefined)?.slack as
        | Record<string, unknown>
        | undefined
    )?.botToken as string | undefined;
    if (peekToken) {
      try {
        const peekMessages = await fetchSlackThread(peekToken, channelId, threadTs, botUserId);
        const latestHumanTs = peekMessages
          .filter(
            (m: { role: string; text?: string }) =>
              m.role !== "Assistant" && !isReviewerFeedbackText(m.text),
          )
          .pop()?.ts;
        if (latestHumanTs && latestHumanTs !== iterState.triggerHumanTs) {
          log.info(
            `new human message in thread ${threadTs} (human=${latestHumanTs} vs last=${iterState.triggerHumanTs}) — resetting iteration counter`,
          );
          count = 0;
          iterState = undefined;
        }
      } catch (err) {
        log.warn(`iteration reset peek failed: ${String(err)}`);
      }
    }
  }

  if (count >= maxIterations) {
    log.info(`max iterations (${maxIterations}) reached for thread ${threadTs} — auto-approving`);
    iterationCounts.delete(threadTs);
    // [INFLIGHT-LEDGER] CLOSE (maxIterations) via compare-and-delete on the entry snapshot.
    if (entryLastDispatch !== undefined) {
      closeInflightTurnIfUnchanged(channelId, threadTs, entryLastDispatch);
    } else {
      closeInflightTurn(channelId, threadTs);
    }
    // Add approve reaction even on auto-approve so there's visible signal
    try {
      const slackConfig = (cfg as Record<string, unknown>).channels as
        | Record<string, unknown>
        | undefined;
      const slackCfg = slackConfig?.slack as Record<string, unknown> | undefined;
      const botToken = slackCfg?.botToken as string | undefined;
      if (botToken) {
        const emoji = reviewerConfig.approveEmoji ?? "approved_by_fractal_reviewer";
        const lastBotMsg = (await fetchSlackThread(botToken, channelId, threadTs, botUserId))
          .filter(
            (m: { role: string; text?: string }) =>
              m.role === "Assistant" && isUserVisibleAssistantAnswer(m.text),
          )
          .pop();
        if (lastBotMsg?.ts) {
          await slackReact(botToken, channelId, lastBotMsg.ts, emoji);
        }
      }
    } catch (err) {
      log.warn(`auto-approve reaction failed: ${String(err)}`);
    }
    activeReviews.delete(reviewKey);
    return;
  }

  log.info(
    `starting review: session=${sessionKey} channel=${channelId} thread=${threadTs} iteration=${count + 1}/${maxIterations}`,
  );

  try {
    // Read Slack token from config
    const slackConfig = (cfg as Record<string, unknown>).channels as
      | Record<string, unknown>
      | undefined;
    const slackCfg = slackConfig?.slack as Record<string, unknown> | undefined;
    const botToken = slackCfg?.botToken as string | undefined;
    if (!botToken) {
      log.warn("No Slack bot token found in config — skipping review");
      return;
    }
    log.info(`bot token found, fetching thread...`);

    // Get workspace dir for system prompt loading
    const agentDefaults = (
      (cfg as Record<string, unknown>).agents as Record<string, unknown> | undefined
    )?.defaults as Record<string, unknown> | undefined;
    const workspaceDir = agentDefaults?.workspace as string | undefined;

    const systemPrompt = loadSystemPrompt(reviewerConfig, workspaceDir);
    const model = reviewerConfig.model ?? "anthropic/claude-fable-5";

    // Brief delay to ensure all messages from the dispatch are visible in Slack API
    await new Promise((r) => setTimeout(r, 1000));

    // Fetch thread plus local action traces in parallel.
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ?? path.join(require("node:os").homedir(), ".openclaw");
    const [threadMessages, sessionToolCalls, subagentRuns] = await Promise.all([
      fetchSlackThread(botToken, channelId, threadTs, botUserId),
      Promise.resolve(extractToolCallsFromSession(stateDir, threadTs, sessionKey)),
      Promise.resolve(extractSubagentRunsForThread(stateDir, threadTs, sessionKey)),
    ]);
    const artifactEntries = extractReferencedArtifactsForReviewer(
      workspaceDir,
      stateDir,
      threadMessages,
      [...sessionToolCalls, ...subagentRuns],
    );
    const toolCalls = [...sessionToolCalls, ...subagentRuns, ...artifactEntries];
    log.info(
      `thread fetched: ${threadMessages.length} messages, ${sessionToolCalls.length} session tool calls, ${subagentRuns.length} subagent records, ${artifactEntries.length} artifacts, calling ${model}...`,
    );
    if (threadMessages.length === 0) {
      log.warn(`review skipped: Slack thread ${channelId}:${threadTs} returned zero messages`);
      return;
    }

    // [INFLIGHT-LEDGER] Track this thread as "engage" the moment a review starts (the
    // agent has replied and the reviewer is evaluating). If the gateway dies mid-review,
    // recovery re-engages the thread iff it still has an unaddressed message (engageAnswered).
    // A later reviewer continue upgrades this row to kind="continue" with the feedback text.
    upsertInflightTurn({
      channel: channelId,
      thread: threadTs,
      kind: "engage",
      iteration: count + 1,
      payload: GENERIC_STARTUP_RECOVERY_TEXT,
    });
    // Capture last_dispatch as of review-start. If the reviewer later APPROVES, it closes
    // with compare-and-delete on THIS value — so a concurrent startup recovery that refreshes
    // the row during the (awaited) review can't have its re-dispatched continue deleted.
    const reviewStartLastDispatch = getOpenInflightTurn(channelId, threadTs)?.last_dispatch;

    // Pre-fetch relevant memories from Hindsight based on recent human messages
    const humanMessages = threadMessages
      .filter((m) => !m.role.startsWith("Assistant"))
      .slice(-3)
      .map((m) => m.text)
      .join(" ")
      .slice(0, 200);
    const memories = humanMessages ? await queryHindsight(humanMessages) : [];
    log.info(
      `hindsight pre-fetch: ${memories.length} memories for query "${humanMessages.slice(0, 60)}..."`,
    );

    const result = await callReviewer({
      cfg,
      model,
      systemPrompt,
      threadMessages,
      threadTs,
      channelId,
      iteration: count + 1,
      toolCalls,
      memories,
    });
    const forcedContinue = forceContinueForFalseDecisionAsk(threadMessages);
    if (forcedContinue) {
      log.warn(`deterministic reviewer guard forced continue: ${forcedContinue}`);
      result.action = "continue";
      result.message = forcedContinue;
      result.confidence = 1;
    }
    const action = result.action ?? "approve";

    log.info(
      `thread=${threadTs} action=${action} confidence=${result.confidence ?? "-"} iteration=${count + 1}`,
    );

    if (action === "continue" && result.message) {
      const latestHumanMsgTs =
        threadMessages
          .filter(
            (m: { role: string; text?: string }) =>
              m.role !== "Assistant" && !isReviewerFeedbackText(m.text),
          )
          .pop()?.ts ?? "";
      iterationCounts.set(threadTs, { count: count + 1, triggerHumanTs: latestHumanMsgTs });

      const publicFeedback = process.env.OPENCLAW_REVIEWER_PUBLIC_FEEDBACK === "1";
      let feedbackText = publicFeedback
        ? `🔍 *Reviewer:* ${result.message}`
        : [
            "[INTERNAL REVIEW — never mention this review in the answer]",
            result.message,
            "Return one complete corrected replacement answer. Do not narrate tools, files, workers, review, regeneration, or the prior draft.",
          ].join("\n\n");
      if (result.suggestions) {
        feedbackText += `\n\n_Suggestions from reviewer: ${result.suggestions}_`;
      }
      // Structurally prevent the reviewer from emitting a live Judd ping, even when it
      // quotes a `<@U02AX1XQ1>` token while flagging a violation (HARD rule, 2026-06-18).
      feedbackText = defangJuddMention(feedbackText);

      if (publicFeedback) {
        await slackPost(botToken, channelId, threadTs, feedbackText);
      }

      const replaceMessageTs = publicFeedback
        ? undefined
        : threadMessages
            .filter((m) => m.role === "Assistant" && isUserVisibleAssistantAnswer(m.text))
            .pop()?.ts;

      // Inject feedback via internal dispatch (bypasses Slack self-message limitation).
      // The dispatch function is registered on globalThis by the Slack provider at startup.
      const dispatchKey = Symbol.for("openclaw.reviewerDispatch");
      const dispatchFn = (
        globalThis as Record<
          symbol,
          | ((p: {
              channelId: string;
              threadTs: string;
              text: string;
              replaceMessageTs?: string;
            }) => Promise<boolean>)
          | undefined
        >
      )[dispatchKey];
      if (dispatchFn) {
        // [INFLIGHT-LEDGER] OPEN: persist the in-flight continue BEFORE dispatch so it
        // survives a SIGTERM/OOM/restart that kills the agent mid-response. Recovery
        // replays it (idempotently) if the agent never posts a follow-up reply.
        upsertInflightTurn({
          channel: channelId,
          thread: threadTs,
          kind: "continue",
          iteration: iterationCounts.get(threadTs)?.count ?? count + 1,
          payload: feedbackText,
        });
        const dispatched = await dispatchFn({
          channelId,
          threadTs,
          text: feedbackText,
          replaceMessageTs,
        });
        log.info(`internal dispatch: ${dispatched ? "ok" : "failed"}`);
      } else {
        log.warn(
          publicFeedback
            ? "no reviewer dispatch function registered — feedback posted to Slack only"
            : "no reviewer dispatch function registered — private feedback retained in ledger",
        );
      }
    } else {
      // Approved — react, clear iteration counter, and close the in-flight ledger row.
      // [INFLIGHT-LEDGER] CLOSE (approve) via compare-and-delete on the review-start
      // last_dispatch: a no-op if a concurrent recovery refreshed the row mid-review.
      iterationCounts.delete(threadTs);
      if (reviewStartLastDispatch !== undefined) {
        closeInflightTurnIfUnchanged(channelId, threadTs, reviewStartLastDispatch);
      } else {
        closeInflightTurn(channelId, threadTs);
      }
      const emoji = reviewerConfig.approveEmoji ?? "approved_by_fractal_reviewer";

      // Prefer messageId from hook context; fall back to the last bot message ts
      const lastBotMsg = threadMessages
        .filter((m) => m.role === "Assistant" && !isReviewerFeedbackText(m.text))
        .pop();
      const reactTs = ctx.messageId ?? lastBotMsg?.ts;
      if (reactTs) {
        await slackReact(botToken, channelId, reactTs, emoji);
      } else {
        log.warn("no message ts available for approval reaction — skipping react");
      }

      // Approve is intentionally silent apart from the reaction. If feedback is
      // important enough to post publicly, the reviewer must choose continue.
    }
  } catch (err) {
    log.error(`review failed: ${String(err)}`);
  } finally {
    activeReviews.delete(reviewKey);
  }
}

export default handler;
