import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASK_LEDGER_FILE } from "../ask-ledger/ledger.js";
import type { LaneCliResult } from "../lane-guard/lane-cli.js";
import { createLaneAuthorizer } from "./lane-authorization.js";

const THREAD = { channel: "C0A3C98HS48", threadTs: "1786591963.108609" };
const PERMALINK = "https://agencyenterprise.slack.com/archives/C0A3C98HS48/p1786591963108609";
const OTHER_PERMALINK = "https://agencyenterprise.slack.com/archives/C0OTHER/p1700000000000001";
/** The go message of a lane can be a reply inside the thread, not its root. */
const REPLY_TS = "1786592100.220110";
const REPLY_PERMALINK = "https://agencyenterprise.slack.com/archives/C0A3C98HS48/p1786592100220110";
const RUNPOD_PROMISE = "Next: I'll run bash scripts/runpod_spawn.sh --gpu a100.";

let workspaceDir = "";
let calls: string[][] = [];

type FakeLaneCliOptions = {
  activeLanes: string[];
  allow: boolean;
  /** Per-lane `allowed_actions`, for a thread that several lanes cover. */
  laneActions?: Record<string, string[]>;
  /** Lane whose `check` exits neither 0 nor 2, i.e. a check that could not run at all. */
  checkFailsFor?: string;
  /** Lanes whose check refuses with `over_ceiling`, even for an action they allow. */
  overCeilingLanes?: string[];
};

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

type CheckAnswer = { allowed: boolean; reason: string; code?: string };

/** `lane.py check --json`: each lane's own allowed_actions when a case sets them, plus its refusal code. */
function checkAnswer(options: FakeLaneCliOptions, laneId: string, action: string): CheckAnswer {
  if (options.overCeilingLanes?.includes(laneId)) {
    return { allowed: false, reason: `${laneId} is over the ceiling`, code: "over_ceiling" };
  }
  if (!options.laneActions) {
    return options.allow
      ? { allowed: true, reason: "lane allows it" }
      : { allowed: false, reason: "action not in allowed_actions", code: "action_not_allowed" };
  }
  return (options.laneActions[laneId] ?? []).includes(action)
    ? { allowed: true, reason: "lane allows it" }
    : {
        allowed: false,
        reason: `${action} is not in ${laneId} allowed_actions`,
        code: "action_not_allowed",
      };
}

/** Stands in for `python3 scripts/lane.py`: same argv, exit codes and JSON shapes. */
function fakeLaneCli(options: FakeLaneCliOptions) {
  return () =>
    async (args: string[]): Promise<LaneCliResult> => {
      calls.push(args);
      if (args[0] === "list") {
        const rows = options.activeLanes.map((laneId) => ({ lane_id: laneId }));
        return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      if (args[0] === "check") {
        if (options.checkFailsFor && args[1] === options.checkFailsFor) {
          return { code: 1, stdout: "", stderr: "Traceback: lane.py exploded" };
        }
        const answer = checkAnswer(options, args[1] ?? "", readFlag(args, "--action") ?? "");
        return { code: answer.allowed ? 0 : 2, stdout: JSON.stringify(answer), stderr: "" };
      }
      throw new Error(`unexpected lane.py call: ${args.join(" ")}`);
    };
}

type LaneFields = {
  origin_permalink?: string;
  origin?: { channel?: string; thread_ts?: string };
};

async function writeLaneRecord(laneId: string, fields: LaneFields): Promise<void> {
  const laneDir = path.join(workspaceDir, "state", "lanes");
  await fs.mkdir(laneDir, { recursive: true });
  await fs.writeFile(
    path.join(laneDir, `${laneId}.json`),
    JSON.stringify({ lane_id: laneId, ...fields }),
    "utf-8",
  );
}

/** The ask-ledger line that ties a reply's ts to the thread it was written in. */
async function writeAskLedger(channel: string, ts: string, threadTs: string): Promise<void> {
  const ledgerPath = path.join(workspaceDir, "state", ASK_LEDGER_FILE);
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const line = {
    id: `${channel}:${ts}`,
    channel,
    thread_ts: threadTs,
    user: "U03EH553GBE",
    text: "Yes, do it",
    status: "open",
  };
  await fs.writeFile(ledgerPath, `${JSON.stringify(line)}\n`, "utf-8");
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "turn-gate-lane-"));
  calls = [];
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("turn-gate lane authorization", () => {
  it("authorizes when an active lane covers the thread and lane.py allows the class", async () => {
    await writeLaneRecord("dag000i-frame", { origin_permalink: PERMALINK });
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["dag000i-frame"], allow: true }),
    );

    const result = await authorize({
      workspaceDir,
      thread: THREAD,
      promiseText: RUNPOD_PROMISE,
    });

    // The reason is lane.py's own, unprefixed: its real text already names the action.
    expect(result).toEqual({
      laneId: "dag000i-frame",
      authorized: true,
      reason: "lane allows it",
    });
    expect(calls.at(-1)).toEqual([
      "check",
      "dag000i-frame",
      "--action",
      "runpod",
      "--amount",
      "5",
      "--json",
    ]);
  });

  it("refuses work it cannot classify, even inside a lane that covers the thread", async () => {
    await writeLaneRecord("dag000i-frame", { origin_permalink: PERMALINK });
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["dag000i-frame"], allow: true }),
    );

    const result = await authorize({
      workspaceDir,
      thread: THREAD,
      promiseText: "Next: I'll start the harvest now.",
    });

    expect(result.authorized).toBe(false);
    expect(result.laneId).toBe("dag000i-frame");
    expect(result.reason).toContain("names no command this gate can classify");
    expect(calls.some((call) => call[0] === "check")).toBe(false);
  });

  it("ignores a lane id the model wrote into its own promise", async () => {
    await writeLaneRecord("someone-elses-lane", { origin_permalink: OTHER_PERMALINK });
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["someone-elses-lane"], allow: true }),
    );

    const result = await authorize({
      workspaceDir,
      thread: THREAD,
      promiseText: `${RUNPOD_PROMISE} # lane:someone-elses-lane`,
    });

    expect(result).toEqual({ authorized: false, reason: "no active lane covers this thread" });
    expect(calls.some((call) => call[0] === "check")).toBe(false);
  });

  it("does not accept a channel or thread that merely contains this one", async () => {
    await writeLaneRecord("neighbour-lane", {
      origin_permalink:
        "https://agencyenterprise.slack.com/archives/C0A3C98HS48X/p1786591963108609",
    });
    await writeLaneRecord("longer-ts-lane", {
      origin_permalink:
        "https://agencyenterprise.slack.com/archives/C0A3C98HS48/p17865919631086099",
    });
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["neighbour-lane", "longer-ts-lane"], allow: true }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result).toEqual({ authorized: false, reason: "no active lane covers this thread" });
  });

  it("refuses when no active lane covers the thread", async () => {
    await writeLaneRecord("other-lane", { origin_permalink: OTHER_PERMALINK });
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["other-lane"], allow: true }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result).toEqual({ authorized: false, reason: "no active lane covers this thread" });
  });

  it("reports the lane it found when that lane refuses the action", async () => {
    await writeLaneRecord("dag000i-frame", { origin_permalink: PERMALINK });
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["dag000i-frame"], allow: false }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result).toEqual({
      laneId: "dag000i-frame",
      authorized: false,
      reason: "action not in allowed_actions",
    });
  });

  it("never reserves budget and never creates a lane", async () => {
    await writeLaneRecord("dag000i-frame", { origin_permalink: PERMALINK });
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["dag000i-frame"], allow: true }),
    );

    await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(calls.map((call) => call[0])).toEqual(["list", "check"]);
  });
});

/** The three spellings of the same fact, because three writers write it. */
describe("turn-gate lane authorization across origin forms", () => {
  it("finds the lane through origin.thread_ts", async () => {
    await writeLaneRecord("dag000i-frame", {
      origin_permalink: REPLY_PERMALINK,
      origin: { channel: THREAD.channel, thread_ts: THREAD.threadTs },
    });
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["dag000i-frame"], allow: true }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result.laneId).toBe("dag000i-frame");
    expect(result.authorized).toBe(true);
  });

  it("finds the lane through the thread_ts query of a permalink", async () => {
    await writeLaneRecord("dag000i-frame", {
      origin_permalink: `${REPLY_PERMALINK}?thread_ts=${THREAD.threadTs}&cid=${THREAD.channel}`,
    });
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["dag000i-frame"], allow: true }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result.laneId).toBe("dag000i-frame");
    expect(result.authorized).toBe(true);
  });

  it("finds the lane through the ask ledger when the go message is a reply", async () => {
    await writeLaneRecord("dag000i-frame", { origin_permalink: REPLY_PERMALINK });
    await writeAskLedger(THREAD.channel, REPLY_TS, THREAD.threadTs);
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["dag000i-frame"], allow: true }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result.laneId).toBe("dag000i-frame");
    expect(result.authorized).toBe(true);
  });

  it("refuses a lane whose go message is a reply in another thread", async () => {
    await writeLaneRecord("other-lane", { origin_permalink: REPLY_PERMALINK });
    await writeAskLedger(THREAD.channel, REPLY_TS, "1700000000.000001");
    const authorize = createLaneAuthorizer(
      fakeLaneCli({ activeLanes: ["other-lane"], allow: true }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result).toEqual({ authorized: false, reason: "no active lane covers this thread" });
  });
});

/** Several active lanes can cover one thread; only one of them may allow the work. */
describe("turn-gate lane authorization among several covering lanes", () => {
  const COVERING_LANES = ["egd-000-34294319", "egd001a-graduate-run"];

  async function writeCoveringLanes(): Promise<void> {
    for (const laneId of COVERING_LANES) {
      await writeLaneRecord(laneId, { origin_permalink: PERMALINK });
    }
  }

  it("authorizes through the lane that allows the class, not the first one", async () => {
    await writeCoveringLanes();
    const authorize = createLaneAuthorizer(
      fakeLaneCli({
        activeLanes: COVERING_LANES,
        allow: true,
        laneActions: {
          "egd-000-34294319": ["analysis", "api_calls"],
          "egd001a-graduate-run": ["analysis", "runpod"],
        },
      }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result.laneId).toBe("egd001a-graduate-run");
    expect(result.authorized).toBe(true);
  });

  it("refuses without asking the next lane when a covering lane is over its ceiling", async () => {
    await writeCoveringLanes();
    const authorize = createLaneAuthorizer(
      fakeLaneCli({
        activeLanes: COVERING_LANES,
        allow: true,
        laneActions: {
          "egd-000-34294319": ["runpod"],
          "egd001a-graduate-run": ["runpod"],
        },
        overCeilingLanes: ["egd-000-34294319"],
      }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result.authorized).toBe(false);
    expect(result.laneId).toBe("egd-000-34294319");
    expect(result.reason).toContain("over the ceiling");
    expect(calls.filter((call) => call[0] === "check").map((call) => call[1])).toEqual([
      "egd-000-34294319",
    ]);
  });

  it("refuses without asking the next lane when a check could not be run", async () => {
    await writeCoveringLanes();
    const authorize = createLaneAuthorizer(
      fakeLaneCli({
        activeLanes: COVERING_LANES,
        allow: true,
        laneActions: {
          "egd-000-34294319": ["runpod"],
          "egd001a-graduate-run": ["runpod"],
        },
        checkFailsFor: "egd-000-34294319",
      }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result.authorized).toBe(false);
    expect(result.laneId).toBe("egd-000-34294319");
    expect(result.reason).toContain("could not be run");
    expect(calls.filter((call) => call[0] === "check").map((call) => call[1])).toEqual([
      "egd-000-34294319",
    ]);
  });

  it("refuses and names the lanes it tried when none of them allows the class", async () => {
    await writeCoveringLanes();
    const authorize = createLaneAuthorizer(
      fakeLaneCli({
        activeLanes: COVERING_LANES,
        allow: true,
        laneActions: { "egd-000-34294319": ["analysis"], "egd001a-graduate-run": ["analysis"] },
      }),
    );

    const result = await authorize({ workspaceDir, thread: THREAD, promiseText: RUNPOD_PROMISE });

    expect(result.authorized).toBe(false);
    expect(result.laneId).toBe("egd-000-34294319");
    for (const laneId of COVERING_LANES) {
      expect(result.reason).toContain(laneId);
    }
  });
});
