// Slack tests cover send moving the hcom bridge marker into message metadata.
import { describe, expect, it } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import {
  HARNESS_RECEIPT_METADATA_LIMIT,
  HARNESS_RECEIPT_PAYLOAD_KEY,
  HCOM_BRIDGE_MARKER_PAYLOAD_KEY,
} from "./bridge-marker.js";

const { sendMessageSlack } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };
const MARKER = "[hcom-bridge-marker:0652b747fef6:35642:52876d49cb1e]";
const JOB_RECEIPT = "job:dag000j-main-01:50bd4a84:terminal";

// The 2026-09-08 incident: a result post trailed by one receipt line per job.
function jobReceiptLines(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `job:dag000j-step-${String(index).padStart(2, "0")}:${index.toString(16).padStart(8, "0")}:terminal`,
  );
}

function postedPayload(
  client: ReturnType<typeof createSlackSendTestClient>,
  callIndex = 0,
): Record<string, unknown> {
  const call = client.chat.postMessage.mock.calls[callIndex];
  if (!call || !call[0] || typeof call[0] !== "object") {
    throw new Error(`Expected chat.postMessage call ${callIndex}`);
  }
  return call[0] as Record<string, unknown>;
}

describe("sendMessageSlack hcom bridge marker", () => {
  it("posts the text without the marker and attaches it as metadata", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C0AHSKBNDB6", `Sweep finished, 3 of 4 runs clean. ${MARKER}`, {
      cfg: SLACK_TEST_CFG as never,
      client: client as never,
      threadTs: "1788473062.847669",
    });
    const payload = postedPayload(client);
    expect(payload.text).toBe("Sweep finished, 3 of 4 runs clean.");
    expect(payload.metadata).toEqual({
      event_type: "hcom_bridge_marker",
      event_payload: { [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: MARKER },
    });
  });

  it("moves a marker rendered inside blocks into metadata too", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C0AHSKBNDB6", "", {
      cfg: SLACK_TEST_CFG as never,
      client: client as never,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `Sweep finished. ${MARKER}` } }],
    });
    const payload = postedPayload(client);
    expect(JSON.stringify(payload.blocks)).not.toContain("hcom-bridge-marker");
    expect(payload.text).not.toContain("hcom-bridge-marker");
    expect(payload.metadata).toEqual({
      event_type: "hcom_bridge_marker",
      event_payload: { [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: MARKER },
    });
  });

  it("drops a machine receipt line that leaked into a post", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack(
      "channel:C0AHSKBNDB6",
      'Worker finished.\nHCOM_BRIDGE_RECEIPT: {"event_id":35642,"delivery":"delivered"}',
      { cfg: SLACK_TEST_CFG as never, client: client as never },
    );
    const payload = postedPayload(client);
    expect(payload.text).toBe("Worker finished.");
    expect(payload.metadata).toBeUndefined();
  });

  it("leaves an ordinary post untouched and attaches no metadata", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C0AHSKBNDB6", "Sweep finished, 3 of 4 runs clean.", {
      cfg: SLACK_TEST_CFG as never,
      client: client as never,
    });
    const payload = postedPayload(client);
    expect(payload.text).toBe("Sweep finished, 3 of 4 runs clean.");
    expect(payload.metadata).toBeUndefined();
  });
});

describe("sendMessageSlack job terminal receipts", () => {
  it("posts the text without the 48 trailing receipts and carries them as metadata", async () => {
    const client = createSlackSendTestClient();
    const receipts = jobReceiptLines(48);
    await sendMessageSlack(
      "channel:C0AHSKBNDB6",
      `Sweep finished, 3 of 4 runs clean.\n\n${receipts.join("\n")}`,
      { cfg: SLACK_TEST_CFG as never, client: client as never },
    );
    const payload = postedPayload(client);
    expect(payload.text).toBe("Sweep finished, 3 of 4 runs clean.");
    expect(payload.metadata).toEqual({
      event_type: "harness_receipt",
      event_payload: { [HARNESS_RECEIPT_PAYLOAD_KEY]: receipts },
    });
  });

  it("moves receipts rendered inside blocks into metadata too", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C0AHSKBNDB6", "", {
      cfg: SLACK_TEST_CFG as never,
      client: client as never,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `Sweep finished. ${JOB_RECEIPT}` } },
      ],
    });
    const payload = postedPayload(client);
    expect(JSON.stringify(payload.blocks)).not.toContain(":terminal");
    expect(payload.text).not.toContain(":terminal");
    expect(payload.metadata).toEqual({
      event_type: "harness_receipt",
      event_payload: { [HARNESS_RECEIPT_PAYLOAD_KEY]: [JOB_RECEIPT] },
    });
  });

  it("carries a bridge marker and job receipts in one metadata object", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C0AHSKBNDB6", `Sweep finished. ${MARKER}\n\n${JOB_RECEIPT}`, {
      cfg: SLACK_TEST_CFG as never,
      client: client as never,
    });
    const payload = postedPayload(client);
    expect(payload.text).toBe("Sweep finished.");
    expect(payload.metadata).toEqual({
      event_type: "hcom_bridge_marker",
      event_payload: {
        [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: MARKER,
        [HARNESS_RECEIPT_PAYLOAD_KEY]: [JOB_RECEIPT],
      },
    });
  });

  it("strips all 200 receipts from a big DAG post but carries only the cap", async () => {
    const client = createSlackSendTestClient();
    const receipts = jobReceiptLines(200);
    await sendMessageSlack(
      "channel:C0AHSKBNDB6",
      `Sweep finished, 3 of 4 runs clean.\n\n${receipts.join("\n")}`,
      { cfg: SLACK_TEST_CFG as never, client: client as never },
    );
    const payload = postedPayload(client);
    expect(payload.text).toBe("Sweep finished, 3 of 4 runs clean.");
    expect(payload.metadata).toEqual({
      event_type: "harness_receipt",
      event_payload: {
        [HARNESS_RECEIPT_PAYLOAD_KEY]: receipts.slice(0, HARNESS_RECEIPT_METADATA_LIMIT),
      },
    });
  });

  it("attaches no metadata to prose that only says job:", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C0AHSKBNDB6", "job: sweep finished, 3 of 4 runs clean.", {
      cfg: SLACK_TEST_CFG as never,
      client: client as never,
    });
    const payload = postedPayload(client);
    expect(payload.text).toBe("job: sweep finished, 3 of 4 runs clean.");
    expect(payload.metadata).toBeUndefined();
  });
});
