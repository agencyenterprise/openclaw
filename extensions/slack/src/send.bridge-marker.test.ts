// Slack tests cover send moving the hcom bridge marker into message metadata.
import { describe, expect, it } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import { HCOM_BRIDGE_MARKER_PAYLOAD_KEY } from "./bridge-marker.js";

const { sendMessageSlack } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };
const MARKER = "[hcom-bridge-marker:0652b747fef6:35642:52876d49cb1e]";

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
