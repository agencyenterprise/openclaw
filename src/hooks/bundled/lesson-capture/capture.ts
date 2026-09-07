// The `agent_end` handler behind the lesson-capture hook.
import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type {
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
} from "../../../plugins/hook-types.js";
import {
  extractSlackChannelFromSessionKey,
  extractSlackThreadTsFromSessionKey,
} from "../../slack-thread.js";
import {
  appendJsonlRecordsAfterRead,
  resolveWorkspaceStatePath,
  type WorkspaceDirResolver,
} from "../../workspace-state.js";
import { extractTranscriptTurns, lastTurn, tail } from "./transcript.js";
import { compileLessonTriggers, findTrigger, type LessonTriggerConfig } from "./triggers.js";

const log = createSubsystemLogger("hooks/lesson-capture");

export const LESSON_CANDIDATES_FILE = "lesson_candidates.jsonl";
const ASSISTANT_EXCERPT_CHARS = 1500;
const HUMAN_EXCERPT_CHARS = 500;

export type LessonCandidate = {
  id: string;
  session_key: string;
  channel?: string;
  thread_ts?: string;
  trigger: string;
  excerpt: string;
  created_at: string;
  status: "candidate";
};

function buildCandidateId(sessionKey: string, trigger: string, triggeringText: string): string {
  return createHash("sha256")
    .update(`${sessionKey}\n${trigger}\n${triggeringText}`)
    .digest("hex")
    .slice(0, 24);
}

export function buildLessonCandidate(params: {
  messages: readonly unknown[];
  sessionKey: string;
  triggers: LessonTriggerConfig;
  now: Date;
}): LessonCandidate | undefined {
  const turns = extractTranscriptTurns(params.messages);
  const assistant = lastTurn(turns, "assistant");
  const human = lastTurn(turns, "user");
  const compiled = compileLessonTriggers(params.triggers);
  // A human correction is the stronger evidence, so it wins over a result-like assistant turn.
  const trigger =
    findTrigger(compiled.correction, human?.text) ?? findTrigger(compiled.result, assistant?.text);
  if (!trigger || !assistant) {
    return undefined;
  }
  const triggeringText = trigger.startsWith("human:") ? (human?.text ?? "") : assistant.text;
  const excerpt = [
    `assistant: ${tail(assistant.text, ASSISTANT_EXCERPT_CHARS)}`,
    ...(human ? [`human: ${tail(human.text, HUMAN_EXCERPT_CHARS)}`] : []),
  ].join("\n\n");
  const channel = extractSlackChannelFromSessionKey(params.sessionKey);
  const threadTs = extractSlackThreadTsFromSessionKey(params.sessionKey);
  return {
    id: buildCandidateId(params.sessionKey, trigger, triggeringText),
    session_key: params.sessionKey,
    ...(channel ? { channel } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
    trigger,
    excerpt,
    created_at: params.now.toISOString(),
    status: "candidate",
  };
}

export type LessonCaptureHandler = (
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
) => Promise<void>;

export function createLessonCaptureHandler(deps: {
  resolveWorkspaceDir: WorkspaceDirResolver;
  resolveTriggers: () => LessonTriggerConfig;
  now?: () => Date;
}): LessonCaptureHandler {
  const now = deps.now ?? (() => new Date());

  return async (event, ctx) => {
    // Failed turns are kept: an aborted turn can still carry the human correction.
    if (!ctx.sessionKey) {
      return;
    }
    const candidate = buildLessonCandidate({
      messages: event.messages,
      sessionKey: ctx.sessionKey,
      triggers: deps.resolveTriggers(),
      now: now(),
    });
    if (!candidate) {
      return;
    }
    const filePath = resolveWorkspaceStatePath(
      ctx.workspaceDir ?? deps.resolveWorkspaceDir(ctx.sessionKey),
      LESSON_CANDIDATES_FILE,
    );
    const written = await appendJsonlRecordsAfterRead<LessonCandidate, boolean>(
      filePath,
      (current) => {
        if (current.malformedLines.length > 0) {
          log.warn(
            `lesson-capture: skipped malformed lines ${current.malformedLines.join(",")} in ${filePath}`,
          );
        }
        const known = current.records.some((record) => record.id === candidate.id);
        return { append: known ? [] : [candidate], result: !known };
      },
    );
    if (written) {
      log.info(
        `lesson-capture: candidate ${candidate.id} (${candidate.trigger}) for ${candidate.session_key}`,
      );
    }
  };
}
