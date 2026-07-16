import { Type } from "typebox";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
  silent: Type.Optional(
    Type.Boolean({
      description:
        "Skip the visible-status requirement for an intentionally private deferred-completion wait.",
    }),
  ),
});

export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  onYield?: (message: string) => Promise<void> | void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  hasRepliedRef?: { value: boolean };
}): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    description:
      "End your current turn. Use after spawning subagents to receive their results as the next message.",
    parameters: SessionsYieldToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readStringParam(params, "message") || "Turn yielded.";
      const silent = params.silent === true;
      if (!opts?.sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      if (!opts?.onYield) {
        return jsonResult({ status: "error", error: "Yield not supported in this context" });
      }
      if (
        opts.sourceReplyDeliveryMode === "message_tool_only" &&
        opts.hasRepliedRef?.value !== true &&
        !silent
      ) {
        return jsonResult({
          status: "error",
          error:
            "Visible status required before sessions_yield in this Slack/message-tool-only turn. " +
            'First use the message tool with action="send" to post a brief status to the current thread, then call sessions_yield again.',
        });
      }
      await opts.onYield(message);
      return jsonResult({ status: "yielded", message });
    },
  };
}
