import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASK_LEDGER_FILE } from "../ask-ledger/ledger.js";
import type { LaneCliResult, LaneCliRunner } from "./lane-cli.js";
import { type LaneThread, resolveLanesForCommand } from "./lane-lookup.js";

/** The live case: the go message is a reply inside the thread the lane governs. */
const CHANNEL = "C0AHSKBNDB6";
const ROOT_TS = "1788473062.847669";
const GO_TS = "1788507056.648349";
const GO_PERMALINK = `https://agencyenterprise.slack.com/archives/${CHANNEL}/p1788507056648349`;
const ROOT_PERMALINK = `https://agencyenterprise.slack.com/archives/${CHANNEL}/p1788473062847669`;
const OTHER_CHANNEL = "C0BOTHER99";
const OTHER_THREAD_TS = "1788400000.111111";
const COMMAND = "bash scripts/runpod_spawn.sh --gpu a100";
const THREAD: LaneThread = { channel: CHANNEL, threadTs: ROOT_TS };

let workspaceDir = "";

/** Stands in for `lane.py list --state active`; a lookup asks nothing else. */
function stubRunner(laneIds: string[]): LaneCliRunner {
  return async (args): Promise<LaneCliResult> => {
    if (args[0] !== "list") {
      throw new Error(`unexpected lane.py call: ${args.join(" ")}`);
    }
    return { code: 0, stdout: JSON.stringify(laneIds.map((lane_id) => ({ lane_id }))), stderr: "" };
  };
}

type LaneFields = {
  origin_permalink?: string;
  origin?: { channel?: string; thread_ts?: string };
};

async function writeLane(laneId: string, fields: LaneFields): Promise<void> {
  const laneDir = path.join(workspaceDir, "state", "lanes");
  await fs.mkdir(laneDir, { recursive: true });
  await fs.writeFile(
    path.join(laneDir, `${laneId}.json`),
    JSON.stringify({ lane_id: laneId, state: "active", ...fields }),
  );
}

function askLedgerPath(): string {
  return path.join(workspaceDir, "state", ASK_LEDGER_FILE);
}

async function writeAskLedger(lines: Record<string, unknown>[]): Promise<void> {
  await fs.mkdir(path.dirname(askLedgerPath()), { recursive: true });
  await fs.writeFile(askLedgerPath(), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/** The line the ask-ledger hook writes for a direct ask. */
function openAsk(channel: string, ts: string, threadTs: string): Record<string, unknown> {
  return {
    id: `${channel}:${ts}`,
    channel,
    thread_ts: threadTs,
    user: "U03EH553GBE",
    text: "Yes, do it",
    received_at: "2026-09-04T07:31:02.990Z",
    source_message_id: `default:${channel}:${ts}`,
    status: "open",
  };
}

/** A later line for the same ask carries only its status, so it must not erase the thread. */
function answeredAsk(channel: string, ts: string): Record<string, unknown> {
  return {
    id: `${channel}:${ts}`,
    status: "answered",
    answered_at: "2026-09-04T08:19:40.704Z",
    answer_ts: "1788507091.550619",
  };
}

function resolve(laneIds: string[], thread: LaneThread = THREAD, command = COMMAND) {
  return resolveLanesForCommand({ command, thread, workspaceDir, run: stubRunner(laneIds) });
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-lookup-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("lane-guard lane lookup", () => {
  it("takes the lane an operator named inline over anything the thread says", async () => {
    await writeLane("other-thread", { origin_permalink: ROOT_PERMALINK });

    expect(await resolve(["other-thread"], THREAD, `${COMMAND}  # lane:kv-harvest`)).toEqual([
      "kv-harvest",
    ]);
  });

  it("matches on origin.thread_ts when the permalink names another message", async () => {
    await writeLane("egd001a-graduate-run", {
      origin_permalink: GO_PERMALINK,
      origin: { channel: CHANNEL, thread_ts: ROOT_TS },
    });

    expect(await resolve(["egd001a-graduate-run"])).toEqual(["egd001a-graduate-run"]);
  });

  it("matches on the thread_ts query a newer permalink carries", async () => {
    await writeLane("egd001a-graduate-run", {
      origin_permalink: `${GO_PERMALINK}?thread_ts=${ROOT_TS}&cid=${CHANNEL}`,
    });

    expect(await resolve(["egd001a-graduate-run"])).toEqual(["egd001a-graduate-run"]);
  });

  it("reads the channel from the cid query when the permalink has no archives path", async () => {
    await writeLane("egd001a-graduate-run", {
      origin_permalink: `https://agencyenterprise.slack.com/?thread_ts=${ROOT_TS}&cid=${CHANNEL}`,
    });

    expect(await resolve(["egd001a-graduate-run"])).toEqual(["egd001a-graduate-run"]);
  });

  it("matches a permalink that points at the thread root", async () => {
    await writeLane("kv-harvest", { origin_permalink: ROOT_PERMALINK });

    expect(await resolve(["kv-harvest"])).toEqual(["kv-harvest"]);
  });

  it("matches through the ask ledger when the go message is a reply in the thread", async () => {
    await writeLane("egd001a-graduate-run", { origin_permalink: GO_PERMALINK });
    await writeAskLedger([openAsk(CHANNEL, GO_TS, ROOT_TS), answeredAsk(CHANNEL, GO_TS)]);

    expect(await resolve(["egd001a-graduate-run"])).toEqual(["egd001a-graduate-run"]);
  });

  // Live on 2026-09-07: a parent lane, its run, and an older lane all covered one
  // thread. Which one authorizes the work is the caller's question, not this one's.
  it("returns every lane covering the thread, in the order lane.py listed them", async () => {
    await writeLane("egd-000-34294319", {
      origin_permalink: `${GO_PERMALINK}?thread_ts=${ROOT_TS}&cid=${CHANNEL}`,
    });
    await writeLane("egd001a-graduate", { origin_permalink: GO_PERMALINK });
    await writeLane("egd001a-graduate-run", {
      origin_permalink: GO_PERMALINK,
      origin: { channel: CHANNEL, thread_ts: ROOT_TS },
    });
    await writeLane("other-thread", { origin_permalink: ROOT_PERMALINK.replace(CHANNEL, "C0ZZZ") });
    await writeAskLedger([openAsk(CHANNEL, GO_TS, ROOT_TS)]);

    expect(
      await resolve([
        "egd-000-34294319",
        "egd001a-graduate",
        "egd001a-graduate-run",
        "other-thread",
      ]),
    ).toEqual(["egd-000-34294319", "egd001a-graduate", "egd001a-graduate-run"]);
  });

  it("does not match a lane whose go message belongs to another thread", async () => {
    await writeLane("other-thread", { origin_permalink: GO_PERMALINK });
    await writeAskLedger([openAsk(CHANNEL, GO_TS, OTHER_THREAD_TS)]);

    expect(await resolve(["other-thread"])).toEqual([]);
  });

  it("does not match the same thread ts in another channel", async () => {
    await writeLane("other-channel", {
      origin_permalink: `https://agencyenterprise.slack.com/archives/${OTHER_CHANNEL}/p1788473062847669`,
      origin: { channel: OTHER_CHANNEL, thread_ts: ROOT_TS },
    });

    expect(await resolve(["other-channel"])).toEqual([]);
  });

  it("does not accept a channel or a ts that merely contains this thread's", async () => {
    await writeLane("neighbour-channel", {
      origin_permalink: `https://agencyenterprise.slack.com/archives/${CHANNEL}X/p1788473062847669`,
    });
    await writeLane("longer-ts", {
      origin_permalink: `https://agencyenterprise.slack.com/archives/${CHANNEL}/p17884730628476699`,
    });

    expect(await resolve(["neighbour-channel", "longer-ts"])).toEqual([]);
  });

  it("does not match a lane record with no channel to check", async () => {
    await writeLane("no-channel", { origin_permalink: "https://example.test/p1788473062847669" });

    expect(await resolve(["no-channel"])).toEqual([]);
  });

  it("resolves no lane for a turn without a Slack thread", async () => {
    await writeLane("kv-harvest", { origin_permalink: ROOT_PERMALINK });

    expect(await resolve(["kv-harvest"], { channel: CHANNEL })).toEqual([]);
  });

  it("does not read the ask ledger when every covering lane names the thread outright", async () => {
    await writeLane("egd001a-graduate-run", {
      origin_permalink: GO_PERMALINK,
      origin: { channel: CHANNEL, thread_ts: ROOT_TS },
    });
    // A directory where the ledger belongs makes any read of it fail.
    await fs.mkdir(askLedgerPath(), { recursive: true });

    expect(await resolve(["egd001a-graduate-run"])).toEqual(["egd001a-graduate-run"]);
  });

  it("reads the ask ledger once however many lanes are left to check", async () => {
    await writeLane("first", { origin_permalink: GO_PERMALINK });
    await writeLane("second", {
      origin_permalink: `https://agencyenterprise.slack.com/archives/${CHANNEL}/p1788400000111111`,
    });
    await writeAskLedger([openAsk(CHANNEL, GO_TS, ROOT_TS)]);
    const readFile = vi.spyOn(fs, "readFile");

    expect(await resolve(["second", "first"])).toEqual(["first"]);
    const ledgerReads = readFile.mock.calls.filter(
      ([target]) => typeof target === "string" && target.endsWith(ASK_LEDGER_FILE),
    );
    expect(ledgerReads).toHaveLength(1);
  });

  it("lets an unreadable ask ledger fail instead of answering 'no lane'", async () => {
    await writeLane("egd001a-graduate-run", { origin_permalink: GO_PERMALINK });
    await fs.mkdir(askLedgerPath(), { recursive: true });

    await expect(resolve(["egd001a-graduate-run"])).rejects.toThrow();
  });
});

/**
 * Evidence that contradicts itself authorizes nothing. Resolving a conflict by
 * precedence would manufacture a channel/thread pair nobody ever wrote down.
 */
describe("lane-guard lane lookup on contradictory evidence", () => {
  const OTHER = "C0BOTHER99";

  it("does not match when origin.channel and the permalink's channel disagree", async () => {
    await writeLane("two-channels", {
      origin_permalink: `https://agencyenterprise.slack.com/archives/${OTHER}/p1788473062847669`,
      origin: { channel: CHANNEL, thread_ts: ROOT_TS },
    });

    expect(await resolve(["two-channels"])).toEqual([]);
  });

  it("does not match when the permalink's channel and its cid query disagree", async () => {
    await writeLane("cid-conflict", {
      origin_permalink: `${GO_PERMALINK}?thread_ts=${ROOT_TS}&cid=${OTHER}`,
    });

    expect(await resolve(["cid-conflict"])).toEqual([]);
  });

  it("does not match when origin.thread_ts and the permalink's thread_ts disagree", async () => {
    await writeLane("two-threads", {
      origin_permalink: `${GO_PERMALINK}?thread_ts=${OTHER_THREAD_TS}&cid=${CHANNEL}`,
      origin: { channel: CHANNEL, thread_ts: ROOT_TS },
    });

    expect(await resolve(["two-threads"])).toEqual([]);
  });

  it("does not match a permalink carrying more than one archives segment", async () => {
    await writeLane("two-archives", {
      origin_permalink: `https://example.invalid/archives/${CHANNEL}/p1788473062847669/junk/archives/${OTHER}/p1788400000111111`,
      origin: { channel: CHANNEL },
    });

    expect(await resolve(["two-archives"])).toEqual([]);
  });

  it("does not match a permalink with anything after the message ts", async () => {
    await writeLane("trailing-junk", {
      origin_permalink: `${ROOT_PERMALINK}/junk`,
      origin: { channel: CHANNEL },
    });

    expect(await resolve(["trailing-junk"])).toEqual([]);
  });

  it("does not match a thread ts that is not a canonical Slack ts", async () => {
    await writeLane("short-ts", {
      origin_permalink: GO_PERMALINK,
      origin: { channel: CHANNEL, thread_ts: "1.2" },
    });

    expect(await resolve(["short-ts"], { channel: CHANNEL, threadTs: "1.2" })).toEqual([]);
  });

  it("does not match a thread ts with more seconds digits than a Slack ts has", async () => {
    const overlong = "178847306299999.847669";
    await writeLane("overlong-ts", {
      origin_permalink: GO_PERMALINK,
      origin: { channel: CHANNEL, thread_ts: overlong },
    });

    expect(await resolve(["overlong-ts"], { channel: CHANNEL, threadTs: overlong })).toEqual([]);
  });
});

/**
 * The ask ledger is shared with Python crons, so a second writer can contradict
 * the first. One ask id that names two threads answers for neither.
 */
describe("lane-guard lane lookup against a contradictory ask ledger", () => {
  // The later line is the forgery: last-writer-wins would move the lane into the
  // thread the second writer named, which is the thread we resolve here.
  it("resolves nothing for an ask id recorded with two different threads", async () => {
    await writeLane("egd001a-graduate-run", { origin_permalink: GO_PERMALINK });
    await writeAskLedger([
      openAsk(CHANNEL, GO_TS, ROOT_TS),
      openAsk(CHANNEL, GO_TS, OTHER_THREAD_TS),
    ]);

    expect(
      await resolve(["egd001a-graduate-run"], { channel: CHANNEL, threadTs: OTHER_THREAD_TS }),
    ).toEqual([]);
  });

  it("resolves nothing for an ask whose channel is not the one in its id", async () => {
    await writeLane("egd001a-graduate-run", { origin_permalink: GO_PERMALINK });
    await writeAskLedger([{ ...openAsk(CHANNEL, GO_TS, ROOT_TS), channel: "C0BOTHER99" }]);

    expect(await resolve(["egd001a-graduate-run"])).toEqual([]);
  });

  it("still resolves an ask the ledger repeats identically", async () => {
    await writeLane("egd001a-graduate-run", { origin_permalink: GO_PERMALINK });
    await writeAskLedger([
      openAsk(CHANNEL, GO_TS, ROOT_TS),
      openAsk(CHANNEL, GO_TS, ROOT_TS),
      answeredAsk(CHANNEL, GO_TS),
    ]);

    expect(await resolve(["egd001a-graduate-run"])).toEqual(["egd001a-graduate-run"]);
  });
});
