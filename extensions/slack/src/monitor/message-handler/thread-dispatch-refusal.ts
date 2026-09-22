// Slack helper module recognizes turn dispatches the thread-dispatch fence did not let run.
const THREAD_DISPATCH_REFUSED_MESSAGE = "THREAD_DISPATCH_REFUSED";
const THREAD_DISPATCH_NATIVE_BUSY_MESSAGE = "NATIVE_BUSY";

/**
 * True when the thread-dispatch fence refused this dispatch because a claim for the same
 * post already exists. The post is being handled by that other dispatch, so the refused one
 * must stay silent: no reply, no status reaction, no notice.
 */
export function isThreadDispatchRefusal(error: unknown): boolean {
  return error instanceof Error && error.message === THREAD_DISPATCH_REFUSED_MESSAGE;
}

/**
 * True when the fence reported another turn owns the thread right now. The Slack ingress
 * retries such a post on its claim-busy budget, so this attempt must not paint the post as failed.
 */
export function isThreadDispatchBusy(error: unknown): boolean {
  return error instanceof Error && error.message === THREAD_DISPATCH_NATIVE_BUSY_MESSAGE;
}

/** True when this attempt did not run the turn and must leave the post's status reactions alone. */
export function isThreadDispatchHeldElsewhere(error: unknown): boolean {
  return isThreadDispatchRefusal(error) || isThreadDispatchBusy(error);
}
