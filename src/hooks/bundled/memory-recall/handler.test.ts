import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HINDSIGHT_CONFIG,
  type HindsightRecallOutcome,
} from "../../../../extensions/memory-core/src/hindsight.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listCoreHooks, resetCoreHooksForTest } from "../../../plugins/core-hooks.js";
import type {
  PluginHookAgentContext,
  PluginHookInboundMessageContext,
} from "../../../plugins/hook-types.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import {
  DEFAULT_MEMORY_RECALL_CONFIG,
  MEMORY_RECALL_TIMEOUT_CAP_MS,
  resolveMemoryRecallConfig,
} from "./config.js";
import { RETRIEVED_MEMORY_HEADER } from "./context-block.js";
import {
  createDefaultRetrievers,
  createMemoryRecallHook,
  createPromptBuildHandler,
  HINDSIGHT_MAX_RESULTS,
  LOG_WRITE_TIMEOUT_MS,
  MEMORY_RECALL_HOOK_NAME,
  MEMORY_RECALL_PLUGIN_ID,
  PROMPT_BUILD_TIMEOUT_MARGIN_MS,
  type MemoryRecallDeps,
} from "./handler.js";
import { InboundMessageStash } from "./inbound-messages.js";
import { RETRIEVAL_LOG_FILE, type RetrievalLogEntry } from "./retrieval-log.js";
import type { MemoryRetrievers } from "./retrieval.js";

const hindsightMocks = vi.hoisted(() => ({
  recallHindsightMemoriesSafely: vi.fn<() => Promise<HindsightRecallOutcome>>(),
  resolveHindsightConfig: vi.fn(),
}));

vi.mock("../../../../extensions/memory-core/src/hindsight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../extensions/memory-core/src/hindsight.js")>()),
  ...hindsightMocks,
}));

const workspaceStateMocks = vi.hoisted(() => ({
  appendDelayMs: 0,
}));

vi.mock("../../workspace-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workspace-state.js")>();
  return {
    ...actual,
    appendJsonlRecordsAfterRead: async (
      ...args: Parameters<typeof actual.appendJsonlRecordsAfterRead>
    ) => {
      if (workspaceStateMocks.appendDelayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, workspaceStateMocks.appendDelayMs);
        });
      }
      return actual.appendJsonlRecordsAfterRead(...args);
    },
  };
});

const THREAD_SESSION = "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609";
const THREAD_TS = "1786591963.108609";
const MESSAGE_TS = "1786591970.000100";
const LONG_TEXT = "How did we decide to route the ARP spoofing prompt last week?";
const CFG = {} as OpenClawConfig;
const ENABLED = { ...DEFAULT_MEMORY_RECALL_CONFIG, enabled: true };
const PROMPT_EVENT = { prompt: "<assembled prompt, never parsed>", messages: [] };

let workspaceDir = "";

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-recall-"));
  workspaceStateMocks.appendDelayMs = 0;
});

afterEach(async () => {
  resetCoreHooksForTest();
  vi.useRealTimers();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

async function readLog(): Promise<RetrievalLogEntry[]> {
  const content = await fs.readFile(path.join(workspaceDir, "state", RETRIEVAL_LOG_FILE), "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RetrievalLogEntry);
}

async function logExists(): Promise<boolean> {
  return fs
    .access(path.join(workspaceDir, "state", RETRIEVAL_LOG_FILE))
    .then(() => true)
    .catch(() => false);
}

function inbound(overrides: Partial<PluginHookInboundMessageContext> = {}) {
  return {
    messageId: MESSAGE_TS,
    threadTs: THREAD_TS,
    channel: "C0A3C98HS48",
    senderIsBot: false,
    text: LONG_TEXT,
    ...overrides,
  };
}

function agentContext(overrides: Partial<PluginHookAgentContext> = {}): PluginHookAgentContext {
  return {
    sessionKey: THREAD_SESSION,
    agentId: "main",
    trigger: "user",
    inboundMessage: inbound(),
    ...overrides,
  };
}

function receivedEvent(params: {
  ts: string;
  text?: string;
  sessionKey?: string;
  threadId?: string;
  provider?: string;
  senderIsBot?: boolean;
}) {
  return createInternalHookEvent("message", "received", params.sessionKey ?? THREAD_SESSION, {
    from: "slack:U012",
    content: params.text ?? LONG_TEXT,
    channelId: "slack",
    conversationId: "channel:C0A3C98HS48",
    messageId: params.ts,
    metadata: {
      senderId: "U012",
      threadId: params.threadId,
      provider: params.provider,
      senderIsBot: params.senderIsBot,
    },
  });
}

const okRetrievers: MemoryRetrievers = {
  recallHindsight: async () => ({
    results: [
      {
        corpus: "hindsight",
        source: "hindsight",
        id: "h1",
        path: "hindsight:h1",
        score: 0.9,
        snippet: "Routed the ARP prompt via the classifier",
        date: "2026-08-20",
      },
    ],
    fetched: 1,
    ms: 4,
  }),
  searchMarkdown: async () => [
    {
      path: "memory/2026-08-20.md",
      startLine: 7,
      endLine: 9,
      score: 0.7,
      snippet: "Compare pane auto-routes via deploy classifier",
      source: "memory",
    },
  ],
};

const EXPECTED_BLOCK = [
  RETRIEVED_MEMORY_HEADER,
  "[hindsight 2026-08-20] Routed the ARP prompt via the classifier — ref: hindsight:h1",
  "[memory 2026-08-20] Compare pane auto-routes via deploy classifier — ref: memory/2026-08-20.md#L7",
].join("\n");

function buildDeps(overrides: Partial<MemoryRecallDeps> = {}) {
  const warnings: string[] = [];
  const errors: string[] = [];
  const createRetrievers = vi.fn(() => okRetrievers);
  const deps: MemoryRecallDeps = {
    stash: new InboundMessageStash(),
    resolveConfig: () => ({ cfg: CFG, recall: ENABLED }),
    createRetrievers,
    resolveWorkspaceDir: () => workspaceDir,
    warn: (message) => warnings.push(message),
    logError: (message) => errors.push(message),
    now: () => new Date("2026-09-03T10:00:00.000Z"),
    ...overrides,
  };
  return { deps, warnings, errors, createRetrievers };
}

function capturingQuery(createRetrievers: ReturnType<typeof vi.fn>) {
  const searchMarkdown = vi.fn<MemoryRetrievers["searchMarkdown"]>(async () => []);
  createRetrievers.mockReturnValue({ ...okRetrievers, searchMarkdown });
  return () => searchMarkdown.mock.calls[0]?.[0];
}

describe("memory-recall hook handler", () => {
  it("registers before_prompt_build once as a core hook with a timeout above the retrieval deadline", async () => {
    const { deps } = buildDeps();
    const hook = createMemoryRecallHook(deps);

    hook.register();
    await hook.internalHook(createInternalHookEvent("gateway", "startup", "gateway:startup"));
    await hook.internalHook(receivedEvent({ ts: MESSAGE_TS }));

    const registered = listCoreHooks().filter(
      (entry) => entry.pluginId === MEMORY_RECALL_PLUGIN_ID,
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      hookName: MEMORY_RECALL_HOOK_NAME,
      timeoutMs: ENABLED.timeoutMs + PROMPT_BUILD_TIMEOUT_MARGIN_MS,
    });
  });

  it("derives the runner budget from the live hook timeout plus the margin", () => {
    let timeoutMs = DEFAULT_MEMORY_RECALL_CONFIG.timeoutMs;
    const { deps } = buildDeps({
      resolveConfig: () => ({ cfg: CFG, recall: { ...ENABLED, timeoutMs } }),
    });
    const hook = createMemoryRecallHook(deps);
    const budget = () =>
      listCoreHooks().find((entry) => entry.pluginId === MEMORY_RECALL_PLUGIN_ID)?.timeoutMs;

    hook.register();
    expect(PROMPT_BUILD_TIMEOUT_MARGIN_MS).toBe(1_500);
    expect(budget()).toBe(8_500);

    timeoutMs = MEMORY_RECALL_TIMEOUT_CAP_MS;
    hook.register();
    expect(budget()).toBe(MEMORY_RECALL_TIMEOUT_CAP_MS + PROMPT_BUILD_TIMEOUT_MARGIN_MS);
  });

  it("stashes human messages per thread and remembers bot-authored ids", async () => {
    const { deps } = buildDeps();
    const handler = createMemoryRecallHook(deps).internalHook;

    await handler(receivedEvent({ ts: "1", provider: "heartbeat", threadId: THREAD_TS }));
    await handler(receivedEvent({ ts: "2", provider: "cron-event", threadId: THREAD_TS }));
    await handler(receivedEvent({ ts: "3", provider: "exec-event", threadId: THREAD_TS }));
    await handler(receivedEvent({ ts: "4", senderIsBot: true, threadId: THREAD_TS }));
    await handler(receivedEvent({ ts: "5", provider: "slack", threadId: THREAD_TS }));

    for (const ts of ["1", "2", "3", "4"]) {
      expect(deps.stash.find(THREAD_SESSION, THREAD_TS, ts)).toBeUndefined();
    }
    expect(deps.stash.isRejectedBotMessage(THREAD_SESSION, "4")).toBe(true);
    expect(deps.stash.find(THREAD_SESSION, THREAD_TS, "5")).toMatchObject({
      messageId: "5",
      text: LONG_TEXT,
      threadId: THREAD_TS,
    });
  });

  it("keeps a registered handler when startup re-registration cannot resolve config", async () => {
    let failConfig = false;
    const { deps } = buildDeps({
      resolveConfig: () => {
        if (failConfig) {
          throw new Error("snapshot exploded");
        }
        return { cfg: CFG, recall: ENABLED };
      },
    });
    const hook = createMemoryRecallHook(deps);
    hook.register();
    failConfig = true;

    expect(() =>
      hook.internalHook(createInternalHookEvent("gateway", "startup", "gateway:startup")),
    ).not.toThrow();

    expect(
      listCoreHooks().filter((entry) => entry.pluginId === MEMORY_RECALL_PLUGIN_ID),
    ).toHaveLength(1);
  });

  it("clamps retrieval to the registered outer timeout when the live config grows", async () => {
    let timeoutMs = 3000;
    const { deps, createRetrievers, warnings } = buildDeps({
      resolveConfig: () => ({ cfg: CFG, recall: { ...ENABLED, timeoutMs } }),
    });
    const hook = createMemoryRecallHook(deps);
    hook.register();
    timeoutMs = 60_000;
    vi.useFakeTimers();
    createRetrievers.mockReturnValue({
      recallHindsight: () => new Promise(() => {}),
      searchMarkdown: () => new Promise(() => {}),
    });
    const promptBuild = listCoreHooks().find((entry) => entry.pluginId === MEMORY_RECALL_PLUGIN_ID)
      ?.handler as ReturnType<typeof createPromptBuildHandler>;

    const pending = promptBuild(PROMPT_EVENT, agentContext());
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();

    expect(await pending).toBeUndefined();
    expect(warnings).toEqual([
      "memory-recall: hindsight: timed out after 3000ms; markdown: timed out after 3000ms",
    ]);
  });
});

describe("memory-recall prompt build", () => {
  it("injects the retrieved block and logs one line per message id", async () => {
    const { deps, warnings, errors, createRetrievers } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);

    const first = await promptBuild(PROMPT_EVENT, agentContext());
    const retry = await promptBuild(PROMPT_EVENT, agentContext());

    expect(first).toEqual({ prependContext: EXPECTED_BLOCK });
    expect(retry).toEqual(first);
    expect(createRetrievers).toHaveBeenCalledTimes(1);
    expect(createRetrievers).toHaveBeenCalledWith({
      cfg: CFG,
      agentId: "main",
      sessionKey: THREAD_SESSION,
      recall: ENABLED,
    });
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);

    const entries = await readLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      ts: "2026-09-03T10:00:00.000Z",
      session_key: THREAD_SESSION,
      message_id: MESSAGE_TS,
      query_digest: expect.any(String),
      channel: "C0A3C98HS48",
      thread_ts: THREAD_TS,
      query: LONG_TEXT,
      hindsight_hits: 1,
      markdown_hits: 1,
      ms: expect.any(Number),
      failed_sources: [],
      error: null,
      injected_chars: EXPECTED_BLOCK.length,
    });
  });

  it("retrieves once when the same turn builds its prompt concurrently", async () => {
    const { deps, createRetrievers } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);

    const results = await Promise.all([
      promptBuild(PROMPT_EVENT, agentContext()),
      promptBuild(PROMPT_EVENT, agentContext()),
      promptBuild(PROMPT_EVENT, agentContext()),
    ]);

    expect(results).toEqual([
      { prependContext: EXPECTED_BLOCK },
      { prependContext: EXPECTED_BLOCK },
      { prependContext: EXPECTED_BLOCK },
    ]);
    expect(createRetrievers).toHaveBeenCalledTimes(1);
    expect(await readLog()).toHaveLength(1);
  });

  it("retrieves again when the same message id arrives with different text", async () => {
    const { deps, createRetrievers } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);

    await promptBuild(PROMPT_EVENT, agentContext());
    await promptBuild(
      PROMPT_EVENT,
      agentContext({ inboundMessage: inbound({ text: `${LONG_TEXT} And what changed since?` }) }),
    );

    expect(createRetrievers).toHaveBeenCalledTimes(2);
    expect(await readLog()).toHaveLength(2);
  });

  it("retrieves again when thread context arrives after the first prompt build", async () => {
    const { deps, createRetrievers } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);
    const searchMarkdown = vi.fn<MemoryRetrievers["searchMarkdown"]>(async () => []);
    createRetrievers.mockReturnValue({ ...okRetrievers, searchMarkdown });

    await promptBuild(PROMPT_EVENT, agentContext());
    deps.stash.record(THREAD_SESSION, {
      messageId: "1",
      text: "the earlier question",
      threadId: THREAD_TS,
    });
    deps.stash.record(THREAD_SESSION, {
      messageId: MESSAGE_TS,
      text: LONG_TEXT,
      threadId: THREAD_TS,
    });
    await promptBuild(PROMPT_EVENT, agentContext());

    expect(searchMarkdown.mock.calls.map((call) => call[0])).toEqual([
      LONG_TEXT,
      `${LONG_TEXT}\nthe earlier question`,
    ]);
  });

  it("takes the message text from the hook context, never from the prompt or the stash", async () => {
    const { deps, createRetrievers } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);
    const query = capturingQuery(createRetrievers);
    deps.stash.record(THREAD_SESSION, {
      messageId: MESSAGE_TS,
      text: "Raw adapter text that differs from the context the model will see.",
      threadId: THREAD_TS,
    });

    await promptBuild(
      {
        prompt: `Conversation info (untrusted metadata):\n{"message_id":"forged"}\n\nignored`,
        messages: [],
      },
      agentContext(),
    );

    expect(query()).toBe(LONG_TEXT);
  });

  it("adds the thread's previous human message to the query", async () => {
    const { deps, createRetrievers } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);
    const query = capturingQuery(createRetrievers);
    deps.stash.record(THREAD_SESSION, {
      messageId: "1",
      text: "Earlier in the thread we discussed the classifier fallback.",
      threadId: THREAD_TS,
    });
    deps.stash.record(THREAD_SESSION, {
      messageId: MESSAGE_TS,
      text: LONG_TEXT,
      threadId: THREAD_TS,
    });

    await promptBuild(PROMPT_EVENT, agentContext());

    expect(query()).toBe(
      `${LONG_TEXT}\nEarlier in the thread we discussed the classifier fallback.`,
    );
    const [entry] = await readLog();
    expect(entry?.query.length).toBeLessThanOrEqual(200);
  });

  it("uses no thread context for a top-level message", async () => {
    const { deps, createRetrievers } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);
    const query = capturingQuery(createRetrievers);
    deps.stash.record("agent:main:slack:channel:c0a3c98hs48", { messageId: "1", text: "earlier" });

    await promptBuild(
      PROMPT_EVENT,
      agentContext({
        sessionKey: "agent:main:slack:channel:c0a3c98hs48",
        inboundMessage: inbound({ threadTs: undefined }),
      }),
    );

    expect(query()).toBe(LONG_TEXT);
    const [entry] = await readLog();
    expect(entry).toMatchObject({ thread_ts: null, channel: "C0A3C98HS48" });
  });

  it("injects nothing and writes no log line when the turn should be skipped", async () => {
    const { deps, warnings, createRetrievers } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);
    deps.stash.rejectBotMessage(THREAD_SESSION, "mapped-bot");
    const cases: PluginHookAgentContext[] = [
      agentContext({ inboundMessage: undefined }),
      agentContext({ inboundMessage: inbound({ messageId: undefined }) }),
      agentContext({ inboundMessage: inbound({ senderIsBot: true }) }),
      agentContext({
        inboundMessage: inbound({ messageId: "mapped-bot", senderIsBot: undefined }),
      }),
      agentContext({ inboundMessage: inbound({ text: "x".repeat(24) }) }),
      agentContext({ inboundMessage: inbound({ text: undefined }) }),
      agentContext({ trigger: "heartbeat" }),
      agentContext({ messageProvider: "cron-event" }),
    ];

    for (const ctx of cases) {
      expect(await promptBuild(PROMPT_EVENT, ctx)).toBeUndefined();
    }

    expect(createRetrievers).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    expect(await logExists()).toBe(false);
  });

  it("retrieves for a message of exactly minMessageChars", async () => {
    const { deps, createRetrievers } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);

    await promptBuild(
      PROMPT_EVENT,
      agentContext({ inboundMessage: inbound({ text: "x".repeat(25) }) }),
    );

    expect(createRetrievers).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the hook is disabled in config", async () => {
    const { deps, createRetrievers, warnings } = buildDeps({
      resolveConfig: () => ({ cfg: CFG, recall: DEFAULT_MEMORY_RECALL_CONFIG }),
    });
    const promptBuild = createPromptBuildHandler(deps);

    expect(await promptBuild(PROMPT_EVENT, agentContext())).toBeUndefined();
    expect(createRetrievers).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("warns when enabled but the runtime config or session key is missing", async () => {
    const noConfig = buildDeps({ resolveConfig: () => ({ cfg: null, recall: ENABLED }) });
    const noSession = buildDeps();

    expect(await createPromptBuildHandler(noConfig.deps)(PROMPT_EVENT, agentContext())).toBe(
      undefined,
    );
    expect(
      await createPromptBuildHandler(noSession.deps)(
        PROMPT_EVENT,
        agentContext({ sessionKey: undefined }),
      ),
    ).toBeUndefined();

    expect(noConfig.warnings).toEqual([
      "memory-recall: runtime config snapshot unavailable; nothing retrieved",
    ]);
    expect(noSession.warnings).toEqual([
      "memory-recall: no session key on the prompt-build context; nothing retrieved",
    ]);
  });

  it("logs the channel from the hook context for non-Slack sessions", async () => {
    const { deps } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);

    await promptBuild(
      PROMPT_EVENT,
      agentContext({
        sessionKey: "agent:main:discord:channel:123",
        chatId: "123",
        inboundMessage: inbound({ channel: undefined, threadTs: undefined }),
      }),
    );

    const [entry] = await readLog();
    expect(entry).toMatchObject({ channel: "123", thread_ts: null });
  });

  it("prefers the channel from the hook context over session-key parsing", async () => {
    const { deps } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);

    await promptBuild(PROMPT_EVENT, agentContext({ inboundMessage: inbound({ channel: "D0DM" }) }));

    const [entry] = await readLog();
    expect(entry).toMatchObject({ channel: "D0DM" });
  });

  it("injects nothing when both sources return no hits, but still logs", async () => {
    const { deps } = buildDeps({
      createRetrievers: () => ({
        recallHindsight: async () => ({ results: [], fetched: 0, ms: 1 }),
        searchMarkdown: async () => [],
      }),
    });
    const promptBuild = createPromptBuildHandler(deps);

    expect(await promptBuild(PROMPT_EVENT, agentContext())).toBeUndefined();
    const [entry] = await readLog();
    expect(entry).toMatchObject({ hindsight_hits: 0, markdown_hits: 0, injected_chars: 0 });
  });

  it("injects the surviving source and logs the failed one (partial success)", async () => {
    const { deps, warnings } = buildDeps({
      createRetrievers: () => ({
        ...okRetrievers,
        searchMarkdown: async () => {
          throw new Error("index locked");
        },
      }),
    });
    const promptBuild = createPromptBuildHandler(deps);

    const result = await promptBuild(PROMPT_EVENT, agentContext());

    expect(result?.prependContext?.split("\n")).toEqual([
      RETRIEVED_MEMORY_HEADER,
      "[hindsight 2026-08-20] Routed the ARP prompt via the classifier — ref: hindsight:h1",
    ]);
    expect(warnings).toEqual(["memory-recall: markdown: index locked"]);
    const [entry] = await readLog();
    expect(entry).toMatchObject({
      hindsight_hits: 1,
      markdown_hits: 0,
      failed_sources: ["markdown"],
      error: "markdown: index locked",
    });
  });

  it("warns, injects nothing and logs the error when both sources fail", async () => {
    const { deps, warnings } = buildDeps({
      createRetrievers: () => ({
        recallHindsight: async () => {
          throw new Error("hindsight down");
        },
        searchMarkdown: async () => {
          throw new Error("index locked");
        },
      }),
    });
    const promptBuild = createPromptBuildHandler(deps);

    expect(await promptBuild(PROMPT_EVENT, agentContext())).toBeUndefined();
    expect(warnings).toEqual(["memory-recall: hindsight: hindsight down; markdown: index locked"]);
    const [entry] = await readLog();
    expect(entry).toMatchObject({
      failed_sources: ["hindsight", "markdown"],
      error: "hindsight: hindsight down; markdown: index locked",
      injected_chars: 0,
    });
  });

  it("logs a retriever-factory failure as a failed retrieval", async () => {
    const { deps, warnings } = buildDeps({
      createRetrievers: () => {
        throw new Error("no runtime");
      },
    });
    const promptBuild = createPromptBuildHandler(deps);

    expect(await promptBuild(PROMPT_EVENT, agentContext())).toBeUndefined();
    expect(warnings).toEqual(["memory-recall: retrievers unavailable: no runtime"]);
    const [entry] = await readLog();
    expect(entry).toMatchObject({
      failed_sources: ["hindsight", "markdown"],
      error: "retrievers unavailable: no runtime",
      injected_chars: 0,
    });
  });

  it("still injects when the log write fails, logs an error, and retries the log next time", async () => {
    let failWrites = true;
    const { deps, errors, warnings, createRetrievers } = buildDeps({
      resolveWorkspaceDir: () => (failWrites ? "/dev/null/not-a-dir" : workspaceDir),
    });
    const promptBuild = createPromptBuildHandler(deps);

    const first = await promptBuild(PROMPT_EVENT, agentContext());
    failWrites = false;
    const second = await promptBuild(PROMPT_EVENT, agentContext());

    expect(first).toEqual({ prependContext: EXPECTED_BLOCK });
    expect(second).toEqual(first);
    expect(warnings).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^memory-recall: retrieval log write failed: /);
    expect(createRetrievers).toHaveBeenCalledTimes(2);
    expect(await readLog()).toHaveLength(1);
  });

  it("does not let a slow log write hold the turn past the write deadline", async () => {
    vi.useFakeTimers();
    workspaceStateMocks.appendDelayMs = LOG_WRITE_TIMEOUT_MS * 5;
    const { deps, errors } = buildDeps();
    const promptBuild = createPromptBuildHandler(deps);

    const pending = promptBuild(PROMPT_EVENT, agentContext());
    await vi.advanceTimersByTimeAsync(LOG_WRITE_TIMEOUT_MS);

    expect(await pending).toEqual({ prependContext: EXPECTED_BLOCK });
    expect(errors).toEqual([
      `memory-recall: retrieval log write failed: retrieval log write timed out after ${LOG_WRITE_TIMEOUT_MS}ms`,
    ]);
  });

  it("shrinks the log write deadline to what is left of the runner budget", async () => {
    vi.useFakeTimers();
    workspaceStateMocks.appendDelayMs = LOG_WRITE_TIMEOUT_MS * 5;
    const outerTimeoutMs = 2_000;
    const { deps, errors } = buildDeps({ resolveOuterTimeoutMs: () => outerTimeoutMs });
    const promptBuild = createPromptBuildHandler(deps);

    const pending = promptBuild(PROMPT_EVENT, agentContext());
    await vi.advanceTimersByTimeAsync(outerTimeoutMs);

    expect(await pending).toEqual({ prependContext: EXPECTED_BLOCK });
    expect(errors).toEqual([
      `memory-recall: retrieval log write failed: retrieval log write timed out after ${outerTimeoutMs}ms`,
    ]);
  });

  it("does not log a turn twice after a process restart", async () => {
    const first = buildDeps();
    const second = buildDeps();

    await createPromptBuildHandler(first.deps)(PROMPT_EVENT, agentContext());
    const replay = await createPromptBuildHandler(second.deps)(PROMPT_EVENT, agentContext());

    expect(replay).toEqual({ prependContext: EXPECTED_BLOCK });
    expect(second.createRetrievers).toHaveBeenCalledTimes(1);
    expect(await readLog()).toHaveLength(1);
  });

  it("never throws into the prompt build", async () => {
    const { deps, warnings } = buildDeps({
      resolveConfig: () => {
        throw new Error("config exploded");
      },
    });
    const promptBuild = createPromptBuildHandler(deps);

    expect(await promptBuild(PROMPT_EVENT, agentContext())).toBeUndefined();
    expect(warnings).toEqual([
      "memory-recall: retrieval failed; nothing injected: config exploded",
    ]);
  });
});

describe("createDefaultRetrievers", () => {
  const recall = { ...ENABLED, maxItems: 4, timeoutMs: 1234 };
  const params = { cfg: CFG, agentId: "main", sessionKey: THREAD_SESSION, recall };

  it("reports Hindsight as disabled without calling it", async () => {
    hindsightMocks.resolveHindsightConfig.mockReturnValue({
      ...DEFAULT_HINDSIGHT_CONFIG,
      enabled: false,
    });

    const outcome = await createDefaultRetrievers(params).recallHindsight(
      "q",
      AbortSignal.timeout(1000),
    );

    expect(outcome).toEqual({
      results: [],
      fetched: 0,
      ms: 0,
      error: "hindsight disabled in memory-core config",
    });
    expect(hindsightMocks.recallHindsightMemoriesSafely).not.toHaveBeenCalled();
  });

  it("recalls with the plugin config at budget mid, six candidates, hook timeout, cancellable", async () => {
    hindsightMocks.resolveHindsightConfig.mockReturnValue({
      ...DEFAULT_HINDSIGHT_CONFIG,
      enabled: true,
      bank: "fractal",
      budget: "high",
      maxResults: 8,
      timeoutMs: 4000,
    });
    hindsightMocks.recallHindsightMemoriesSafely.mockResolvedValue({
      results: [],
      fetched: 0,
      ms: 1,
    });
    const signal = AbortSignal.timeout(1000);

    await createDefaultRetrievers(params).recallHindsight("q", signal);

    expect(HINDSIGHT_MAX_RESULTS).toBe(6);
    expect(hindsightMocks.recallHindsightMemoriesSafely).toHaveBeenCalledWith({
      config: {
        ...DEFAULT_HINDSIGHT_CONFIG,
        enabled: true,
        bank: "fractal",
        budget: "mid",
        maxResults: 6,
        timeoutMs: 1234,
      },
      query: "q",
      maxResults: 6,
      cancellation: { callerSignal: signal },
    });
  });
});

describe("resolveMemoryRecallConfig", () => {
  it("defaults to disabled with the documented limits", () => {
    expect(resolveMemoryRecallConfig(null)).toEqual(DEFAULT_MEMORY_RECALL_CONFIG);
  });

  it("reads overrides, ignores invalid values, and never raises the hard caps", () => {
    const cfg = {
      hooks: {
        internal: {
          entries: {
            "memory-recall": {
              enabled: true,
              maxItems: 3,
              maxChars: "big",
              minMessageChars: 40,
              timeoutMs: 0,
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveMemoryRecallConfig(cfg)).toEqual({
      ...DEFAULT_MEMORY_RECALL_CONFIG,
      enabled: true,
      maxItems: 3,
      minMessageChars: 40,
    });

    const loosened = {
      hooks: {
        internal: {
          entries: {
            "memory-recall": {
              maxItems: 100,
              maxChars: 10_000,
              timeoutMs: 60_000,
              minMessageChars: 1,
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveMemoryRecallConfig(loosened)).toEqual({
      ...DEFAULT_MEMORY_RECALL_CONFIG,
      timeoutMs: MEMORY_RECALL_TIMEOUT_CAP_MS,
    });
  });

  it("lets config raise the retrieval deadline to the hard ceiling but no further", () => {
    const resolveTimeoutMs = (timeoutMs: number): number =>
      resolveMemoryRecallConfig({
        hooks: { internal: { entries: { "memory-recall": { timeoutMs } } } },
      } as OpenClawConfig).timeoutMs;

    expect(DEFAULT_MEMORY_RECALL_CONFIG.timeoutMs).toBe(7000);
    expect(MEMORY_RECALL_TIMEOUT_CAP_MS).toBe(9000);
    expect(resolveTimeoutMs(4000)).toBe(4000);
    expect(resolveTimeoutMs(MEMORY_RECALL_TIMEOUT_CAP_MS)).toBe(MEMORY_RECALL_TIMEOUT_CAP_MS);
    expect(resolveTimeoutMs(MEMORY_RECALL_TIMEOUT_CAP_MS + 1)).toBe(MEMORY_RECALL_TIMEOUT_CAP_MS);
  });
});
