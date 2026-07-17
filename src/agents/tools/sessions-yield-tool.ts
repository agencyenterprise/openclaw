/**
 * sessions_yield built-in tool.
 *
 * Ends the current turn after subagent spawning so completion events can resume the session later.
 */
import { Type } from "typebox";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
  silent: Type.Optional(
    Type.Boolean({
      description: "Allow an intentionally private wait without posting an interim status.",
    }),
  ),
});

/** Creates the sessions_yield tool for runtimes that support yield callbacks. */
export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  onYield?: (message: string) => Promise<void> | void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  hasRepliedRef?: { value: boolean };
}): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    description: "End turn after subagent spawn; results arrive next message.",
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
            "Visible status required before sessions_yield in this message-tool-only turn. " +
            "Send a brief source reply with the message tool, then call sessions_yield again, or set silent=true for intentionally private work.",
        });
      }
      // The runtime owns the actual pause/end-turn behavior; this tool records intent.
      await opts.onYield(message);
      return jsonResult({ status: "yielded", message });
    },
  };
}
