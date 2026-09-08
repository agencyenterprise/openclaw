// Slack tests cover the two Slack sends that skip chat.postMessage — an edit
// and a stream frame — dropping hcom bridge bookkeeping before a human sees it.
import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { describe, expect, it, vi } from "vitest";
import { createSlackEditTestClient } from "./blocks.test-helpers.js";
import { appendSlackStream, stopSlackStream, type SlackStreamSession } from "./streaming.js";

const { editSlackMessage } = await import("./actions.js");
const MARKER = "[hcom-bridge-marker:0652b747fef6:35642:52876d49cb1e]";
const JOB_RECEIPT = "job:dag000j-main-01:50bd4a84:terminal";

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
  };
}

function streamerCall(session: SlackStreamSession, method: "append" | "stop") {
  const mock = session.streamer[method] as unknown as { mock: { calls: unknown[][] } };
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected streamer.${method} to be called`);
  }
  return call[0] as Record<string, unknown> | undefined;
}

describe("editSlackMessage", () => {
  it("strips a marker from the edited text", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", `Sweep finished. ${MARKER}`, {
      client: client as never,
    });
    const update = client.chat.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(update.text).toBe("Sweep finished.");
  });

  it("strips a marker from edited blocks", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", "Sweep finished.", {
      client: client as never,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `Sweep. ${MARKER}` } }],
    });
    const update = client.chat.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(update)).not.toContain("hcom-bridge-marker");
  });

  it("leaves an ordinary edit untouched", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", "Sweep finished.", {
      client: client as never,
    });
    const update = client.chat.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(update.text).toBe("Sweep finished.");
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
    const update = client.chat.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(update.text).toBe("Sweep finished.");
  });

  it("strips receipts from edited blocks", async () => {
    const client = createSlackEditTestClient();
    await editSlackMessage("C0AHSKBNDB6", "1788473999.000100", "Sweep finished.", {
      client: client as never,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `Sweep. ${JOB_RECEIPT}` } }],
    });
    const update = client.chat.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(update)).not.toContain(":terminal");
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
});
