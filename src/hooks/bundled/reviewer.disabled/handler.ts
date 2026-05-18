/**
 * Reviewer Hook — GPT-5.4 post-turn quality gate.
 *
 * Fires on every message:sent event. When the agent finishes a turn and
 * delivers a response, this hook calls GPT-5.4 to evaluate the response.
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
import type { OpenClawConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import type { InternalHookEvent, MessageSentHookContext } from "../../internal-hooks.js";
import { addThread, removeThread, loadAndConsumeThreads } from "./active-threads.js";
import { loadAndConsumePendingReactions } from "./pending-reactions.js";

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

const DEFAULT_SYSTEM_PROMPT = `# Reviewer — Quality Gate for Opus

You are a senior quality reviewer for an AI assistant (Opus, claude-opus-4-6).
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
    if (entries.length === 0 && candidates.length > 0) {
      const mostRecent = path.join(sessionsDir, candidates[0].name);
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

async function callReviewer(params: {
  model: string;
  systemPrompt: string;
  threadMessages: Array<{ role: string; text: string; ts?: string }>;
  threadTs: string;
  channelId?: string;
  iteration?: number;
  toolCalls?: string[];
  memories?: string[];
}): Promise<ReviewResult> {
  const apiKey = resolveOpenAIApiKey();
  if (!apiKey) {
    log.warn("No OpenAI API key found — auto-approving");
    return { action: "approve", message: "", confidence: 1.0 };
  }
  // Dynamic import to avoid bundling openai in the main gateway
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

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
    const TOKEN_BUDGET_CHARS = 400_000; // ~100K tokens
    // Walk backwards (newest first), accumulate until budget is spent
    const selected: string[] = [];
    let charCount = 0;
    for (let i = params.toolCalls.length - 1; i >= 0; i--) {
      const entry = params.toolCalls[i];
      if (charCount + entry.length > TOKEN_BUDGET_CHARS) {
        break; // Budget exhausted — older entries are dropped
      }
      selected.unshift(entry); // Prepend to maintain chronological order
      charCount += entry.length;
    }
    const dropped = params.toolCalls.length - selected.length;
    const header =
      dropped > 0
        ? `(showing ${selected.length}/${params.toolCalls.length} tool calls — ${dropped} older calls trimmed to fit 100K token budget)`
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

  const userContent = `Review this conversation thread. The assistant is Opus.\n\n--- THREAD ---\n${transcript}\n--- END ---${toolSection}${memorySection}\n\nEvaluate the assistant's last response. Respond with JSON only.`;
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: userContent },
  ];

  const response = await client.chat.completions.create({
    model: params.model,
    messages,
    temperature: 0.3,
    max_completion_tokens: 1000,
    response_format: { type: "json_object" },
  });

  const rawOutput = response.choices[0]?.message?.content ?? "{}";
  let result: ReviewResult;
  try {
    result = JSON.parse(rawOutput) as ReviewResult;
  } catch {
    result = { action: "approve", message: "", confidence: 1.0 };
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
      usage: {
        input: response.usage?.prompt_tokens,
        output: response.usage?.completion_tokens,
      },
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

async function fetchSlackThread(
  token: string,
  channelId: string,
  threadTs: string,
  botUserId?: string,
): Promise<Array<{ role: string; text: string; ts?: string }>> {
  const allMessages: Array<{ user?: string; text?: string; ts?: string }> = [];
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
      messages?: Array<{ user?: string; text?: string; ts?: string }>;
      error?: string;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) {
      log.warn(`conversations.replies failed: ${data.error ?? "unknown"}`);
      break;
    }
    allMessages.push(...(data.messages ?? []));
    cursor = data.has_more ? data.response_metadata?.next_cursor : undefined;
  } while (cursor);

  log.info(`fetchSlackThread: ${allMessages.length} messages fetched (paginated)`);
  return allMessages.map((m) => ({
    role: m.user === botUserId ? "Assistant" : `User (${m.user ?? "unknown"})`,
    text: m.text ?? "(no text)",
    ts: m.ts,
  }));
}

function isReviewerFeedbackText(text: string | undefined): boolean {
  const normalized = (text ?? "").trim();
  return normalized.startsWith("🔍 *Reviewer:*") || normalized.startsWith(":mag: *Reviewer:*");
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

async function slackPost(
  token: string,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: channelId, thread_ts: threadTs, text }),
  });
}

// ── Handler ─────────────────────────────────────────────────────────

const handler: HookHandler = async (event: InternalHookEvent) => {
  // Handle gateway:startup — clean orphan reactions + re-engage interrupted threads
  if (event.type === "gateway" && event.action === "startup") {
    // --- Resolve Slack bot token + bot user ID for all phases ---
    const startupCtx = event.context;
    const startupCfg = startupCtx.cfg as OpenClawConfig | undefined;
    let reactionBotToken: string | undefined;
    let botUserId: string | undefined;
    if (startupCfg) {
      const chCfg = (startupCfg as Record<string, unknown>).channels as
        | Record<string, unknown>
        | undefined;
      const slkCfg = chCfg?.slack as Record<string, unknown> | undefined;
      reactionBotToken = slkCfg?.botToken as string | undefined;
    }

    // --- Phase 1: Clean up orphan ack reactions + collect interrupted threads ---
    const pendingReactions = loadAndConsumePendingReactions();
    const interruptedThreads: Array<{ channelId: string; threadTs: string }> = [];

    if (pendingReactions.length > 0) {
      log.info(`gateway startup: cleaning ${pendingReactions.length} orphan ack reactions`);

      // Resolve bot user ID so we can check if bot already responded
      if (reactionBotToken) {
        try {
          const authRes = await fetch("https://slack.com/api/auth.test", {
            method: "POST",
            headers: { Authorization: `Bearer ${reactionBotToken}` },
          });
          const authData = (await authRes.json()) as { ok?: boolean; user_id?: string };
          if (authData.ok && authData.user_id) {
            botUserId = authData.user_id;
          }
        } catch {}
      }

      if (reactionBotToken) {
        // All known status reaction shortcodes that could be left on messages
        const STATUS_EMOJIS = [
          "eyes",
          "thinking_face",
          "fire",
          "male-technologist",
          "female-technologist",
          "zap",
          "globe_with_meridians",
          "thumbsup",
          "scream",
          "yawning_face",
          "fearful",
          "hourglass_flowing_sand",
          "warning",
          "writing_hand",
          "brain",
          "hammer_and_wrench",
          "computer",
          "white_check_mark",
          "x",
        ];
        for (const reaction of pendingReactions) {
          const { channel, messageTs, emoji } = reaction;
          const threadTs = (reaction as Record<string, string>).threadTs ?? messageTs;

          // Clean up all possible status emojis from the message
          const emojisToRemove = new Set([emoji, ...STATUS_EMOJIS]);
          for (const emojiName of emojisToRemove) {
            try {
              const res = await fetch("https://slack.com/api/reactions.remove", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${reactionBotToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ channel, timestamp: messageTs, name: emojiName }),
              });
              const rd = (await res.json()) as { ok?: boolean; error?: string };
              if (rd.ok) {
                log.info(`removed orphan :${emojiName}: from ${channel}:${messageTs}`);
              }
            } catch (err) {
              log.warn(`orphan reaction remove failed: ${String(err)}`);
            }
          }

          // A surviving pending ack means the previous gateway did not finish
          // the dispatch lifecycle. Do not treat bot progress/block messages as
          // completion; that was the old false-positive that abandoned threads
          // after restart.
          if (threadTs) {
            interruptedThreads.push({ channelId: channel, threadTs });
            log.info(
              `thread ${channel}:${threadTs} needs re-engagement (pending ack survived restart)`,
            );
          }
        }
      } else {
        log.warn("gateway startup: no Slack bot token — cannot clean orphan reactions");
      }
    }

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
          const sinceMs = Date.now() - 30 * 60 * 1000;
          const raw = fs2.default.readFileSync(logPath, "utf8");
          const recent: Array<{ ts: number; channel: string; threadTs?: string; messageTs: string; user?: string }> = [];
          for (const line of raw.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
              const e = JSON.parse(t) as { ts: number; channel: string; threadTs?: string; messageTs: string; user?: string };
              if (typeof e.ts === "number" && e.ts >= sinceMs) recent.push(e);
            } catch { /* skip */ }
          }
          if (recent.length > 0) {
            log.info();
            const seenInbound = new Set<string>();
            for (const entry of recent) {
              if (entry.user === botUserId) continue;
              const tts = entry.threadTs ?? entry.messageTs;
              const key = `${entry.channel}:${tts}`;
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
                const data = (await res.json()) as { messages?: Array<{ user?: string; ts?: string }> };
                const afterFloat = Number.parseFloat(entry.messageTs);
                const replied = (data.messages ?? []).some(
                  (m) => m.user === botUserId && m.ts !== undefined && Number.parseFloat(m.ts) > afterFloat,
                );
                if (!replied) {
                  log.info(`inbound-log: ${entry.channel}:${tts} unanswered after ${entry.messageTs} — queuing re-engage`);
                  interruptedThreads.push({ channelId: entry.channel, threadTs: tts });
                }
              } catch (err) {
                log.warn(`inbound-log: conversations.replies failed for ${entry.channel}:${tts}: ${String(err)}`);
              }
            }
          }
        }
      } catch (err) {
        log.warn(`inbound-log scan failed: ${String(err)}`);
      }
    }

    // --- Phase 2: Merge interrupted threads with reviewer active threads ---
    const reviewerThreads = loadAndConsumeThreads();
    const seen = new Set<string>();
    const allThreads: Array<{ channelId: string; threadTs: string }> = [];

    for (const t of interruptedThreads) {
      const key = `${t.channelId}:${t.threadTs}`;
      if (!seen.has(key)) {
        seen.add(key);
        allThreads.push(t);
      }
    }
    for (const t of reviewerThreads) {
      const key = `${t.channelId}:${t.threadTs}`;
      if (!seen.has(key)) {
        seen.add(key);
        allThreads.push(t);
      }
    }

    if (allThreads.length === 0) {
      return;
    }

    log.info(
      `gateway startup: respawning ${allThreads.length} threads ` +
        `(${interruptedThreads.length} interrupted + ${reviewerThreads.length} reviewer)`,
    );

    // --- Phase 3: Poll for dispatch function + respawn threads ---
    const dispatchKey = Symbol.for("openclaw.reviewerDispatch");
    type DispatchFn = (p: {
      channelId: string;
      threadTs: string;
      text: string;
    }) => Promise<boolean>;
    let dispatchFn: DispatchFn | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      dispatchFn = (globalThis as Record<symbol, DispatchFn | undefined>)[dispatchKey];
      if (dispatchFn) {
        log.info(`reviewer dispatch ready after ${attempt + 1}s`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!dispatchFn) {
      log.warn(
        "gateway startup: reviewer dispatch not available after 30s — cannot respawn threads",
      );
      for (const { channelId, threadTs } of allThreads) {
        addThread(channelId, threadTs);
      }
      return;
    }
    for (const { channelId, threadTs } of allThreads) {
      try {
        const dispatched = await dispatchFn({
          channelId,
          threadTs,
          text: "Gateway restarted. Continue where you left off.",
        });
        if (dispatched) {
          log.info(`respawned thread ${channelId}:${threadTs}`);
        } else {
          addThread(channelId, threadTs);
          log.warn(`failed to respawn ${channelId}:${threadTs}: dispatch returned false`);
        }
      } catch (err) {
        addThread(channelId, threadTs);
        log.warn(`failed to respawn ${channelId}:${threadTs}: ${String(err)}`);
      }
    }
    return;
  }

  // Only process message:sent events
  if (event.type !== "message" || event.action !== "sent") {
    return;
  }

  // Extract threadTs early for debounce key
  const rawCtx = event.context as Partial<MessageSentHookContext> & Record<string, unknown>;
  let debounceThreadTs = rawCtx.conversationId;
  if (!debounceThreadTs) {
    const sk = event.sessionKey ?? "";
    const m = sk.match(/thread:(\d+\.\d+)/);
    if (m) {
      debounceThreadTs = m[1];
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
  const channelMatch = sk.match(/channel:(c[a-z0-9]+)/i);
  if (channelMatch) {
    const resolved = channelMatch[1].toUpperCase();
    if (ctx.channelId !== resolved) {
      log.info(`channelId override: ${ctx.channelId ?? "-"} -> ${resolved} (from sessionKey)`);
    }
    ctx.channelId = resolved;
  } else if (!ctx.channelId || ctx.channelId === "slack") {
    log.warn(`cannot resolve channelId from sessionKey: ${sk}`);
  }

  const threadMatch = sk.match(/thread:(\d+\.\d+)/);
  if (threadMatch) {
    const resolved = threadMatch[1];
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
  const threadTs = ctx.conversationId;
  if (!channelId || !threadTs) {
    return;
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
    removeThread(channelId, threadTs);
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
              m.role === "Assistant" && !isReviewerFeedbackText(m.text),
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

    // Track this thread as active (survives gateway restarts)
    addThread(channelId, threadTs);

    // Get workspace dir for system prompt loading
    const agentDefaults = (
      (cfg as Record<string, unknown>).agents as Record<string, unknown> | undefined
    )?.defaults as Record<string, unknown> | undefined;
    const workspaceDir = agentDefaults?.workspace as string | undefined;

    const systemPrompt = loadSystemPrompt(reviewerConfig, workspaceDir);
    const model = reviewerConfig.model ?? "gpt-5.4";

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
      return;
    }

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
      model,
      systemPrompt,
      threadMessages,
      threadTs,
      channelId,
      iteration: count + 1,
      toolCalls,
      memories,
    });
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

      let feedbackText = `🔍 *Reviewer:* ${result.message}`;
      if (result.suggestions) {
        feedbackText += `\n\n_Suggestions from reviewer: ${result.suggestions}_`;
      }

      // Post feedback to Slack for visibility
      await slackPost(botToken, channelId, threadTs, feedbackText);

      // Inject feedback via internal dispatch (bypasses Slack self-message limitation).
      // The dispatch function is registered on globalThis by the Slack provider at startup.
      const dispatchKey = Symbol.for("openclaw.reviewerDispatch");
      const dispatchFn = (
        globalThis as Record<
          symbol,
          | ((p: { channelId: string; threadTs: string; text: string }) => Promise<boolean>)
          | undefined
        >
      )[dispatchKey];
      if (dispatchFn) {
        const dispatched = await dispatchFn({ channelId, threadTs, text: feedbackText });
        log.info(`internal dispatch: ${dispatched ? "ok" : "failed"}`);
      } else {
        log.warn("no reviewer dispatch function registered — feedback posted to Slack only");
      }
    } else {
      // Approved — react, clear iteration counter, and untrack thread
      iterationCounts.delete(threadTs);
      removeThread(channelId, threadTs);
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
