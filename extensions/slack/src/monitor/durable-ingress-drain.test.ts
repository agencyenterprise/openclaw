import { afterEach, describe, expect, it, vi } from "vitest";
import { startSlackIngressDrain } from "./durable-ingress-drain.js";
afterEach(() => vi.useRealTimers());
describe("Slack single-consumer drain lifecycle", () => {
  it("discovers existing pending work at startup without receiver notification", async () => {
    const stop = new AbortController();
    const dispatch = vi.fn(async (claim: string) => {
      expect(claim).toBe("saved-original"); stop.abort(); return { status: "ADOPTED" as const };
    });
    const claimOne = vi.fn(async () => "saved-original");
    await startSlackIngressDrain({signal:stop.signal,claimOne,dispatch}).done;
    expect(dispatch).toHaveBeenCalledTimes(1); expect(claimOne).toHaveBeenCalledTimes(1);
  });
  it("backs off verified pre-admission retries and resets after adoption", async () => {
    vi.useFakeTimers(); const stop = new AbortController();
    const times: number[] = [];
    const dispatch = vi.fn(async () => {
      times.push(Date.now());
      if(times.length <= 3) return {status:"RETRY_PRE_ADMISSION" as const};
      stop.abort(); return {status:"ADOPTED" as const};
    });
    const run=startSlackIngressDrain({signal:stop.signal,claimOne:async()=>"same-source",dispatch,busyInitialMs:10,busyMaximumMs:20});
    await vi.advanceTimersByTimeAsync(50); await run.done;
    expect(times.map(t=>t-times[0])).toEqual([0,10,30,50]);
  });
  it("never overlaps dispatch or settles an uncertain claim", async () => {
    const stop = new AbortController(); let resolve!: (value:{status:"HELD_UNCERTAIN"})=>void;
    const claimOne=vi.fn(async()=>"claim"); const held=vi.fn();
    const dispatch=vi.fn(()=>new Promise<{status:"HELD_UNCERTAIN"}>(r=>{resolve=r;}));
    const run=startSlackIngressDrain({signal:stop.signal,claimOne,dispatch,onHeld:held});
    await Promise.resolve(); await Promise.resolve();
    expect(claimOne).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(1);
    resolve({status:"HELD_UNCERTAIN"}); await run.done;
    expect(claimOne).toHaveBeenCalledTimes(1); expect(held).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch a claim acquired across shutdown", async () => {
    const stop=new AbortController(); const dispatch=vi.fn(); const held=vi.fn();
    await startSlackIngressDrain({signal:stop.signal,claimOne:async()=>{stop.abort();return "held";},dispatch,onHeld:held}).done;
    expect(dispatch).not.toHaveBeenCalled(); expect(held).toHaveBeenCalledOnce();
  });
  it("aborts idle sleep and never claims again", async () => {
    vi.useFakeTimers(); const stop=new AbortController(); const claimOne=vi.fn(async()=>null);
    const run=startSlackIngressDrain({signal:stop.signal,claimOne,dispatch:vi.fn()});
    await vi.advanceTimersByTimeAsync(0); stop.abort(); await run.done;
    expect(claimOne).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("holds unexpected failures without forwarding private error content", async () => {
    const held=vi.fn(); const claimOne=vi.fn(async()=>{throw new Error("PRIVATE_PAYLOAD");});
    await startSlackIngressDrain({signal:new AbortController().signal,claimOne,dispatch:vi.fn(),onHeld:held}).done;
    expect(held.mock.calls).toEqual([[]]); expect(claimOne).toHaveBeenCalledOnce();
  });
});
