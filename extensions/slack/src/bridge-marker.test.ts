// Slack tests cover the hcom bridge marker moving out of visible text.
import { describe, expect, it } from "vitest";
import {
  extractHcomBridgeMarker,
  findHcomBridgeMarkerDeep,
  HCOM_BRIDGE_MARKER_EVENT_TYPE,
  HCOM_BRIDGE_MARKER_PAYLOAD_KEY,
  stripHcomBridgeHarnessText,
  stripHcomBridgeHarnessTextDeep,
  withHcomBridgeMarkerMetadata,
} from "./bridge-marker.js";
import { buildSlackPostMessagePayload } from "./post-message-payload.js";

const MARKER = "[hcom-bridge-marker:0652b747fef6:35642:52876d49cb1e]";

describe("extractHcomBridgeMarker", () => {
  it("removes the marker from the text and reports it", () => {
    const result = extractHcomBridgeMarker(`Sweep finished, 3 of 4 runs clean. ${MARKER}`);
    expect(result.text).toBe("Sweep finished, 3 of 4 runs clean.");
    expect(result.marker).toBe(MARKER);
  });

  it("removes a marker that landed mid-sentence", () => {
    const result = extractHcomBridgeMarker(`Sweep ${MARKER} finished.`);
    expect(result.text).toBe("Sweep finished.");
    expect(result.marker).toBe(MARKER);
  });

  it("leaves text without harness bookkeeping untouched", () => {
    const text = "  Sweep finished.\n\n  Next run at 14:00.  ";
    const result = extractHcomBridgeMarker(text);
    expect(result.text).toBe(text);
    expect(result.marker).toBeUndefined();
  });

  it("reports the first marker when a turn pasted several", () => {
    const second = "[hcom-bridge-marker:0652b747fef6:35643:52876d49cb1e]";
    const result = extractHcomBridgeMarker(`a ${MARKER} b ${second}`);
    expect(result.text).toBe("a b");
    expect(result.marker).toBe(MARKER);
  });

  it("handles empty text", () => {
    expect(extractHcomBridgeMarker("")).toEqual({ text: "" });
  });
});

describe("stripHcomBridgeHarnessText", () => {
  it("drops a machine receipt line that leaked into a post", () => {
    const text = [
      "Worker finished the sweep.",
      'HCOM_BRIDGE_RECEIPT: {"event_id":35642,"delivery":"delivered","marker":"","note":"ok"}',
    ].join("\n");
    expect(stripHcomBridgeHarnessText(text)).toBe("Worker finished the sweep.");
  });

  it("drops a receipt line dressed up as a bullet or quote", () => {
    for (const prefix of ["- ", "> ", "`", "  "]) {
      const text = `Done.\n${prefix}HCOM_BRIDGE_RECEIPT: {"event_id":1}`;
      expect(stripHcomBridgeHarnessText(text)).toBe("Done.");
    }
  });

  it("keeps prose that only names the receipt", () => {
    const text =
      "The bridge reads the HCOM_BRIDGE_RECEIPT: line from my own output, not from Slack.";
    expect(stripHcomBridgeHarnessText(text)).toBe(text);
  });

  it("returns the same reference when there is nothing to strip", () => {
    const text = "Nothing to see here.";
    expect(stripHcomBridgeHarnessText(text)).toBe(text);
  });
});

describe("stripHcomBridgeHarnessTextDeep", () => {
  it("cleans marker text nested in Block Kit blocks", () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `Sweep finished. ${MARKER}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `run 4 ${MARKER}` }] },
    ];
    const cleaned = stripHcomBridgeHarnessTextDeep(blocks);
    expect(JSON.stringify(cleaned)).not.toContain("hcom-bridge-marker");
    expect(cleaned[0]?.text?.text).toBe("Sweep finished.");
  });

  it("returns the same reference when no string carried harness text", () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Sweep finished." } }];
    expect(stripHcomBridgeHarnessTextDeep(blocks)).toBe(blocks);
  });

  it("leaves non-string values alone", () => {
    const value = { count: 3, ok: true, nested: null, when: undefined };
    expect(stripHcomBridgeHarnessTextDeep(value)).toBe(value);
  });
});

describe("findHcomBridgeMarkerDeep", () => {
  it("finds a marker rendered into a block", () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Sweep finished." } },
      { type: "context", elements: [{ type: "mrkdwn", text: `run 4 ${MARKER}` }] },
    ];
    expect(findHcomBridgeMarkerDeep(blocks)).toBe(MARKER);
  });

  it("reports nothing for blocks without a marker", () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Sweep finished." } }];
    expect(findHcomBridgeMarkerDeep(blocks)).toBeUndefined();
    expect(findHcomBridgeMarkerDeep(undefined)).toBeUndefined();
  });
});

describe("withHcomBridgeMarkerMetadata", () => {
  it("mints metadata when the send declared none", () => {
    expect(withHcomBridgeMarkerMetadata(undefined, MARKER)).toEqual({
      event_type: HCOM_BRIDGE_MARKER_EVENT_TYPE,
      event_payload: { [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: MARKER },
    });
  });

  it("merges into metadata another feature already declared", () => {
    const existing = {
      event_type: "assistant_thread_context",
      event_payload: { channel_id: "C0AHSKBNDB6" },
    };
    expect(withHcomBridgeMarkerMetadata(existing, MARKER)).toEqual({
      event_type: "assistant_thread_context",
      event_payload: {
        channel_id: "C0AHSKBNDB6",
        [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: MARKER,
      },
    });
  });
});

describe("buildSlackPostMessagePayload harness guard", () => {
  it("strips harness text from the posted text and blocks", () => {
    const payload = buildSlackPostMessagePayload({
      channelId: "C0AHSKBNDB6",
      text: `Sweep finished. ${MARKER}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `Sweep finished. ${MARKER}` } }],
    });
    expect(payload.text).toBe("Sweep finished.");
    expect(JSON.stringify(payload.blocks)).not.toContain("hcom-bridge-marker");
  });

  it("strips a receipt line that reached a post with no blocks", () => {
    const payload = buildSlackPostMessagePayload({
      channelId: "C0AHSKBNDB6",
      text: 'Done.\nHCOM_BRIDGE_RECEIPT: {"event_id":1,"delivery":"delivered"}',
    });
    expect(payload.text).toBe("Done.");
  });

  it("leaves an ordinary post untouched", () => {
    const payload = buildSlackPostMessagePayload({
      channelId: "C0AHSKBNDB6",
      text: "Sweep finished.",
      threadTs: "1788473062.847669",
    });
    expect(payload).toEqual({
      channel: "C0AHSKBNDB6",
      text: "Sweep finished.",
      thread_ts: "1788473062.847669",
      unfurl_links: false,
    });
  });
});
