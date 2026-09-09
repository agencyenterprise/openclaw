// Slack tests cover the two Slack sends that skip chat.postMessage — an edit
// and a stream frame. Both drop hcom bridge bookkeeping before a human sees it
// and re-attach it as message metadata, which humans never see. A send that
// only stripped would take the bridge's proof away with the visible token: the
// token belongs to the turn doing the writing, and neither chat.update (which
// retains only the edited post's own metadata) nor chat.stopStream (whose
// message never had any) carries it otherwise.
import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { describe, expect, it, vi } from "vitest";
import { createSlackEditTestClient } from "./blocks.test-helpers.js";
import { appendSlackStream, stopSlackStream, type SlackStreamSession } from "./streaming.js";

const { editSlackMessage } = await import("./actions.js");
const MARKER = "[hcom-bridge-marker:0652b747fef6:35642:52876d49cb1e]";
const JOB_RECEIPT = "job:dag000j-main-01:50bd4a84:terminal";
const OTHER_JOB_RECEIPT = "job:dag000j-main-02:50bd4a85:terminal";

type SlackEditTestClient = ReturnType<typeof createSlackEditTestClient>;

function makeSession(): SlackStreamSession {
  return {
    streamer: {
      append: vi.fn(async () => null),
      stop: vi.fn(async () => ({})),
    } as unknown as ChatStreamer,
    channel: "C0AHSKBNDB6",
    threadTs: "1788473062.847669",
    stopped: false,
    delivered: false,
    pendingText: "",
    harness: { jobReceipts: [] },
  };
}

function streamerCall(session: SlackStreamSession, method: "append" | "stop", index = 0) {
  const mock = session.streamer[method] as unknown as { mock: { calls: unknown[][] } };
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected streamer.${method} call #${String(index)}`);
  }
  return call[0] as Record<string, unknown> | undefined;
}

/** The chat.update payload an edit sent. */
function editUpdate(client: SlackEditTestClient): Record<string, unknown> {
  const update = client.chat.update.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (!update) {
    throw new Error("Expected chat.update to be called");
  }
  return update;
}

/**
 * The given payloads with their metadata removed, serialized. Metadata is the
 * one part of a Slack message a human never sees, so it is the only part a
 * harness token may appear in.
 */
function visiblePayload(...payloads: readonly (Record<string, unknown> | undefined)[]): string {
  return JSON.stringify(
    payloads.map((payload) =>
      Object.fromEntries(Object.entries(payload ?? {}).filter(([key]) => key !== "metadata")),
    ),
  );
}

describe("editSlackMessage", () => {
  it("strips a marker from the edited text", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", `Sweep finished. ${MARKER}`, {
      client: client as never,
    });
    expect(editUpdate(client).text).toBe("Sweep finished.");
  });

  it("strips a marker from edited blocks", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", "Sweep finished.", {
      client: client as never,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `Sweep. ${MARKER}` } }],
    });
    const update = editUpdate(client);
    expect(visiblePayload(update)).not.toContain("hcom-bridge-marker");
    expect(update.metadata).toEqual({
      event_type: "hcom_bridge_marker",
      event_payload: { hcom_bridge_marker: MARKER },
    });
  });

  it("leaves an ordinary edit untouched", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", "Sweep finished.", {
      client: client as never,
    });
    expect(editUpdate(client).text).toBe("Sweep finished.");
  });

  it("re-attaches a marker the edited message carried as metadata", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", `Sweep finished. ${MARKER}`, {
      client: client as never,
    });
    expect(editUpdate(client).metadata).toEqual({
      event_type: "hcom_bridge_marker",
      event_payload: { hcom_bridge_marker: MARKER },
    });
  });

  it("merges a marker into the metadata the edited message already carried", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", `Sweep finished. ${MARKER}`, {
      client: client as never,
      metadata: {
        event_type: "assistant_thread_context",
        event_payload: { channel_id: "C0AHSKBNDB6", team_id: "T099" },
      },
    });
    // chat.update replaces metadata wholesale, so attaching the proof has to
    // carry the message's own payload across instead of erasing it.
    expect(editUpdate(client).metadata).toEqual({
      event_type: "assistant_thread_context",
      event_payload: {
        channel_id: "C0AHSKBNDB6",
        team_id: "T099",
        hcom_bridge_marker: MARKER,
      },
    });
  });

  it("keeps the metadata it was handed for an edit with no harness token", async () => {
    const client = createSlackEditTestClient();
    const metadata = {
      event_type: "assistant_thread_context",
      event_payload: { channel_id: "C0AHSKBNDB6" },
    };
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", "Sweep finished.", {
      client: client as never,
      metadata,
    });
    expect(editUpdate(client).metadata).toEqual(metadata);
  });

  it("sends no metadata field for an edit that carries no harness token", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", "Sweep finished.", {
      client: client as never,
    });
    // An empty metadata object would still erase what the original post
    // carried, so the field has to be absent, not undefined.
    expect(Object.hasOwn(editUpdate(client), "metadata")).toBe(false);
  });
});

describe("slack stream frames", () => {
  it("strips a marker from appended text and from the pending buffer", async () => {
    const session = makeSession();
    await appendSlackStream({ session, text: `Sweep finished. ${MARKER}` });
    expect(streamerCall(session, "append")?.markdown_text).toBe("Sweep finished.");
    expect(session.pendingText).toBe("Sweep finished.");
  });

  it("strips a marker from the final stream frame", async () => {
    const session = makeSession();
    await stopSlackStream({ session, text: `Sweep finished. ${MARKER}` });
    expect(streamerCall(session, "stop")?.markdown_text).toBe("Sweep finished.");
  });

  it("leaves an ordinary final frame untouched", async () => {
    const session = makeSession();
    await stopSlackStream({ session, text: "Sweep finished." });
    expect(streamerCall(session, "stop")?.markdown_text).toBe("Sweep finished.");
  });

  it("finalizes with an early frame's marker in metadata and never in visible text", async () => {
    const session = makeSession();
    await appendSlackStream({ session, text: `Sweeping. ${MARKER}` });
    await appendSlackStream({ session, text: " Still sweeping." });
    await stopSlackStream({ session, text: " Done." });

    // chat.appendStream takes no metadata, so a marker an early frame carried
    // has to survive on the session until chat.stopStream can carry it.
    expect(streamerCall(session, "stop")?.metadata).toEqual({
      event_type: "hcom_bridge_marker",
      event_payload: { hcom_bridge_marker: MARKER },
    });
    expect(
      visiblePayload(
        streamerCall(session, "append", 0),
        streamerCall(session, "append", 1),
        streamerCall(session, "stop"),
      ),
    ).not.toContain("hcom-bridge-marker");
  });

  it("finalizes with no metadata when no frame carried a harness token", async () => {
    const session = makeSession();
    await appendSlackStream({ session, text: "Sweeping." });
    await stopSlackStream({ session, text: " Done." });
    expect(Object.hasOwn(streamerCall(session, "stop") ?? {}, "metadata")).toBe(false);
  });
});

describe("editSlackMessage job terminal receipts", () => {
  it("strips receipts from the edited text", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage(
      "C0AHSKBNDB6",
      "1788473999.000100",
      `Sweep finished.\n\n${JOB_RECEIPT}`,
      { client: client as never },
    );
    expect(editUpdate(client).text).toBe("Sweep finished.");
  });

  it("strips receipts from edited blocks", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", "Sweep finished.", {
      client: client as never,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `Sweep. ${JOB_RECEIPT}` } }],
    });
    const update = editUpdate(client);
    expect(visiblePayload(update)).not.toContain(":terminal");
    expect(update.metadata).toEqual({
      event_type: "harness_receipt",
      event_payload: { harness_receipts: [JOB_RECEIPT] },
    });
  });
});

describe("slack stream frames job terminal receipts", () => {
  it("strips receipts from appended text and from the pending buffer", async () => {
    const session = makeSession();
    await appendSlackStream({ session, text: `Sweep finished. ${JOB_RECEIPT}` });
    expect(streamerCall(session, "append")?.markdown_text).toBe("Sweep finished.");
    expect(session.pendingText).toBe("Sweep finished.");
  });

  it("strips receipts from the final stream frame", async () => {
    const session = makeSession();
    await stopSlackStream({ session, text: `Sweep finished.\n\n${JOB_RECEIPT}` });
    expect(streamerCall(session, "stop")?.markdown_text).toBe("Sweep finished.");
  });

  it("collects receipts across frames into the finalized metadata once each", async () => {
    const session = makeSession();
    await appendSlackStream({ session, text: `Run one done. ${JOB_RECEIPT}` });
    await appendSlackStream({ session, text: `Run one again. ${JOB_RECEIPT}` });
    await stopSlackStream({ session, text: `Run two done. ${OTHER_JOB_RECEIPT}` });

    expect(streamerCall(session, "stop")?.metadata).toEqual({
      event_type: "harness_receipt",
      event_payload: { harness_receipts: [JOB_RECEIPT, OTHER_JOB_RECEIPT] },
    });
  });
});
