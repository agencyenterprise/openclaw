import { describe, expect, it } from "vitest";
import {
  type AskTurnVerdict,
  buildTurnKey,
  InboundTurnGate,
  MAX_TRACKED_TURNS,
} from "./inbound-turn-gate.js";

const CHANNEL = "C0A3C98HS48";
const LIVE_TS = "1788479558.561999";
const REPLAYED_TS = "1788479206.951729";

/** Both halves of the replay carry the same body; only the thread session differs. */
function turn(threadTs: string) {
  return {
    channelId: "slack",
    senderId: "U03EH553GBE",
    sessionKey: `agent:main:slack:channel:c0a3c98hs48:thread:${threadTs}`,
    content: "<@U0BOTID> how do we keep going on the ARP routing work?",
  };
}

const TURN = turn(LIVE_TS);
const ASK_ID = `${CHANNEL}:${LIVE_TS}`;

function suppression(reason: string): Promise<AskTurnVerdict> {
  return Promise.resolve({ suppress: true, reason });
}

function trackedTurn(gate: InboundTurnGate, verdict: Promise<AskTurnVerdict>): void {
  gate.track({ turnKey: buildTurnKey(TURN), askId: ASK_ID, verdict });
}

describe("buildTurnKey", () => {
  it("separates the fields so they cannot run into each other", () => {
    expect(buildTurnKey({ channelId: "a", senderId: "b", sessionKey: "c", content: "d" })).not.toBe(
      buildTurnKey({ channelId: "a", senderId: "bc", sessionKey: "", content: "d" }),
    );
  });

  it("treats missing fields as empty", () => {
    expect(
      buildTurnKey({
        channelId: undefined,
        senderId: undefined,
        sessionKey: undefined,
        content: "hi",
      }),
    ).toBe(buildTurnKey({ channelId: "", senderId: "", sessionKey: "", content: "hi" }));
  });

  it("keeps byte-identical messages apart by their thread session", () => {
    expect(buildTurnKey(turn(LIVE_TS))).not.toBe(buildTurnKey(turn(REPLAYED_TS)));
  });
});

describe("InboundTurnGate", () => {
  it("hands the recorder's verdict to the gate", async () => {
    const gate = new InboundTurnGate();
    trackedTurn(gate, suppression(`duplicate of ${CHANNEL}:${LIVE_TS}`));

    expect(await gate.take(buildTurnKey(TURN))).toEqual({
      suppress: true,
      reason: `duplicate of ${CHANNEL}:${LIVE_TS}`,
    });
  });

  it("waits for a verdict claimed before the ledger write finished", async () => {
    const gate = new InboundTurnGate();
    let settle = (_verdict: AskTurnVerdict) => {};
    trackedTurn(
      gate,
      new Promise<AskTurnVerdict>((resolve) => {
        settle = resolve;
      }),
    );

    const pending = gate.take(buildTurnKey(TURN));
    settle({ suppress: true, reason: "alias of C0A3C98HS48:1.1" });

    expect(await pending).toEqual({ suppress: true, reason: "alias of C0A3C98HS48:1.1" });
  });

  it("never suppresses a turn nobody claimed", async () => {
    expect(await new InboundTurnGate().take(buildTurnKey(TURN))).toEqual({ suppress: false });
  });

  it("forgets a verdict once the gate read it", async () => {
    const gate = new InboundTurnGate();
    trackedTurn(gate, suppression("duplicate of C0A3C98HS48:1.1"));

    await gate.take(buildTurnKey(TURN));

    expect(await gate.take(buildTurnKey(TURN))).toEqual({ suppress: false });
    expect(gate.trackedTurns).toBe(0);
  });

  it("keeps both turns when two messages still share a key, allowing exactly one", async () => {
    const gate = new InboundTurnGate();
    trackedTurn(gate, Promise.resolve({ suppress: false }));
    gate.track({
      turnKey: buildTurnKey(TURN),
      askId: `${CHANNEL}:${REPLAYED_TS}`,
      verdict: suppression(`duplicate of ${ASK_ID}`),
    });

    expect(await gate.take(buildTurnKey(TURN))).toEqual({ suppress: false });
    expect(await gate.take(buildTurnKey(TURN))).toEqual({
      suppress: true,
      reason: `duplicate of ${ASK_ID}`,
    });
    expect(gate.trackedTurns).toBe(0);
  });

  it("allows the question that may run even when the gate reads the turns out of order", async () => {
    const gate = new InboundTurnGate();
    // The replay was claimed first, but its verdict suppresses; the live turn behind
    // it must still be the one allowed to run.
    gate.track({
      turnKey: buildTurnKey(TURN),
      askId: `${CHANNEL}:${REPLAYED_TS}`,
      verdict: suppression(`duplicate of ${ASK_ID}`),
    });
    trackedTurn(gate, Promise.resolve({ suppress: false }));

    expect(await gate.take(buildTurnKey(TURN))).toEqual({ suppress: false });
    expect(await gate.take(buildTurnKey(TURN))).toEqual({
      suppress: true,
      reason: `duplicate of ${ASK_ID}`,
    });
  });

  it("stops a claimed turn by ask id when the message is deleted", async () => {
    const gate = new InboundTurnGate();
    trackedTurn(gate, Promise.resolve({ suppress: false }));

    expect(gate.stop(ASK_ID, "source message deleted")).toBe(true);
    expect(await gate.take(buildTurnKey(TURN))).toEqual({
      suppress: true,
      reason: "source message deleted",
    });
  });

  it("reports that no turn was in flight for an unknown or already-read ask", async () => {
    const gate = new InboundTurnGate();
    trackedTurn(gate, Promise.resolve({ suppress: false }));
    await gate.take(buildTurnKey(TURN));

    expect(gate.stop(ASK_ID, "source message deleted")).toBe(false);
    expect(gate.stop(`${CHANNEL}:9.9`, "source message deleted")).toBe(false);
  });

  it("bounds the turns it holds when no gate reads them", () => {
    const gate = new InboundTurnGate();
    for (let index = 0; index < MAX_TRACKED_TURNS + 100; index += 1) {
      gate.track({
        turnKey: buildTurnKey({ ...TURN, content: `ask ${index}` }),
        askId: `${CHANNEL}:${index}.1`,
        verdict: suppression("duplicate of C0A3C98HS48:1.1"),
      });
    }

    expect(gate.trackedTurns).toBe(MAX_TRACKED_TURNS);
    expect(gate.stop(`${CHANNEL}:0.1`, "source message deleted")).toBe(false);
  });
});
