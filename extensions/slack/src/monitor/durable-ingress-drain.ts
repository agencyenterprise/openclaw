/** Single-consumer lifecycle. Dispatch owns durable settlement; this loop never releases claims. */
export type SlackIngressDispatchOutcome = { status: "ADOPTED" | "RETRY_PRE_ADMISSION" | "HELD_UNCERTAIN" };
export function startSlackIngressDrain<TClaim>(params: {
  signal: AbortSignal;
  claimOne: () => Promise<TClaim | null>;
  dispatch: (claim: TClaim) => Promise<SlackIngressDispatchOutcome>;
  onHeld?: () => void;
  idleMs?: number;
  busyInitialMs?: number;
  busyMaximumMs?: number;
}): { done: Promise<void> } {
  const duration = (value: number | undefined, fallback: number) => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1 || result > 300_000)
      throw new Error("SLACK_INGRESS_DRAIN_DURATION");
    return result;
  };
  const idle = duration(params.idleMs, 1_000);
  const initial = duration(params.busyInitialMs, 1_000);
  const maximum = duration(params.busyMaximumMs, 30_000);
  if (initial > maximum) throw new Error("SLACK_INGRESS_DRAIN_DURATION");
  const wait = (ms: number) => new Promise<void>((resolve) => {
    if (params.signal.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      params.signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    params.signal.addEventListener("abort", finish, { once: true });
    if (params.signal.aborted) finish();
  });
  const hold = () => {
    // Callers may record a fixed status, never an underlying payload/SQL/transport exception.
    try { params.onHeld?.(); } catch { /* Failure reporting cannot cause replay. */ }
  };
  const done = (async () => {
    let delay = initial;
    while (!params.signal.aborted) {
      let claim: TClaim | null;
      try { claim = await params.claimOne(); }
      catch { hold(); return; }
      if (claim === null) { delay = initial; await wait(idle); continue; }
      // Abort after durable claim acquisition leaves it held; no unverified release.
      if (params.signal.aborted) { hold(); return; }
      let outcome: SlackIngressDispatchOutcome;
      try { outcome = await params.dispatch(claim); }
      catch { hold(); return; }
      if (outcome?.status === "HELD_UNCERTAIN") { hold(); return; }
      if (outcome?.status === "RETRY_PRE_ADMISSION") {
        await wait(delay);
        delay = Math.min(maximum, delay * 2);
      } else if (outcome?.status === "ADOPTED") {
        delay = initial;
      } else { hold(); return; }
    }
  })();
  return { done };
}
