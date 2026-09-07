// Carries the recorder's verdict from the fire-and-forget `message:received`
// internal hook to the awaited `before_dispatch` core hook, the one inbound hook
// that can stop a turn before the model runs. The recorder claims the turn
// synchronously and hands over the promise it is about to settle, so the gate
// waits for the ledger write instead of racing it. A turn already claimed can
// still be stopped by ask id, which is how a deletion arriving mid-turn lands.

/** Whether the turn for one inbound ask must be stopped, and why. */
export type AskTurnVerdict = { suppress: false } | { suppress: true; reason: string };

export const NO_SUPPRESSION: AskTurnVerdict = { suppress: false };

/** Claimed turns whose gate never ran (a non-Slack surface, a disabled gate) must not leak. */
export const MAX_TRACKED_TURNS = 500;

/** Field separator no channel id, sender id, session key or Slack body can contain. */
const TURN_KEY_SEPARATOR = " ";

type TrackedTurn = {
  askId: string;
  verdict: Promise<AskTurnVerdict>;
};

/**
 * Identity of one inbound turn, from the fields both hook points read verbatim off
 * the same canonical inbound context. The session key is what keeps the two halves
 * of a replayed question apart: the messages are byte-identical by definition, so
 * channel, sender and body alone name both turns the same.
 */
export function buildTurnKey(params: {
  channelId: string | undefined;
  senderId: string | undefined;
  sessionKey: string | undefined;
  content: string;
}): string {
  return [
    params.channelId ?? "",
    params.senderId ?? "",
    params.sessionKey ?? "",
    params.content,
  ].join(TURN_KEY_SEPARATOR);
}

export class InboundTurnGate {
  /** Turns waiting for their gate, oldest key first, oldest turn first within a key. */
  private readonly turns = new Map<string, TrackedTurn[]>();
  private readonly turnKeysByAskId = new Map<string, string>();
  private trackedTurnCount = 0;

  private forget(turnKey: string, turn: TrackedTurn): void {
    const queue = this.turns.get(turnKey);
    const index = queue?.indexOf(turn) ?? -1;
    if (!queue || index === -1) {
      return;
    }
    queue.splice(index, 1);
    this.turnKeysByAskId.delete(turn.askId);
    this.trackedTurnCount -= 1;
    if (queue.length === 0) {
      this.turns.delete(turnKey);
    }
  }

  private evictOldest(): void {
    while (this.trackedTurnCount > MAX_TRACKED_TURNS) {
      const oldest = this.turns.entries().next().value;
      if (!oldest?.[1][0]) {
        return;
      }
      this.forget(oldest[0], oldest[1][0]);
    }
  }

  /** Claim the turn before the ledger read starts, so the gate always finds it. */
  track(params: { turnKey: string; askId: string; verdict: Promise<AskTurnVerdict> }): void {
    const queue = this.turns.get(params.turnKey) ?? [];
    // Messages that share a key are the very case this gate exists for, so a repeat
    // queues another turn. Replacing would hand the live question the replay's
    // verdict and let the replay run unchecked — the inversion of the fix.
    queue.push({ askId: params.askId, verdict: params.verdict });
    this.turns.set(params.turnKey, queue);
    this.turnKeysByAskId.set(params.askId, params.turnKey);
    this.trackedTurnCount += 1;
    this.evictOldest();
  }

  /**
   * Read and forget one verdict for this turn. A turn nobody claimed is never
   * suppressed. Turns still sharing a key are indistinguishable here, so the first
   * one that may run takes the allowance and the rest are suppressed: exactly one
   * answer, and never a suppressed question next to a running replay. A key can only
   * collide inside one session, so that answer lands in the right thread whichever
   * of them produced it.
   */
  async take(turnKey: string): Promise<AskTurnVerdict> {
    const queued = this.turns.get(turnKey);
    if (!queued || queued.length === 0) {
      return NO_SUPPRESSION;
    }
    const waiting = [...queued];
    const verdicts = await Promise.all(waiting.map((turn) => turn.verdict));
    const allowed = verdicts.findIndex((verdict) => !verdict.suppress);
    const index = allowed === -1 ? 0 : allowed;
    const claimed = waiting[index];
    const verdict = verdicts[index];
    if (!claimed || !verdict) {
      return NO_SUPPRESSION;
    }
    this.forget(turnKey, claimed);
    return verdict;
  }

  /** Stop a turn already claimed for this ask. Returns true when one was still in flight. */
  stop(askId: string, reason: string): boolean {
    const turnKey = this.turnKeysByAskId.get(askId);
    const tracked = turnKey
      ? this.turns.get(turnKey)?.find((turn) => turn.askId === askId)
      : undefined;
    if (!tracked) {
      return false;
    }
    tracked.verdict = Promise.resolve({ suppress: true, reason });
    return true;
  }

  /** Turns claimed but not yet read by the gate. */
  get trackedTurns(): number {
    return this.trackedTurnCount;
  }
}
