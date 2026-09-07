import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginHookToolContext } from "../../../plugins/hook-types.js";
import { ASK_LEDGER_FILE } from "../ask-ledger/ledger.js";
import {
  createLaneGuard,
  DEFAULT_LANE_GUARD_CONFIG,
  LANE_GUARD_AUDIT_FILE,
  LANE_GUARD_BLOCK_REASON,
  type LaneGuardAuditRecord,
  type LaneGuardConfig,
} from "./guard.js";
import type { LaneCliResult, LaneCliRunner } from "./lane-cli.js";

const SESSION = "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609";
/** The heartbeat runner wakes the same thread, so its lane still resolves. */
const HEARTBEAT_SESSION = `${SESSION}:heartbeat`;
const CRON_SESSION = "agent:main:cron:nightly-harvest:run:20260903T100000";
const PERMALINK = "https://ae.slack.com/archives/C0A3C98HS48/p1786591963108609";
const RUNPOD_COMMAND = "bash scripts/runpod_spawn.sh --gpu a100";
const CHAINED_COMMAND = "runpodctl create pod && codex exec --model gpt-5.6-sol";
const PUBLISH_COMMAND = "gh release create v1.2.0 --notes-file notes.md";
const CLOCK = new Date("2026-09-03T10:00:00.000Z");

/** Enforce every kind, which is what the pre-existing spending tests assume. */
const ENFORCE_ALL: Partial<LaneGuardConfig> = {
  enforce: { heartbeat: true, cron: true, human: true },
};

let workspaceDir = "";

type StubOptions = {
  activeLanes?: string[];
  deniedActions?: string[];
  /** Per-lane `allowed_actions`, for a thread that several lanes cover. */
  laneActions?: Record<string, string[]>;
  /** Lane whose `check` exits neither 0 nor 2, i.e. a check that could not run at all. */
  checkFailsFor?: string;
  /** Lanes whose check refuses with `over_ceiling`, even for an action they allow. */
  overCeilingLanes?: string[];
  /** How an exit-2 refusal is spelled, for the shapes that carry no usable code. */
  refusalStyle?: "no-code" | "empty-stdout" | "malformed-stdout" | "unknown-code";
  /** Subcommand that exits 0 with output no one can parse. */
  unreadableAnswerFor?: "check" | "reserve";
  listCode?: number;
  /** Action class whose `reserve` call fails, matched on the note lane-guard sends. */
  reserveFailsFor?: string;
};

type LaneCliStub = {
  run: LaneCliRunner;
  calls: string[][];
  commandsFor: (subcommand: string) => string[][];
};

function result(code: number, stdout = "", stderr = ""): LaneCliResult {
  return { code, stdout, stderr };
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

type CheckAnswer = { allowed: boolean; reason: string; code?: string };

/**
 * Exit 2 is not only a lane denial: argparse refuses a bad `--action` or
 * `--amount` with the same status, printing usage to stderr and nothing to stdout.
 */
function refuseWithoutUsableCode(
  style: NonNullable<StubOptions["refusalStyle"]>,
  reason: string,
): LaneCliResult {
  if (style === "empty-stdout") {
    return result(2, "", "usage: lane.py check [-h] --action ACTION [--amount AMOUNT]");
  }
  if (style === "malformed-stdout") {
    return result(2, "{lane: not json", "");
  }
  return result(
    2,
    JSON.stringify({
      allowed: false,
      reason,
      code: style === "unknown-code" ? "teapot" : undefined,
    }),
  );
}

/** `lane.py check --json`: each lane's own allowed_actions when a case sets them, plus its refusal code. */
function checkAnswer(options: StubOptions, laneId: string, action: string): CheckAnswer {
  if (options.overCeilingLanes?.includes(laneId)) {
    return { allowed: false, reason: `${laneId} is over the ceiling`, code: "over_ceiling" };
  }
  if (options.laneActions) {
    return (options.laneActions[laneId] ?? []).includes(action)
      ? { allowed: true, reason: `lane allows ${action}` }
      : {
          allowed: false,
          reason: `${action} is not in ${laneId} allowed_actions`,
          code: "action_not_allowed",
        };
  }
  return (options.deniedActions ?? []).includes(action)
    ? { allowed: false, reason: `${action} is over the ceiling`, code: "over_ceiling" }
    : { allowed: true, reason: `lane allows ${action}` };
}

/** Stands in for `python3 scripts/lane.py`: same exit codes, same JSON shapes. */
function stubLaneCli(options: StubOptions = {}): LaneCliStub {
  const calls: string[][] = [];
  const run: LaneCliRunner = async (args) => {
    calls.push(args);
    if (args[0] === "list") {
      const code = options.listCode ?? 0;
      if (code !== 0) {
        return result(code, "", "lane: state dir is unreadable");
      }
      const rows = (options.activeLanes ?? []).map((lane_id) => ({ lane_id }));
      return result(0, JSON.stringify(rows));
    }
    if (args[0] === "check") {
      if (options.checkFailsFor && args[1] === options.checkFailsFor) {
        return result(1, "", "Traceback: lane.py exploded");
      }
      if (options.unreadableAnswerFor === "check") {
        return result(0, "lane: allowed");
      }
      const { code, ...answer } = checkAnswer(
        options,
        args[1] ?? "",
        readFlag(args, "--action") ?? "",
      );
      return answer.allowed || !options.refusalStyle
        ? result(answer.allowed ? 0 : 2, JSON.stringify({ ...answer, code }))
        : refuseWithoutUsableCode(options.refusalStyle, answer.reason);
    }
    if (args[0] === "reserve") {
      if (options.unreadableAnswerFor === "reserve") {
        return result(0, "reserved");
      }
      const note = readFlag(args, "--note") ?? "";
      return options.reserveFailsFor && note.endsWith(options.reserveFailsFor)
        ? result(2, "", "lane: $5.00 would bring committed spend over the ceiling")
        : result(0, JSON.stringify({ lane_id: args[1] }));
    }
    if (args[0] === "release") {
      return result(0, JSON.stringify({ lane_id: args[1] }));
    }
    throw new Error(`unexpected lane.py call: ${args.join(" ")}`);
  };
  return {
    run,
    calls,
    commandsFor: (subcommand) => calls.filter((args) => args[0] === subcommand),
  };
}

function guardWithRunner(run: LaneCliRunner, overrides: Partial<LaneGuardConfig> = {}) {
  return createLaneGuard({
    resolveWorkspaceDir: () => workspaceDir,
    resolveConfig: () => ({ ...DEFAULT_LANE_GUARD_CONFIG, ...overrides }),
    createLaneCli: () => run,
    now: () => CLOCK,
  });
}

function guardWith(stub: LaneCliStub, overrides: Partial<LaneGuardConfig> = {}) {
  return guardWithRunner(stub.run, overrides);
}

function execEvent(command: string, toolName = "exec") {
  return { toolName, params: { command } };
}

function toolCtx(sessionKey = SESSION): PluginHookToolContext {
  return { toolName: "exec", sessionKey };
}

/** A CLI turn has no session key at all. */
const UNKEYED_CTX: PluginHookToolContext = { toolName: "exec" };

async function writeLaneRecord(laneId: string, originPermalink: string): Promise<void> {
  const laneDir = path.join(workspaceDir, "state", "lanes");
  await fs.mkdir(laneDir, { recursive: true });
  await fs.writeFile(
    path.join(laneDir, `${laneId}.json`),
    JSON.stringify({ lane_id: laneId, state: "active", origin_permalink: originPermalink }),
  );
}

async function readAudit(): Promise<LaneGuardAuditRecord[]> {
  const auditPath = path.join(workspaceDir, "state", LANE_GUARD_AUDIT_FILE);
  const content = await fs.readFile(auditPath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LaneGuardAuditRecord);
}

async function auditExists(): Promise<boolean> {
  return fs
    .stat(path.join(workspaceDir, "state", LANE_GUARD_AUDIT_FILE))
    .then(() => true)
    .catch(() => false);
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lane-guard-"));
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("lane-guard before_tool_call guard", () => {
  it("ignores tools that are not exec or bash", async () => {
    const stub = stubLaneCli();
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(await guard(execEvent(RUNPOD_COMMAND, "write"), toolCtx())).toBeUndefined();
    expect(stub.calls).toHaveLength(0);
    expect(await auditExists()).toBe(false);
  });

  it("passes an unclassified command without calling lane.py or auditing it", async () => {
    const stub = stubLaneCli();
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(await guard(execEvent("git status --short"), toolCtx())).toBeUndefined();
    expect(stub.calls).toHaveLength(0);
    expect(await auditExists()).toBe(false);
  });

  it("runs and reserves the estimate when the thread's lane allows the action", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"] });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("check")[0]).toEqual([
      "check",
      "kv-harvest",
      "--action",
      "runpod",
      "--amount",
      "5",
      "--json",
    ]);
    expect(stub.commandsFor("reserve")[0]).toEqual([
      "reserve",
      "kv-harvest",
      "5",
      "--worker",
      SESSION,
      "--note",
      "lane-guard estimate for runpod",
      "--json",
    ]);
    expect(await readAudit()).toEqual([
      {
        ts: CLOCK.toISOString(),
        session: SESSION,
        kind: "human",
        thread: "C0A3C98HS48:1786591963.108609",
        class: "runpod",
        lane: "kv-harvest",
        decision: "allowed",
        mode: "enforce",
        reason: "lane allows runpod",
      },
    ]);
  });

  it("books nothing for a zero-cost class but still requires the lane", async () => {
    await writeLaneRecord("spark-probe", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["spark-probe"] });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(await guard(execEvent("./scripts/dgx --check"), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("check")).toHaveLength(1);
    expect(stub.commandsFor("reserve")).toHaveLength(0);
  });

  it("authorizes and books every class a chained command charges", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"] });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(await guard(execEvent(CHAINED_COMMAND), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("check").map((args) => readFlag(args, "--action"))).toEqual([
      "runpod",
      "api_calls",
    ]);
    expect(stub.commandsFor("reserve").map((args) => args[2])).toEqual(["5", "1"]);
    expect((await readAudit())[0]?.class).toBe("runpod+api_calls");
  });

  it("cancels a chained command when the lane forbids one of its classes, booking nothing", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"], deniedActions: ["api_calls"] });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect((await guard(execEvent(CHAINED_COMMAND), toolCtx()))?.block).toBe(true);
    expect(stub.commandsFor("reserve")).toHaveLength(0);
    expect((await readAudit())[0]?.reason).toContain("api_calls is over the ceiling");
  });

  it("cancels with an actionable reason when the lane denies the spend", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"], deniedActions: ["runpod"] });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    expect(blocked?.blockReason).toContain(LANE_GUARD_BLOCK_REASON);
    expect(blocked?.blockReason).toContain("over the ceiling");
    expect(stub.commandsFor("reserve")).toHaveLength(0);
    const [record] = await readAudit();
    expect(record?.decision).toBe("denied");
    expect(record?.lane).toBe("kv-harvest");
  });

  it("cancels when no active lane covers the thread", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    expect(stub.commandsFor("check")).toHaveLength(0);
    const [record] = await readAudit();
    expect(record?.lane).toBe("");
    expect(record?.decision).toBe("denied");
    expect(record?.reason).toContain("C0A3C98HS48:1786591963.108609");
  });

  it("cancels when an active lane belongs to another thread", async () => {
    await writeLaneRecord("other-thread", "https://ae.slack.com/archives/C0A3C98HS48/p1700000000");
    const stub = stubLaneCli({ activeLanes: ["other-thread"] });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect((await guard(execEvent(RUNPOD_COMMAND), toolCtx()))?.block).toBe(true);
    expect(stub.commandsFor("check")).toHaveLength(0);
  });

  it("takes the lane an operator named inline instead of listing lanes", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(
      await guard(execEvent(`${RUNPOD_COMMAND}  # lane:kv-harvest`), toolCtx()),
    ).toBeUndefined();
    expect(stub.commandsFor("list")).toHaveLength(0);
    expect(stub.commandsFor("check")[0]?.[1]).toBe("kv-harvest");
  });

  it("treats a broken lane.py check as a refusal, never as permission", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"] });
    const failing: LaneCliRunner = async (args) =>
      args[0] === "check" ? result(1, "", "Traceback: boom") : stub.run(args);
    const guard = guardWithRunner(failing, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    expect((await readAudit())[0]?.reason).toContain("Traceback: boom");
  });

  it("treats a failed lane listing as a refusal", async () => {
    const stub = stubLaneCli({ listCode: 1 });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    expect((await readAudit())[0]?.reason).toContain("lane lookup failed");
  });

  it("cancels when the reserve loses the race, because the check no longer holds", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"], reserveFailsFor: "runpod" });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    const [record] = await readAudit();
    expect(record?.decision).toBe("denied");
    expect(record?.reason).toContain("reserve refused");
  });

  it("gives back what it already booked when a later class cannot be reserved", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"], reserveFailsFor: "api_calls" });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect((await guard(execEvent(CHAINED_COMMAND), toolCtx()))?.block).toBe(true);
    expect(stub.commandsFor("release")[0]).toEqual([
      "release",
      "kv-harvest",
      "5",
      "--worker",
      SESSION,
      "--note",
      "lane-guard rollback for runpod",
      "--json",
    ]);
  });

  it("writes exactly one audit line per classified command", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"] });
    const guard = guardWith(stub, ENFORCE_ALL);

    await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    await guard(execEvent("git status"), toolCtx());
    await guard(execEvent("hcom codex --prompt review"), toolCtx());

    const records = await readAudit();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.class)).toEqual(["runpod", "api_calls"]);
  });

  it("names the session as the worker and marks an unknown thread", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub, ENFORCE_ALL);

    await guard(execEvent(RUNPOD_COMMAND), UNKEYED_CTX);
    const [record] = await readAudit();
    expect(record?.session).toBe("unknown");
    expect(record?.thread).toBe("unknown");
  });

  it("does not let a failed audit write decide the tool call", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"] });
    const guard = guardWith(stub, ENFORCE_ALL);
    // A directory where the JSONL file belongs makes every append fail.
    await fs.mkdir(path.join(workspaceDir, "state", LANE_GUARD_AUDIT_FILE), { recursive: true });

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("reserve")).toHaveLength(1);
  });
});

describe("lane-guard enforcement per session kind", () => {
  it("enforces unattended work and audits a human thread by default", () => {
    expect(DEFAULT_LANE_GUARD_CONFIG.enforce).toEqual({
      heartbeat: true,
      cron: true,
      human: false,
    });
  });

  it.each([
    ["heartbeat", HEARTBEAT_SESSION],
    ["cron", CRON_SESSION],
    ["human", SESSION],
  ])("records the %s kind of the session on the audit line", async (kind, sessionKey) => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub);

    await guard(execEvent(RUNPOD_COMMAND), toolCtx(sessionKey));
    expect((await readAudit())[0]?.kind).toBe(kind);
  });

  it("cancels a heartbeat command with no lane, because heartbeat is enforced", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx(HEARTBEAT_SESSION));
    expect(blocked?.block).toBe(true);
    expect(blocked?.blockReason).toContain(LANE_GUARD_BLOCK_REASON);
    const [record] = await readAudit();
    expect(record?.decision).toBe("denied");
    expect(record?.mode).toBe("enforce");
  });

  it("cancels a cron command the lane denies, because cron is enforced", async () => {
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"], deniedActions: ["runpod"] });
    const guard = guardWith(stub);

    const blocked = await guard(
      execEvent(`${RUNPOD_COMMAND}  # lane:kv-harvest`),
      toolCtx(CRON_SESSION),
    );
    expect(blocked?.block).toBe(true);
    expect((await readAudit())[0]?.mode).toBe("enforce");
  });

  it("cancels a heartbeat command whose reserve fails", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"], reserveFailsFor: "runpod" });
    const guard = guardWith(stub);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx(HEARTBEAT_SESSION));
    expect(blocked?.block).toBe(true);
    expect((await readAudit())[0]?.reason).toContain("reserve refused");
  });

  it("reserves for an enforced kind, exactly as the lane allowed it", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"] });
    const guard = guardWith(stub);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx(HEARTBEAT_SESSION))).toBeUndefined();
    expect(stub.commandsFor("reserve")).toHaveLength(1);
    const [record] = await readAudit();
    expect(record?.kind).toBe("heartbeat");
    expect(record?.mode).toBe("enforce");
    expect(record?.decision).toBe("allowed");
  });

  it("only audits a human thread with no lane, and never cancels it", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx())).toBeUndefined();
    const [record] = await readAudit();
    expect(record?.decision).toBe("dry_run");
    expect(record?.mode).toBe("audit");
    expect(record?.class).toBe("runpod");
  });

  it("never spends a human thread's budget while it is only auditing", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"] });
    const guard = guardWith(stub);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("check")).toHaveLength(1);
    expect(stub.commandsFor("reserve")).toHaveLength(0);
    const [record] = await readAudit();
    expect(record?.decision).toBe("allowed");
    expect(record?.reason).toContain("audit mode reserved nothing");
  });

  it("audits instead of cancelling a heartbeat once enforce.heartbeat is off", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub, { enforce: { heartbeat: false, cron: true, human: false } });

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx(HEARTBEAT_SESSION))).toBeUndefined();
    const [record] = await readAudit();
    expect(record?.mode).toBe("audit");
    expect(record?.decision).toBe("dry_run");
  });
});

describe("lane-guard alwaysCancel classes", () => {
  it("gates publishing outward by default", () => {
    expect(DEFAULT_LANE_GUARD_CONFIG.alwaysCancel).toEqual(["publish_external"]);
  });

  it("cancels an unauthorized publish in a human thread, where nothing else is enforced", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub);

    const blocked = await guard(execEvent(PUBLISH_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    const [record] = await readAudit();
    expect(record?.kind).toBe("human");
    expect(record?.mode).toBe("audit");
    expect(record?.decision).toBe("denied");
    expect(record?.reason).toContain("publish_external is always gated");
  });

  it("cancels a publish the lane refuses, even in an audited kind", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({
      activeLanes: ["kv-harvest"],
      deniedActions: ["publish_external"],
    });
    const guard = guardWith(stub);

    expect((await guard(execEvent(PUBLISH_COMMAND), toolCtx()))?.block).toBe(true);
    expect((await readAudit())[0]?.decision).toBe("denied");
  });

  it("lets a publish through when the lane explicitly allows the action", async () => {
    await writeLaneRecord("release-lane", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["release-lane"] });
    const guard = guardWith(stub);

    expect(await guard(execEvent(PUBLISH_COMMAND), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("check")[0]?.[3]).toBe("publish_external");
    const [record] = await readAudit();
    expect(record?.decision).toBe("allowed");
    expect(record?.lane).toBe("release-lane");
  });

  it("cancels a publish in an enforced kind exactly as any other refusal does", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub);

    const blocked = await guard(execEvent(PUBLISH_COMMAND), toolCtx(CRON_SESSION));
    expect(blocked?.block).toBe(true);
    expect((await readAudit())[0]?.mode).toBe("enforce");
  });

  it("still asks about the publish class when an earlier class is refused", async () => {
    await writeLaneRecord("release-lane", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["release-lane"], deniedActions: ["runpod"] });
    const guard = guardWith(stub);

    // The lane does allow publishing, so the always-cancel gate has its explicit
    // allow. Only the refused runpod half is left, and this kind audits that.
    expect(
      await guard(execEvent(`runpodctl create pod && ${PUBLISH_COMMAND}`), toolCtx()),
    ).toBeUndefined();
    expect(stub.commandsFor("check").map((args) => args[3])).toEqual([
      "runpod",
      "publish_external",
    ]);
    const [record] = await readAudit();
    expect(record?.class).toBe("runpod+publish_external");
    expect(record?.decision).toBe("dry_run");
  });

  it("cancels a chained publish the lane refuses alongside the rest", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({
      activeLanes: ["kv-harvest"],
      deniedActions: ["runpod", "publish_external"],
    });
    const guard = guardWith(stub);

    const blocked = await guard(execEvent(`runpodctl create pod && ${PUBLISH_COMMAND}`), toolCtx());
    expect(blocked?.block).toBe(true);
    expect((await readAudit())[0]?.reason).toContain("publish_external is always gated");
  });

  it("goes back to auditing a publish once the class is off the alwaysCancel list", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub, { alwaysCancel: [] });

    expect(await guard(execEvent(PUBLISH_COMMAND), toolCtx())).toBeUndefined();
    expect((await readAudit())[0]?.decision).toBe("dry_run");
  });

  it("leaves a spending class alone in an audited kind, since only publishing is listed", async () => {
    const stub = stubLaneCli({ activeLanes: [] });
    const guard = guardWith(stub);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx())).toBeUndefined();
    expect((await readAudit())[0]?.reason).not.toContain("always gated");
  });
});

/** The lane record shapes a thread's lane can arrive in, end to end through the guard. */
describe("lane-guard lane matching in a thread", () => {
  const GO_CHANNEL = "C0AHSKBNDB6";
  const GO_ROOT_TS = "1788473062.847669";
  const GO_TS = "1788507056.648349";
  const GO_PERMALINK = `https://agencyenterprise.slack.com/archives/${GO_CHANNEL}/p1788507056648349`;
  const GO_HEARTBEAT_SESSION = `agent:main:slack:channel:c0ahskbndb6:thread:${GO_ROOT_TS}:heartbeat`;

  async function writeAskLedger(lines: Record<string, unknown>[]): Promise<void> {
    const ledgerPath = path.join(workspaceDir, "state", ASK_LEDGER_FILE);
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(ledgerPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }

  function openAsk(threadTs: string): Record<string, unknown> {
    return {
      id: `${GO_CHANNEL}:${GO_TS}`,
      channel: GO_CHANNEL,
      thread_ts: threadTs,
      user: "U03EH553GBE",
      text: "Yes, do it",
      received_at: "2026-09-04T07:31:02.990Z",
      source_message_id: `default:${GO_CHANNEL}:${GO_TS}`,
      status: "open",
    };
  }

  // The 2026-09-07 incident: the lane's permalink is the go reply, not the thread
  // root, so the enforced heartbeat lost the lane that authorized its own work.
  it("runs an enforced heartbeat whose lane was authorized by a reply in the thread", async () => {
    await writeLaneRecord("egd001a-graduate-run", GO_PERMALINK);
    await writeAskLedger([openAsk(GO_ROOT_TS)]);
    const stub = stubLaneCli({ activeLanes: ["egd001a-graduate-run"] });
    const guard = guardWith(stub);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx(GO_HEARTBEAT_SESSION))).toBeUndefined();
    expect(stub.commandsFor("reserve")).toHaveLength(1);
    const [record] = await readAudit();
    expect(record?.kind).toBe("heartbeat");
    expect(record?.mode).toBe("enforce");
    expect(record?.decision).toBe("allowed");
    expect(record?.lane).toBe("egd001a-graduate-run");
  });

  it("still cancels when the lane's go message belongs to another thread", async () => {
    await writeLaneRecord("other-thread", GO_PERMALINK);
    await writeAskLedger([openAsk("1788400000.111111")]);
    const stub = stubLaneCli({ activeLanes: ["other-thread"] });
    const guard = guardWith(stub);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx(GO_HEARTBEAT_SESSION));
    expect(blocked?.block).toBe(true);
    expect(stub.commandsFor("check")).toHaveLength(0);
    const [record] = await readAudit();
    expect(record?.lane).toBe("");
    expect(record?.reason).toContain("no active lane");
    expect(record?.reason).toContain(`${GO_CHANNEL}:${GO_ROOT_TS}`);
  });
});

/**
 * Several active lanes can cover one thread — live on 2026-09-07 a parent lane,
 * the run it spawned, and an older lane all did — and `lane.py list` sorts by
 * lane id, so the first of them is an alphabetical accident.
 */
describe("lane-guard choosing among the lanes covering a thread", () => {
  const COVERING_LANES = ["egd-000-34294319", "egd001a-graduate", "egd001a-graduate-run"];
  /** The live `allowed_actions`: only the last lane may spend on runpod. */
  const LIVE_LANE_ACTIONS: Record<string, string[]> = {
    "egd-000-34294319": ["analysis", "api_calls", "code_change", "local_cpu", "spark_gpu"],
    "egd001a-graduate": ["analysis", "api_calls", "code_change"],
    "egd001a-graduate-run": ["analysis", "api_calls", "code_change", "runpod"],
  };

  async function writeCoveringLanes(laneIds: string[] = COVERING_LANES): Promise<void> {
    for (const laneId of laneIds) {
      await writeLaneRecord(laneId, PERMALINK);
    }
  }

  it("charges the lane that allows the class, not the first one covering the thread", async () => {
    await writeCoveringLanes();
    const stub = stubLaneCli({ activeLanes: COVERING_LANES, laneActions: LIVE_LANE_ACTIONS });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("reserve").map((args) => args[1])).toEqual(["egd001a-graduate-run"]);
    const [record] = await readAudit();
    expect(record?.decision).toBe("allowed");
    expect(record?.lane).toBe("egd001a-graduate-run");
  });

  it("books an enforced heartbeat against the allowing lane and no other", async () => {
    await writeCoveringLanes();
    const stub = stubLaneCli({ activeLanes: COVERING_LANES, laneActions: LIVE_LANE_ACTIONS });
    const guard = guardWith(stub);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx(HEARTBEAT_SESSION))).toBeUndefined();
    expect(stub.commandsFor("reserve")).toEqual([
      [
        "reserve",
        "egd001a-graduate-run",
        "5",
        "--worker",
        HEARTBEAT_SESSION,
        "--note",
        "lane-guard estimate for runpod",
        "--json",
      ],
    ]);
    const [record] = await readAudit();
    expect(record?.mode).toBe("enforce");
    expect(record?.decision).toBe("allowed");
    expect(record?.lane).toBe("egd001a-graduate-run");
  });

  it("cancels and names every lane it tried when none of them allows the class", async () => {
    await writeCoveringLanes();
    const stub = stubLaneCli({
      activeLanes: COVERING_LANES,
      laneActions: {
        ...LIVE_LANE_ACTIONS,
        "egd001a-graduate-run": ["analysis", "api_calls", "code_change"],
      },
    });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    expect(stub.commandsFor("reserve")).toHaveLength(0);
    const [record] = await readAudit();
    expect(record?.decision).toBe("denied");
    expect(record?.lane).toBe("egd-000-34294319");
    expect(record?.reason).toContain("runpod is not in egd-000-34294319 allowed_actions");
    for (const laneId of COVERING_LANES) {
      expect(record?.reason).toContain(laneId);
    }
  });

  it("reports one covering lane's own refusal without listing lanes it never tried", async () => {
    await writeCoveringLanes(["egd001a-graduate"]);
    const stub = stubLaneCli({ activeLanes: ["egd001a-graduate"], laneActions: LIVE_LANE_ACTIONS });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect((await guard(execEvent(RUNPOD_COMMAND), toolCtx()))?.block).toBe(true);
    const [record] = await readAudit();
    expect(record?.reason).toBe("runpod is not in egd001a-graduate allowed_actions");
  });

  // exit 2 is an answer, so the search goes on. Only a check that could not run stops it.
  it("still tries the next lane when one of them cleanly denies the class", async () => {
    await writeCoveringLanes(["denies-lane", "grants-lane"]);
    const stub = stubLaneCli({
      activeLanes: ["denies-lane", "grants-lane"],
      laneActions: { "denies-lane": ["analysis"], "grants-lane": ["runpod"] },
    });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("check").map((args) => args[1])).toEqual([
      "denies-lane",
      "grants-lane",
    ]);
    expect(stub.commandsFor("reserve").map((args) => args[1])).toEqual(["grants-lane"]);
  });

  it("refuses without asking the next lane when a check could not be run", async () => {
    await writeCoveringLanes(["broken-lane", "would-allow-lane"]);
    const stub = stubLaneCli({
      activeLanes: ["broken-lane", "would-allow-lane"],
      laneActions: { "broken-lane": ["runpod"], "would-allow-lane": ["runpod"] },
      checkFailsFor: "broken-lane",
    });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    expect(stub.commandsFor("check").map((args) => args[1])).toEqual(["broken-lane"]);
    expect(stub.commandsFor("reserve")).toHaveLength(0);
    const [record] = await readAudit();
    expect(record?.lane).toBe("broken-lane");
    expect(record?.reason).toContain("Traceback: lane.py exploded");
    expect(record?.reason).toContain("could not be run");
    expect(record?.reason).not.toContain("no other lane covering this thread allows it");
  });

  it("cancels an enforced heartbeat when a check could not be run", async () => {
    await writeCoveringLanes(["broken-lane", "would-allow-lane"]);
    const stub = stubLaneCli({
      activeLanes: ["broken-lane", "would-allow-lane"],
      laneActions: { "broken-lane": ["runpod"], "would-allow-lane": ["runpod"] },
      checkFailsFor: "broken-lane",
    });
    const guard = guardWith(stub);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx(HEARTBEAT_SESSION));
    expect(blocked?.block).toBe(true);
    expect(stub.commandsFor("reserve")).toHaveLength(0);
    const [record] = await readAudit();
    expect(record?.mode).toBe("enforce");
    expect(record?.decision).toBe("denied");
  });

  it("picks the lane that allows every class a chained command charges", async () => {
    await writeCoveringLanes(["half-lane", "whole-lane"]);
    const stub = stubLaneCli({
      activeLanes: ["half-lane", "whole-lane"],
      laneActions: { "half-lane": ["runpod"], "whole-lane": ["runpod", "api_calls"] },
    });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(await guard(execEvent(CHAINED_COMMAND), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("reserve").map((args) => args[1])).toEqual([
      "whole-lane",
      "whole-lane",
    ]);
    expect((await readAudit())[0]?.lane).toBe("whole-lane");
  });
});

/**
 * Covering the thread is not a budget pool. Only "this lane is not scoped to
 * that action" moves the search on; a ceiling, an expiry, or a `lane.py` too old
 * to say which it was, is this thread's answer.
 */
describe("lane-guard refusals that must not fall through to another lane", () => {
  const LANES = ["first-lane", "second-lane"];
  const BOTH_ALLOW_RUNPOD = { "first-lane": ["runpod"], "second-lane": ["runpod"] };

  async function writeCoveringLanes(): Promise<void> {
    for (const laneId of LANES) {
      await writeLaneRecord(laneId, PERMALINK);
    }
  }

  it("refuses outright when a covering lane is over its ceiling", async () => {
    await writeCoveringLanes();
    const stub = stubLaneCli({
      activeLanes: LANES,
      laneActions: BOTH_ALLOW_RUNPOD,
      overCeilingLanes: ["first-lane"],
    });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    expect(stub.commandsFor("check").map((args) => args[1])).toEqual(["first-lane"]);
    expect(stub.commandsFor("reserve")).toHaveLength(0);
    const [record] = await readAudit();
    expect(record?.lane).toBe("first-lane");
    expect(record?.reason).toContain("over the ceiling");
  });

  // Only a cleanly parsed `action_not_allowed` may advance. Everything else that
  // exits 2 — an older lane.py, argparse's own usage error, a code from a newer
  // lane.py — is this thread's answer, not an invitation to spend elsewhere.
  it.each([
    ["names no code, as an older lane.py does", "no-code"],
    ["exits 2 with no stdout at all, as argparse does", "empty-stdout"],
    ["exits 2 with stdout that is not JSON", "malformed-stdout"],
    ["names a refusal code this guard does not know", "unknown-code"],
  ] as const)("refuses outright when the refusal %s", async (_shape, refusalStyle) => {
    await writeCoveringLanes();
    const stub = stubLaneCli({
      activeLanes: LANES,
      laneActions: { "first-lane": [], "second-lane": ["runpod"] },
      refusalStyle,
    });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    expect(stub.commandsFor("check").map((args) => args[1])).toEqual(["first-lane"]);
    expect(stub.commandsFor("reserve")).toHaveLength(0);
  });

  it("still passes over a lane that is simply not scoped to the action", async () => {
    await writeCoveringLanes();
    const stub = stubLaneCli({
      activeLanes: LANES,
      laneActions: { "first-lane": ["api_calls"], "second-lane": ["runpod"] },
    });
    const guard = guardWith(stub, ENFORCE_ALL);

    expect(await guard(execEvent(RUNPOD_COMMAND), toolCtx())).toBeUndefined();
    expect(stub.commandsFor("reserve").map((args) => args[1])).toEqual(["second-lane"]);
  });
});

/** `--json` was asked for, so an answer nobody can read is not an answer. */
describe("lane-guard unreadable lane.py output", () => {
  it("treats an exit-0 check with no readable JSON as a check that never ran", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"], unreadableAnswerFor: "check" });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    expect(stub.commandsFor("reserve")).toHaveLength(0);
    expect((await readAudit())[0]?.reason).toContain("without a readable");
  });

  it("treats an exit-0 reserve with no readable JSON as a booking that did not happen", async () => {
    await writeLaneRecord("kv-harvest", PERMALINK);
    const stub = stubLaneCli({ activeLanes: ["kv-harvest"], unreadableAnswerFor: "reserve" });
    const guard = guardWith(stub, ENFORCE_ALL);

    const blocked = await guard(execEvent(RUNPOD_COMMAND), toolCtx());
    expect(blocked?.block).toBe(true);
    const [record] = await readAudit();
    expect(record?.decision).toBe("denied");
    expect(record?.reason).toContain("reserve refused");
  });
});
