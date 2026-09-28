// Shared suite: Responses tool calls left active by output_item.done are reconciled
// from the authoritative response.completed output, or rejected when they cannot be.
import { describe, expect, it } from "vitest";
import {
  type CapturedStreamEvent,
  createAzureResponsesModel,
  createResponsesAssistantOutput,
  type OpenAIResponsesOutput,
  streamChunks,
} from "./openai-transport-stream.test-harness.js";

type ProcessResponsesStream = (
  openaiStream: AsyncIterable<unknown>,
  output: OpenAIResponsesOutput,
  stream: { push(event: unknown): void },
  model: ReturnType<typeof createAzureResponsesModel>,
) => Promise<unknown>;

type ToolCallEndEvent = CapturedStreamEvent & {
  toolCall?: { id?: string; name?: string; arguments?: unknown };
};

const READ_ARGUMENTS = '{"path":"paper.pdf","pages":"5-6"}';

const reasoningItem = { type: "reasoning", id: "rs_1", summary: [] };
const readCall = { type: "function_call", id: "fc_read", call_id: "call_read", name: "read" };
const execCall = { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec" };

function reasoningEvents(outputIndex: number) {
  return [
    { type: "response.output_item.added", output_index: outputIndex, item: reasoningItem },
    { type: "response.output_item.done", output_index: outputIndex, item: reasoningItem },
  ];
}

function completed(output: unknown[], status = "completed") {
  return { type: "response.completed", response: { id: "resp_1", status, output } };
}

export function describeTerminalToolCallReconciliation(
  label: string,
  processResponsesStream: ProcessResponsesStream,
) {
  const run = async (chunks: unknown[]) => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);
    const events: ToolCallEndEvent[] = [];
    const result = processResponsesStream(
      streamChunks(chunks),
      output,
      { push: (event) => events.push(event as ToolCallEndEvent) },
      model,
    );
    return { output, events, result };
  };
  const toolCallEnds = (events: ToolCallEndEvent[]) =>
    events
      .filter((event) => event.type === "toolcall_end")
      .map((event) => [event.contentIndex, event.toolCall?.id, event.toolCall?.arguments]);

  describe(`${label}: Responses terminal tool-call reconciliation`, () => {
    it("completes a call whose output_item.done never arrived from response.completed", async () => {
      const { output, events, result } = await run([
        ...reasoningEvents(0),
        { type: "response.output_item.added", output_index: 1, item: { ...readCall, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          item_id: "fc_read",
          delta: READ_ARGUMENTS,
        },
        completed([
          reasoningItem,
          { ...readCall, arguments: READ_ARGUMENTS, status: "completed" },
        ]),
      ]);
      await result;

      expect(output.stopReason).toBe("toolUse");
      expect(output.content.at(-1)).toMatchObject({
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "paper.pdf", pages: "5-6" },
      });
      expect(toolCallEnds(events)).toEqual([
        [1, "call_read|fc_read", { path: "paper.pdf", pages: "5-6" }],
      ]);
    });

    it("reconciles a call whose output_item.done did not route to it (identity mismatch)", async () => {
      const { output, events, result } = await run([
        ...reasoningEvents(0),
        { type: "response.output_item.added", output_index: 1, item: { ...readCall, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          item_id: "fc_read",
          delta: '{"path":"paper',
        },
        {
          type: "response.output_item.done",
          output_index: 2,
          item: { ...readCall, id: "fc_read_rotated", arguments: READ_ARGUMENTS },
        },
        completed([reasoningItem, { ...readCall, arguments: READ_ARGUMENTS }]),
      ]);
      await result;

      expect(output.stopReason).toBe("toolUse");
      expect(toolCallEnds(events)).toEqual([
        [1, "call_read|fc_read", { path: "paper.pdf", pages: "5-6" }],
      ]);
      expect(output.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
    });

    it("reconciles a call deferred for unreliable arguments with the terminal arguments", async () => {
      const { output, events, result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...readCall, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          output_index: 7,
          item_id: "fc_unknown",
          delta: '{"path":"wrong.pdf"}',
        },
        { type: "response.output_item.done", output_index: 0, item: { ...readCall, arguments: "" } },
        completed([{ ...readCall, arguments: READ_ARGUMENTS }]),
      ]);
      await result;

      expect(output.stopReason).toBe("toolUse");
      expect(toolCallEnds(events)).toEqual([
        [0, "call_read|fc_read", { path: "paper.pdf", pages: "5-6" }],
      ]);
    });

    it("reconciles only the unfinished call when an earlier call completed normally", async () => {
      const { output, events, result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...execCall, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_exec",
          delta: '{"command":"ls"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { ...execCall, arguments: '{"command":"ls"}' },
        },
        { type: "response.output_item.added", output_index: 1, item: { ...readCall, arguments: "" } },
        completed([
          { ...execCall, arguments: '{"command":"ls"}' },
          { ...readCall, arguments: READ_ARGUMENTS },
        ]),
      ]);
      await result;

      expect(toolCallEnds(events)).toEqual([
        [0, "call_exec|fc_exec", { command: "ls" }],
        [1, "call_read|fc_read", { path: "paper.pdf", pages: "5-6" }],
      ]);
      expect(output.content.filter((block) => block.type === "toolCall")).toHaveLength(2);
    });

    it("still rejects an active call that response.completed does not contain", async () => {
      const { events, result } = await run([
        ...reasoningEvents(0),
        { type: "response.output_item.added", output_index: 1, item: { ...readCall, arguments: "" } },
        completed([reasoningItem]),
      ]);

      await expect(result).rejects.toThrow("Responses stream completed with unresolved tool calls");
      expect(toolCallEnds(events)).toEqual([]);
    });

    it("rejects a terminal call that was never streamed while another call is active", async () => {
      const { events, result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...readCall, arguments: "" } },
        completed([
          { ...readCall, arguments: READ_ARGUMENTS },
          { ...execCall, arguments: '{"command":"rm -rf /tmp/x"}' },
        ]),
      ]);

      await expect(result).rejects.toThrow(
        "Responses stream completed with an unmatched terminal tool call",
      );
      expect(toolCallEnds(events)).toEqual([]);
    });

    it("rejects parallel terminal calls whose identities do not match the streamed calls", async () => {
      const first = { type: "function_call", id: "fc_a", name: "read" };
      const second = { type: "function_call", id: "fc_b", name: "read" };
      const { events, result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...first, arguments: "" } },
        { type: "response.output_item.added", output_index: 1, item: { ...second, arguments: "" } },
        completed([
          { ...second, arguments: '{"path":"b"}' },
          { ...first, arguments: '{"path":"a"}' },
        ]),
      ]);

      await expect(result).rejects.toThrow(
        "Responses stream completed with an unmatched terminal tool call",
      );
      expect(toolCallEnds(events)).toEqual([]);
    });

    it("does not confuse a completed call's item id with another call's call id", async () => {
      const anonymous = { type: "function_call", id: "shared", name: "exec" };
      const { output, events, result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...anonymous, arguments: "" } },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { ...anonymous, arguments: '{"command":"ls"}' },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...readCall, call_id: "shared", arguments: "" },
        },
        completed([
          { ...anonymous, arguments: '{"command":"ls"}' },
          { ...readCall, call_id: "shared", arguments: READ_ARGUMENTS },
        ]),
      ]);
      await result;

      expect(output.stopReason).toBe("toolUse");
      expect(toolCallEnds(events).at(-1)).toEqual([
        1,
        "shared|fc_read",
        { path: "paper.pdf", pages: "5-6" },
      ]);
    });

    it("still rejects an active call when response.completed carries no output", async () => {
      const { events, result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...readCall, arguments: "" } },
        completed([]),
      ]);

      await expect(result).rejects.toThrow("Responses stream completed with unresolved tool calls");
      expect(toolCallEnds(events)).toEqual([]);
    });

    it.each([["incomplete"], [null], [7]])(
      "rejects a terminal call whose status is %s",
      async (status) => {
        const { events, result } = await run([
          { type: "response.output_item.added", output_index: 0, item: { ...readCall, arguments: "" } },
          completed([{ ...readCall, arguments: READ_ARGUMENTS, status }]),
        ]);

        await expect(result).rejects.toThrow(
          "Responses stream completed with an incomplete terminal tool call",
        );
        expect(toolCallEnds(events)).toEqual([]);
      },
    );

    it("rejects terminal arguments that are not complete JSON", async () => {
      const { events, result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...readCall, arguments: "" } },
        completed([{ ...readCall, arguments: '{"path":"pap' }]),
      ]);

      await expect(result).rejects.toThrow(
        "Responses stream completed tool call with invalid JSON arguments",
      );
      expect(toolCallEnds(events)).toEqual([]);
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("rejects a terminal call with %s arguments, even after a streamed buffer", async (_, args) => {
      const { events, result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...readCall, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_read",
          delta: READ_ARGUMENTS,
        },
        completed([{ ...readCall, arguments: args }]),
      ]);

      await expect(result).rejects.toThrow(
        "Responses stream completed tool call without terminal arguments",
      );
      expect(toolCallEnds(events)).toEqual([]);
    });

    it("rejects a terminal call that renames the streamed function", async () => {
      const { result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...readCall, arguments: "" } },
        completed([{ ...readCall, name: "exec", arguments: READ_ARGUMENTS }]),
      ]);

      await expect(result).rejects.toThrow(
        "Responses stream changed tool-call function name from read to exec",
      );
    });

    it("leaves a normal streamed tool call unchanged", async () => {
      const { output, events, result } = await run([
        ...reasoningEvents(0),
        { type: "response.output_item.added", output_index: 1, item: { ...readCall, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          item_id: "fc_read",
          delta: READ_ARGUMENTS,
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 1,
          item_id: "fc_read",
          arguments: READ_ARGUMENTS,
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: { ...readCall, arguments: READ_ARGUMENTS },
        },
        completed([reasoningItem, { ...readCall, arguments: READ_ARGUMENTS }]),
      ]);
      await result;

      expect(output.stopReason).toBe("toolUse");
      expect(events.map((event) => event.type)).toEqual([
        "thinking_start",
        "thinking_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
      ]);
      expect(output.content[1]).toEqual({
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "paper.pdf", pages: "5-6" },
        partialJson: READ_ARGUMENTS,
      });
    });

    it("leaves a normal text-only response unchanged", async () => {
      const message = {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      };
      const { output, result } = await run([
        { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
        { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "done" },
        { type: "response.output_item.done", output_index: 0, item: message },
        completed([message]),
      ]);
      await result;

      expect(output.stopReason).toBe("stop");
      expect(output.content).toMatchObject([{ type: "text", text: "done" }]);
    });
  });
}
