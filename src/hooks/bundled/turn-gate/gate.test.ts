import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
} from "../../../plugins/hook-types.js";
import { JOBS_FILE } from "./evidence.js";
import {
  createTurnGateDelivery,
  createTurnGateHandler,
  DEFAULT_TURN_GATE_CONFIG,
  TURN_GATE_FILE,
  type TurnGateDeps,
  type TurnGateRecord,
} from "./gate.js";
import type { LaneAuthorization } from "./lane-authorization.js";
import { resetPendingRepairsForTest } from "./pending-repair.js";
import { REPAIR_MARKER } from "./repair.js";

const SESSION = "agent:main:slack:channel:c0a3c98hs48:thread:1786591963.108609";
const CLOCK = new Date("2026-09-03T10:00:00.000Z");
const TURN_MS = 60_000;
const PROMISE = "Next: I'll start the harvest now.";
const DELIVERED_TS = "1786591999.900001";
const INBOUND = {
  messageId: "1786591963.108609",
  channel: "C0A3C98HS48",
  threadTs: "1786591963.108609",
  text: "run the harvest",
};

let workspaceDir = "";
let sentRepairs: { sessionKey: string; text: string }[] = [];

function deps(overrides: Partial<TurnGateDeps> = {}): TurnGateDeps {
  return {
    resolveWorkspaceDir: () => workspaceDir,
    resolveConfig: () => DEFAULT_TURN_GATE_CONFIG,
    now: () => CLOCK,
    settleMs: 0,
    ...overrides,
  };
}

/** A gate wired for repair: no lane covers the thread unless a test says otherwise. */
function repairingDeps(overrides: Partial<TurnGateDeps> = {}): TurnGateDeps {
  return deps({
    authorizeLane: async () => noLane,
    sendRepair: (params) => {
      sentRepairs.push(params);
      return true;
    },
    ...overrides,
  });
}

const noLane: LaneAuthorization = {
  authorized: false,
  reason: "no active lane covers this thread",
};

const authorizingLane: LaneAuthorization = {
  laneId: "dag000i-frame",
  authorized: true,
  reason: "runpod: lane 'dag000i-frame' allows 'runpod' for $5.00",
};

function assistant(text: string, blocks: unknown[] = []): unknown {
  return { role: "assistant", content: [{ type: "text", text }, ...blocks] };
}

function user(text: string, timestamp?: number): unknown {
  return { role: "user", content: text, ...(timestamp === undefined ? {} : { timestamp }) };
}

/** The normalized OpenClaw tool call the embedded runner actually produces. */
function execCall(command: string): unknown {
  return { type: "toolCall", id: "call_1", name: "exec", arguments: { command } };
}

function editCall(messageId: string): unknown {
  return {
    type: "toolCall",
    id: "call_edit",
    name: "message",
    arguments: { action: "edit", messageId, message: "Not started: needs an active lane." },
  };
}

/** `null` means the event carries no `durationMs` at all, not a zero-length turn. */
function endEvent(messages: unknown[], durationMs: number | null = TURN_MS) {
  return {
    messages,
    success: true,
    ...(durationMs === null ? {} : { durationMs }),
  } as PluginHookAgentEndEvent;
}

function ctx(overrides: Partial<PluginHookAgentContext> = {}): PluginHookAgentContext {
  return { sessionKey: SESSION, ...overrides };
}

/** A turn triggered by a human message, which is what a repair needs to identify. */
function inboundCtx(
  inbound: Partial<typeof INBOUND> = {},
  overrides: Partial<PluginHookAgentContext> = {},
): PluginHookAgentContext {
  return ctx({ inboundMessage: { ...INBOUND, ...inbound }, ...overrides });
}

async function readRecords(): Promise<TurnGateRecord[]> {
  const content = await fs.readFile(path.join(workspaceDir, "state", TURN_GATE_FILE), "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TurnGateRecord);
}

async function writeJobsFile(mtime: Date): Promise<void> {
  const jobsPath = path.join(workspaceDir, "state", JOBS_FILE);
  await fs.mkdir(path.dirname(jobsPath), { recursive: true });
  await fs.writeFile(jobsPath, "{}\n", "utf-8");
  await fs.utimes(jobsPath, mtime, mtime);
}

/**
 * One promising turn, delivered. Returns the repair note, so a test can assert on
 * the decision the delivery side actually made.
 */
async function promiseAndDeliver(params: {
  gateDeps: TurnGateDeps;
  messages?: unknown[];
  context?: PluginHookAgentContext;
  sessionKey?: string;
  messageId?: string;
}): Promise<string | undefined> {
  const gate = createTurnGateHandler(params.gateDeps);
  const deliver = createTurnGateDelivery(params.gateDeps);
  await gate(
    endEvent(params.messages ?? [user(INBOUND.text), assistant(PROMISE)]),
    params.context ?? inboundCtx(),
  );
  return deliver({
    sessionKey: params.sessionKey ?? SESSION,
    messageId: params.messageId ?? DELIVERED_TS,
  });
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "turn-gate-"));
  sentRepairs = [];
  resetPendingRepairsForTest();
});

afterEach(async () => {
  resetPendingRepairsForTest();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("turn-gate", () => {
  it("records a backed verdict when the turn registers the job it promised", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(
      endEvent([
        user("run the harvest"),
        assistant("working on it", [execCall("python3 scripts/register_job.py --id harvest")]),
        assistant(PROMISE),
      ]),
      ctx(),
    );

    const [record] = await readRecords();
    expect(record?.verdict).toBe("backed");
    expect(record?.commitments).toEqual(["Next:", "I'll"]);
    expect(record?.evidence).toEqual(["command:register_job.py"]);
  });

  it("records an unbacked verdict when nothing armed the promise", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(endEvent([assistant(PROMISE, [execCall("ls -la /workspace")])]), ctx());

    const [record] = await readRecords();
    expect(record?.verdict).toBe("unbacked");
    expect(record?.evidence).toEqual([]);
    expect(record?.commitments).toContain("Next:");
  });

  it("records none when the turn promises nothing", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(endEvent([assistant("The run finished with 412 rows.")]), ctx());

    const [record] = await readRecords();
    expect(record?.verdict).toBe("none");
    expect(record?.commitments).toEqual([]);
  });

  it("does not read a commitment inside a longer word", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(endEvent([assistant("The alarm was disarmed and the rerun finished.")]), ctx());

    const [record] = await readRecords();
    expect(record?.commitments).toEqual([]);
    expect(record?.verdict).toBe("none");
  });

  it("matches a curly apostrophe against the straight configured phrase", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(endEvent([assistant("I’ll kick off the harvest.")]), ctx());

    expect((await readRecords())[0]?.commitments).toEqual(["I'll"]);
  });

  it("drops blank configured phrases instead of matching every turn", async () => {
    const gate = createTurnGateHandler(
      deps({
        resolveConfig: () => ({
          ...DEFAULT_TURN_GATE_CONFIG,
          phrases: ["", "   ", "Next:"],
          commandMarkers: [],
        }),
      }),
    );
    await gate(endEvent([assistant("The run finished with 412 rows.")]), ctx());

    expect((await readRecords())[0]?.verdict).toBe("none");
  });

  it("writes exactly one record per turn with the agreed shape", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(endEvent([assistant(PROMISE)]), ctx());

    const records = await readRecords();
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0] ?? {}).toSorted()).toEqual([
      "commitments",
      "evidence",
      "repair",
      "session",
      "thread",
      "ts",
      "verdict",
    ]);
    expect(records[0]).toMatchObject({
      ts: CLOCK.toISOString(),
      session: SESSION,
      thread: "C0A3C98HS48:1786591963.108609",
    });
  });

  it("ignores a job registered before the current turn began", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(
      endEvent([
        assistant("armed it", [execCall("python3 scripts/register_job.py --id older")]),
        user("now promise me the harvest"),
        assistant(PROMISE),
      ]),
      ctx(),
    );

    const [record] = await readRecords();
    expect(record?.evidence).toEqual([]);
    expect(record?.verdict).toBe("unbacked");
  });

  it("counts a normalized cron tool call as evidence", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(
      endEvent([
        assistant("scheduling", [
          { type: "toolCall", id: "c1", name: "cron_add", arguments: { schedule: "0 * * * *" } },
        ]),
        assistant(PROMISE),
      ]),
      ctx(),
    );

    const [record] = await readRecords();
    expect(record?.evidence).toEqual(["tool:cron_add"]);
    expect(record?.verdict).toBe("backed");
  });

  it("still reads unnormalized cli-runner transcripts in both wire shapes", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(
      endEvent([
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "exec", input: { command: "hcom codex handoff" } }],
        },
        {
          role: "assistant",
          tool_calls: [{ function: { name: "cron_add", arguments: '{"schedule":"0 * * * *"}' } }],
        },
        assistant(PROMISE),
      ]),
      ctx(),
    );

    const [record] = await readRecords();
    expect(record?.evidence).toEqual(["command:hcom codex", "tool:cron_add"]);
  });

  it("counts a jobs.json written during the turn as evidence", async () => {
    await writeJobsFile(new Date(CLOCK.getTime() - 1_000));
    const gate = createTurnGateHandler(deps());
    await gate(endEvent([assistant(PROMISE)]), ctx());

    const [record] = await readRecords();
    expect(record?.evidence).toEqual(["state/jobs.json written"]);
    expect(record?.verdict).toBe("backed");
  });

  it("ignores a jobs.json last written before the turn started", async () => {
    await writeJobsFile(new Date(CLOCK.getTime() - TURN_MS - 1_000));
    const gate = createTurnGateHandler(deps());
    await gate(endEvent([assistant(PROMISE)]), ctx());

    expect((await readRecords())[0]?.verdict).toBe("unbacked");
  });

  it("prefers the turn's own timestamp over durationMs for the jobs.json window", async () => {
    const turnStartedAt = CLOCK.getTime() - 30_000;
    const messages = [user("go", turnStartedAt), assistant(PROMISE)];
    const gate = createTurnGateHandler(deps());

    // Inside the durationMs window but before this turn actually began.
    await writeJobsFile(new Date(CLOCK.getTime() - 40_000));
    await gate(endEvent(messages), ctx());
    await writeJobsFile(new Date(CLOCK.getTime() - 10_000));
    await gate(endEvent(messages), ctx());

    const records = await readRecords();
    expect(records[0]?.evidence).toEqual([]);
    expect(records[1]?.evidence).toEqual(["state/jobs.json written"]);
  });

  it("skips the mtime check rather than guessing when the turn start is unknown", async () => {
    await writeJobsFile(new Date(CLOCK.getTime() - 1_000));
    const gate = createTurnGateHandler(deps());
    await gate(endEvent([assistant(PROMISE)], null), ctx());

    expect((await readRecords())[0]?.evidence).toEqual([]);
  });

  it("prefers the inbound message for the thread and falls back to the session key", async () => {
    const gate = createTurnGateHandler(deps());
    await gate(
      endEvent([assistant(PROMISE)]),
      ctx({
        sessionKey: "agent:main:main",
        inboundMessage: { channel: "C0DIGEST", threadTs: "1786000000.000100" },
      }),
    );
    await gate(endEvent([assistant(PROMISE)]), ctx({ sessionKey: "agent:main:main" }));

    const records = await readRecords();
    expect(records[0]?.thread).toBe("C0DIGEST:1786000000.000100");
    expect(records[1]?.thread).toBe("unknown");
  });

  it("never throws out of the turn-end path", async () => {
    const gate = createTurnGateHandler(
      deps({
        resolveConfig: () => {
          throw new Error("config exploded");
        },
      }),
    );

    await expect(gate(endEvent([assistant(PROMISE)]), ctx())).resolves.toBeUndefined();
  });
});

describe("turn-gate repair", () => {
  it("writes the measurement before delivery and repairs only afterwards", async () => {
    const gate = createTurnGateHandler(repairingDeps());
    await gate(endEvent([user(INBOUND.text), assistant(PROMISE)]), inboundCtx());

    // The record exists the moment the turn ends; the repair has not run yet.
    expect((await readRecords())[0]).toMatchObject({
      verdict: "unbacked",
      repair: "pending-delivery",
    });
    expect(sentRepairs).toEqual([]);

    const note = await createTurnGateDelivery(repairingDeps())({
      sessionKey: SESSION,
      messageId: DELIVERED_TS,
    });
    expect(note).toBe("sent:correct");
    expect(sentRepairs).toHaveLength(1);
  });

  it("aims the repair at the ts of the last message the turn delivered", async () => {
    const gateDeps = repairingDeps();
    const gate = createTurnGateHandler(gateDeps);
    const deliver = createTurnGateDelivery(gateDeps);
    await gate(endEvent([user(INBOUND.text), assistant(PROMISE)]), inboundCtx());

    const superseded = deliver({ sessionKey: SESSION, messageId: "1786591999.000001" });
    const final = deliver({ sessionKey: SESSION, messageId: DELIVERED_TS });

    expect(await superseded).toBeUndefined();
    expect(await final).toBe("sent:correct");
    expect(sentRepairs).toHaveLength(1);
    expect(sentRepairs[0]?.text).toContain(`messageId ${DELIVERED_TS}`);
  });

  it("tells the repair to edit in place, never to post, and to quote the promise", async () => {
    await promiseAndDeliver({ gateDeps: repairingDeps() });

    const text = sentRepairs[0]?.text ?? "";
    expect(text).toContain(REPAIR_MARKER);
    expect(text).toContain(`"${PROMISE}"`);
    expect(text).toContain(`action "edit"`);
    expect(text).toContain("Not started: needs <decision>.");
    expect(text).toContain("Do not post a new message in this thread.");
    expect(text).toContain("<@U03EH553GBE>");
    expect(text).not.toContain("Running:");
  });

  it("tells the repair to start the step when a lane already authorizes it", async () => {
    const note = await promiseAndDeliver({
      gateDeps: repairingDeps({ authorizeLane: async () => authorizingLane }),
    });

    const text = sentRepairs[0]?.text ?? "";
    expect(text).toContain("Lane dag000i-frame already authorizes");
    expect(text).toContain("Running: <what you started>");
    expect(text).toContain("Do not post a new message in this thread.");
    expect(text).not.toContain("Not started:");
    expect(note).toBe("sent:start:dag000i-frame");
  });

  it("queues no repair for a backed or promiseless turn", async () => {
    const gateDeps = repairingDeps();
    await promiseAndDeliver({
      gateDeps,
      messages: [
        user(INBOUND.text),
        assistant("armed", [execCall("python3 scripts/register_job.py --id harvest")]),
        assistant(PROMISE),
      ],
    });
    await promiseAndDeliver({
      gateDeps,
      messages: [user(INBOUND.text), assistant("Done, 412 rows.")],
    });

    expect(sentRepairs).toEqual([]);
    expect((await readRecords()).map((record) => record.verdict)).toEqual(["backed", "none"]);
  });

  it("never repairs a token-only heartbeat acknowledgement", async () => {
    await promiseAndDeliver({
      gateDeps: repairingDeps(),
      messages: [user(INBOUND.text), assistant("HEARTBEAT_OK")],
    });

    expect(sentRepairs).toEqual([]);
  });

  it("still repairs a real promise that merely mentions the heartbeat token", async () => {
    const note = await promiseAndDeliver({
      gateDeps: repairingDeps(),
      messages: [user(INBOUND.text), assistant(`${PROMISE} Otherwise I reply HEARTBEAT_OK.`)],
    });

    expect(note).toBe("sent:correct");
  });

  it("never repairs a promise that only quotes a human", async () => {
    await promiseAndDeliver({
      gateDeps: repairingDeps(),
      messages: [user(INBOUND.text), assistant(`> ${PROMISE}\nThat was your ask, not mine.`)],
    });

    expect(sentRepairs).toEqual([]);
    expect((await readRecords())[0]?.repair).toBe("skipped:promise-only-quoted");
  });

  it("leaves an answered question alone unless the thread already has a lane", async () => {
    const question = { messageId: "1786591963.222222", text: "how would I build the harvest?" };
    expect(
      await promiseAndDeliver({ gateDeps: repairingDeps(), context: inboundCtx(question) }),
    ).toBe("skipped:question-without-lane");
    expect(sentRepairs).toEqual([]);

    expect(
      await promiseAndDeliver({
        gateDeps: repairingDeps({ authorizeLane: async () => authorizingLane }),
        context: inboundCtx(question),
      }),
    ).toBe("sent:start:dag000i-frame");
  });

  it("reads a negated execution request as a question", async () => {
    expect(
      await promiseAndDeliver({
        gateDeps: repairingDeps(),
        context: inboundCtx({ messageId: "1786591963.666666", text: "please do not run this yet" }),
      }),
    ).toBe("skipped:question-without-lane");
  });

  it("reads a bare imperative as a request to execute", async () => {
    expect(
      await promiseAndDeliver({
        gateDeps: repairingDeps(),
        context: inboundCtx({ messageId: "1786591963.777777", text: "implement the fix" }),
      }),
    ).toBe("sent:correct");
  });

  it("repairs one deliverable once, however often the promise comes back", async () => {
    const later = new Date(CLOCK.getTime() + 24 * 60 * 60 * 1000);
    await promiseAndDeliver({ gateDeps: repairingDeps() });
    const note = await promiseAndDeliver({ gateDeps: repairingDeps({ now: () => later }) });

    expect(sentRepairs).toHaveLength(1);
    expect(note).toBe("skipped:already-repaired");
  });

  it("holds the cooldown between two repairs in the same session", async () => {
    await promiseAndDeliver({ gateDeps: repairingDeps() });
    const note = await promiseAndDeliver({
      gateDeps: repairingDeps(),
      messages: [user(INBOUND.text), assistant("Next: I'll also start the sweep.")],
      context: inboundCtx({ messageId: "1786591963.333333" }),
    });

    expect(sentRepairs).toHaveLength(1);
    expect(note).toBe("skipped:cooldown");
  });

  it("stops at maxPerDay across sessions", async () => {
    const config = {
      ...DEFAULT_TURN_GATE_CONFIG,
      repair: { ...DEFAULT_TURN_GATE_CONFIG.repair, maxPerDay: 1 },
    };
    const otherSession = "agent:main:slack:channel:c0a3c98hs48:thread:1786591999.111111";
    await promiseAndDeliver({ gateDeps: repairingDeps({ resolveConfig: () => config }) });
    const note = await promiseAndDeliver({
      gateDeps: repairingDeps({ resolveConfig: () => config }),
      context: inboundCtx({ messageId: "1786591963.444444" }, { sessionKey: otherSession }),
      sessionKey: otherSession,
    });

    expect(sentRepairs).toHaveLength(1);
    expect(note).toBe("skipped:daily-cap");
  });

  it("gives the claim back when the repair turn cannot be queued", async () => {
    const refusing = repairingDeps({ sendRepair: () => false });
    expect(await promiseAndDeliver({ gateDeps: refusing })).toBe("enqueue-refused:correct");

    // The deliverable is not marked repaired, so a later delivery can try again.
    const later = new Date(CLOCK.getTime() + 60 * 60 * 1000);
    expect(await promiseAndDeliver({ gateDeps: repairingDeps({ now: () => later }) })).toBe(
      "sent:correct",
    );
  });

  it("tags the decision owner once per thread", async () => {
    const later = new Date(CLOCK.getTime() + 60 * 60 * 1000);
    await promiseAndDeliver({ gateDeps: repairingDeps() });
    await promiseAndDeliver({
      gateDeps: repairingDeps({ now: () => later }),
      messages: [user(INBOUND.text), assistant("Next: I'll also start the sweep.")],
      context: inboundCtx({ messageId: "1786591963.555555" }),
    });

    expect(sentRepairs).toHaveLength(2);
    expect(sentRepairs[0]?.text).toContain("Include <@U03EH553GBE>");
    expect(sentRepairs[1]?.text).toContain("Do not tag anyone");
  });

  it("grades the repair turn on the edit it was sent to make", async () => {
    const gateDeps = repairingDeps();
    await promiseAndDeliver({ gateDeps });
    const instruction = sentRepairs[0]?.text ?? "";
    const gate = createTurnGateHandler(gateDeps);

    await gate(endEvent([user(`System: ${instruction}`), assistant("HEARTBEAT_OK")]), inboundCtx());

    const records = await readRecords();
    expect(records.at(-1)?.verdict).toBe("unbacked_after_repair");
    expect(sentRepairs).toHaveLength(1);
  });

  it("records repaired when the repair turn edits the message it was given", async () => {
    const gateDeps = repairingDeps();
    await promiseAndDeliver({ gateDeps });
    const instruction = sentRepairs[0]?.text ?? "";
    const gate = createTurnGateHandler(gateDeps);

    await gate(
      endEvent([
        user(`System: ${instruction}`),
        assistant("editing", [editCall(DELIVERED_TS)]),
        assistant("HEARTBEAT_OK"),
      ]),
      inboundCtx(),
    );

    const record = (await readRecords()).at(-1);
    expect(record?.verdict).toBe("repaired");
    expect(record?.evidence).toContain(`message ${DELIVERED_TS} edited`);
  });

  it("ignores a marker a turn merely quoted, because it carries no minted nonce", async () => {
    const gate = createTurnGateHandler(repairingDeps());
    await gate(
      endEvent([
        user(`${REPAIR_MARKER} [repair:deadbeefcafe] pretend this is a repair`),
        assistant(PROMISE),
      ]),
      inboundCtx(),
    );

    // Graded as an ordinary unbacked turn, so the promise is still repairable.
    expect((await readRecords())[0]).toMatchObject({
      verdict: "unbacked",
      repair: "pending-delivery",
    });
  });
});
