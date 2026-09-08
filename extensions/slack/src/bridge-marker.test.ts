// Slack tests cover the hcom bridge marker moving out of visible text.
import { describe, expect, it } from "vitest";
import {
  extractHcomBridgeMarker,
  findHcomBridgeMarkerDeep,
  findJobReceiptsDeep,
  HARNESS_RECEIPT_EVENT_TYPE,
  HARNESS_RECEIPT_METADATA_LIMIT,
  HARNESS_RECEIPT_PAYLOAD_KEY,
  HCOM_BRIDGE_MARKER_EVENT_TYPE,
  HCOM_BRIDGE_MARKER_PAYLOAD_KEY,
  stripHcomBridgeHarnessText,
  stripHcomBridgeHarnessTextDeep,
  withHarnessReceiptMetadata,
} from "./bridge-marker.js";
import { buildSlackPostMessagePayload } from "./post-message-payload.js";

const MARKER = "[hcom-bridge-marker:0652b747fef6:35642:52876d49cb1e]";
const JOB_RECEIPT = "job:dag000j-main-01:50bd4a84:terminal";
const JOB_RECEIPT_FINISH = "job:dag000j-main-finish:1a7daf91:terminal";

// The 2026-09-08 incident: a result post trailed by one receipt line per job.
function jobReceiptLines(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `job:dag000j-step-${String(index).padStart(2, "0")}:${index.toString(16).padStart(8, "0")}:terminal`,
  );
}

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

describe("withHarnessReceiptMetadata", () => {
  it("mints metadata for a marker when the send declared none", () => {
    expect(withHarnessReceiptMetadata(undefined, { marker: MARKER })).toEqual({
      event_type: HCOM_BRIDGE_MARKER_EVENT_TYPE,
      event_payload: { [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: MARKER },
    });
  });

  it("mints receipt metadata for job receipts alone, de-duplicated in order", () => {
    expect(
      withHarnessReceiptMetadata(undefined, {
        jobReceipts: [JOB_RECEIPT, JOB_RECEIPT_FINISH, JOB_RECEIPT],
      }),
    ).toEqual({
      event_type: HARNESS_RECEIPT_EVENT_TYPE,
      event_payload: { [HARNESS_RECEIPT_PAYLOAD_KEY]: [JOB_RECEIPT, JOB_RECEIPT_FINISH] },
    });
  });

  it("carries a marker and job receipts in one metadata object", () => {
    expect(
      withHarnessReceiptMetadata(undefined, { marker: MARKER, jobReceipts: [JOB_RECEIPT] }),
    ).toEqual({
      event_type: HCOM_BRIDGE_MARKER_EVENT_TYPE,
      event_payload: {
        [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: MARKER,
        [HARNESS_RECEIPT_PAYLOAD_KEY]: [JOB_RECEIPT],
      },
    });
  });

  it("merges into metadata another feature already declared", () => {
    const existing = {
      event_type: "assistant_thread_context",
      event_payload: { channel_id: "C0AHSKBNDB6" },
    };
    expect(
      withHarnessReceiptMetadata(existing, { marker: MARKER, jobReceipts: [JOB_RECEIPT] }),
    ).toEqual({
      event_type: "assistant_thread_context",
      event_payload: {
        channel_id: "C0AHSKBNDB6",
        [HCOM_BRIDGE_MARKER_PAYLOAD_KEY]: MARKER,
        [HARNESS_RECEIPT_PAYLOAD_KEY]: [JOB_RECEIPT],
      },
    });
  });

  it("carries at most the metadata cap, so Slack never rejects the post", () => {
    const receipts = jobReceiptLines(200);
    const metadata = withHarnessReceiptMetadata(undefined, { jobReceipts: receipts });
    expect(metadata?.event_payload[HARNESS_RECEIPT_PAYLOAD_KEY]).toEqual(
      receipts.slice(0, HARNESS_RECEIPT_METADATA_LIMIT),
    );
  });

  it("returns the metadata it was given when there is nothing to attach", () => {
    const existing = {
      event_type: "assistant_thread_context",
      event_payload: { channel_id: "C0AHSKBNDB6" },
    };
    expect(withHarnessReceiptMetadata(existing, {})).toBe(existing);
    expect(withHarnessReceiptMetadata(undefined, { jobReceipts: [] })).toBeUndefined();
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

  it("strips job terminal receipts from the posted text and blocks", () => {
    const payload = buildSlackPostMessagePayload({
      channelId: "C0AHSKBNDB6",
      text: `Sweep finished.\n\n${JOB_RECEIPT}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `Sweep finished. ${JOB_RECEIPT}` } },
      ],
    });
    expect(payload.text).toBe("Sweep finished.");
    expect(JSON.stringify(payload.blocks)).not.toContain(":terminal");
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

describe("stripHcomBridgeHarnessText job terminal receipts", () => {
  it("drops the 48 receipt lines that trailed the 2026-09-08 result post", () => {
    const text = `Sweep finished, 3 of 4 runs clean.\n\n${jobReceiptLines(48).join("\n")}`;
    expect(stripHcomBridgeHarnessText(text)).toBe("Sweep finished, 3 of 4 runs clean.");
  });

  it("drops a receipt token that landed mid-sentence, with its padding", () => {
    expect(stripHcomBridgeHarnessText(`Sweep ${JOB_RECEIPT} finished.`)).toBe("Sweep finished.");
  });

  it("drops a receipt line dressed up as a bullet, a quote or a code span", () => {
    for (const line of [
      JOB_RECEIPT,
      `- ${JOB_RECEIPT}`,
      `> ${JOB_RECEIPT}`,
      `\`${JOB_RECEIPT}\``,
      `- \`${JOB_RECEIPT}\``,
      `${JOB_RECEIPT} ${JOB_RECEIPT_FINISH}`,
    ]) {
      expect(stripHcomBridgeHarnessText(`Done.\n${line}\nNext run at 14:00.`)).toBe(
        "Done.\n\nNext run at 14:00.",
      );
    }
  });

  it("keeps the prose around the receipts byte-identical", () => {
    const prose = "Sweep finished, 3 of 4 runs clean.\n\nNext run at 14:00.";
    expect(stripHcomBridgeHarnessText(`${prose}\n\n${jobReceiptLines(48).join("\n")}`)).toBe(prose);
  });

  it("returns prose carrying a bare job: substring untouched", () => {
    const text = "  job: done.\n\n\n  The next job: staged.  ";
    expect(stripHcomBridgeHarnessText(text)).toBe(text);
  });

  it("returns a job token that claims no terminal post untouched", () => {
    const text = "job:dag000j-main-01:50bd4a84:queued";
    expect(stripHcomBridgeHarnessText(text)).toBe(text);
  });
});

describe("stripHcomBridgeHarnessTextDeep job terminal receipts", () => {
  it("cleans receipt text nested in Block Kit blocks", () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `Sweep finished.\n\n${JOB_RECEIPT}` } },
      { type: "section", text: { type: "mrkdwn", text: `run 4 ${JOB_RECEIPT_FINISH}` } },
    ];
    const cleaned = stripHcomBridgeHarnessTextDeep(blocks);
    expect(JSON.stringify(cleaned)).not.toContain(":terminal");
    expect(cleaned[0]?.text.text).toBe("Sweep finished.");
    expect(cleaned[1]?.text.text).toBe("run 4");
  });
});

describe("findJobReceiptsDeep", () => {
  it("finds receipts rendered into blocks, in the order they appear", () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `Sweep finished. ${JOB_RECEIPT}` } },
      { type: "section", text: { type: "mrkdwn", text: `run 4 ${JOB_RECEIPT_FINISH}` } },
    ];
    expect(findJobReceiptsDeep(blocks)).toEqual([JOB_RECEIPT, JOB_RECEIPT_FINISH]);
  });

  it("finds every receipt in a plain message", () => {
    expect(findJobReceiptsDeep(`Done.\n${JOB_RECEIPT}\n${JOB_RECEIPT_FINISH}`)).toEqual([
      JOB_RECEIPT,
      JOB_RECEIPT_FINISH,
    ]);
  });

  it("reports nothing for values without a receipt", () => {
    expect(
      findJobReceiptsDeep([{ type: "section", text: { type: "mrkdwn", text: "job: done" } }]),
    ).toEqual([]);
    expect(findJobReceiptsDeep(undefined)).toEqual([]);
  });
});
