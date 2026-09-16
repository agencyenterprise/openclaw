// Private, in-process journal participation; JSON fields cannot mint ownership.
import {
  NativeDispatchBusyError,
  withNativeControlProbe,
  readChannelSourceAdoptionReceipt,
  readChannelSourcePreAdmissionAbsence,
  readChannelSourceTurnId,
  readNativePreAdmissionRefusal,
  type ChannelSourceAdoptionTarget,
} from "openclaw/plugin-sdk/reply-runtime";
import type { ChannelIngressQueueClaim } from "../../../../src/channels/message/ingress-queue.js";
import type {
  SlackIngressEnvelope,
  SlackIngressMetadata,
  SlackIngressPayload,
  SlackIngressQueue,
} from "./durable-ingress.js";

type Claim = ChannelIngressQueueClaim<SlackIngressPayload, SlackIngressMetadata>;
export type SlackIngressDispatchResult = {
  status: "ADOPTED" | "RETRY_PRE_ADMISSION" | "HELD_UNCERTAIN";
  sourceId: string;
  reason?: string;
};
type Participant = {
  claim: Claim;
  queue: SlackIngressQueue;
  adoptionStarted: boolean;
  completed: boolean;
  failure?: unknown;
  closed?: boolean;
  prepared?: { context: object; storePath: string; sessionKey: string };
};
const participants = new WeakMap<object, Participant>();
type ControlParticipant = { closed: boolean; releases: Array<() => void>; prepared?: { context: object; sessionKey: string }; failure?: unknown };
const controls = new WeakMap<object, ControlParticipant>();
const fixedError = () => new Error("SLACK_INGRESS_DISPATCH_HELD");
export function hasSlackIngressParticipant(value: object): boolean {
  return (participants.has(value) && participants.get(value)?.closed !== true) || (controls.has(value) && controls.get(value)?.closed !== true);
}
export function transferSlackIngressParticipant(from: object, to: object): void {
  const participant = participants.get(from);
  if (participant) participants.set(to, participant);
  const control = controls.get(from);
  if (control && !control.closed) controls.set(to, control);
}
export function withSlackIngressOptions<T extends object>(
  event: object,
  options: T,
): T & { awaitDispatch?: boolean } {
  const participant = participants.get(event);
  const control = controls.get(event);
  if (!participant && (!control || control.closed)) return options;
  const result = { ...options, awaitDispatch: true };
  if (participant) participants.set(result, participant);
  if (control) controls.set(result, control);
  return result;
}
export function attachSlackPreparedIngress(
  options: object,
  context: object,
  target: { storePath: string; sessionKey: string },
): void {
  const control = controls.get(options);
  if (control && !control.closed) { control.prepared = {context, sessionKey: target.sessionKey}; controls.set(context, control); }
  const participant = participants.get(options);
  if (!participant) return;
  if (participant.prepared) throw fixedError();
  participant.prepared = { context, ...target };
  participants.set(context, participant);
}
/** Capture original typed error privately before listeners/loggers see a fixed error. */
export function observeSlackIngressFailure(value: object, error: unknown): boolean {
  const control = controls.get(value);
  if (control && !control.closed) { control.failure ??= error; return true; }
  const participant = participants.get(value);
  if (!participant) return false;
  participant.failure ??= error;
  return true;
}
export function slackIngressHeldError(): Error {
  return fixedError();
}
export function isSlackNativeDispatchBusy(error: unknown): boolean {
  return error instanceof NativeDispatchBusyError;
}

export function getSlackIngressAdoptionCallback(
  context: object,
): ((target?: ChannelSourceAdoptionTarget) => Promise<void>) | undefined {
  const participant = participants.get(context);
  if (!participant) return undefined;
  return async (target) => {
    // Irreversible adoption may already exist even if readback/completion subsequently fails.
    if (participant.closed) throw fixedError();
    participant.adoptionStarted = true;
    const prepared = participant.prepared;
    const source = readChannelSourceTurnId(context);
    if (
      !target ||
      !prepared ||
      !source ||
      target.sourceTurnId !== source ||
      target.sessionKey !== prepared.sessionKey ||
      target.storePath !== prepared.storePath
    )
      throw fixedError();
    const receipt = readChannelSourceAdoptionReceipt(target);
    if (
      receipt.status !== "VERIFIED" ||
      receipt.sourceTurnId !== source ||
      receipt.sessionId !== target.sessionId ||
      receipt.sessionKey !== target.sessionKey
    )
      throw fixedError();
    const metadata = {
      digest: participant.claim.payload.digest,
      logicalSourceId: source,
      disposition: "ADOPTED",
      adoptionReceipt: receipt,
    };
    try {
      if (!(await participant.queue.complete(participant.claim, { metadata }))) throw fixedError();
      participant.completed = true;
    } catch {
      throw fixedError();
    }
  };
}

/** Exactly one claim dispatch. Settlements belong here, never to the monitor drain. */
export async function dispatchSlackIngressClaim(params: {
  claim: Claim;
  queue: SlackIngressQueue;
  dispatch: (event: SlackIngressEnvelope) => Promise<unknown>;
}): Promise<SlackIngressDispatchResult> {
  const claim = structuredClone(params.claim);
  const event = claim.payload.body.event;
  if (!event || typeof event !== "object" || Array.isArray(event))
    return { status: "HELD_UNCERTAIN", sourceId: claim.id, reason: "EVENT_SHAPE" };
  const participant: Participant = {
    claim,
    queue: params.queue,
    adoptionStarted: false,
    completed: false,
  };
  participants.set(event, participant);
  try {
    try {
      await params.dispatch({ body: claim.payload.body, ack: async () => {} });
    } catch (error) {
      participant.failure ??= error;
    }
    if (participant.completed) return { status: "ADOPTED", sourceId: claim.id };
    if (participant.adoptionStarted)
      return { status: "HELD_UNCERTAIN", sourceId: claim.id, reason: "ADOPTION_UNVERIFIED" };
    const prepared = participant.prepared;
    const source = prepared && readChannelSourceTurnId(prepared.context);
    const proof = readNativePreAdmissionRefusal(participant.failure);
    if (
      !prepared ||
      !source ||
      !proof ||
      proof.sourceTurnId !== source ||
      proof.sessionKey !== prepared.sessionKey
    ) {
      return { status: "HELD_UNCERTAIN", sourceId: claim.id, reason: "NO_PRE_ADMISSION_PROOF" };
    }
    const absence = readChannelSourcePreAdmissionAbsence({
      storePath: prepared.storePath,
      sessionKey: prepared.sessionKey,
      sourceTurnId: source,
    });
    if (
      absence.status !== "VERIFIED_ABSENT" ||
      absence.sourceTurnId !== source ||
      absence.sessionKey !== prepared.sessionKey
    ) {
      return {
        status: "HELD_UNCERTAIN",
        sourceId: claim.id,
        reason: "HISTORICAL_SOURCE_UNCERTAIN",
      };
    }
    try {
      if (
        !(await params.queue.release(claim, {
          lastError: "NATIVE_BUSY_PRE_ADMISSION_VERIFIED",
          recordAttempt: true,
        }))
      )
        throw fixedError();
    } catch {
      return { status: "HELD_UNCERTAIN", sourceId: claim.id, reason: "RELEASE_UNVERIFIED" };
    }
    return { status: "RETRY_PRE_ADMISSION", sourceId: claim.id };
  } finally {
    participant.closed = true;
    participants.delete(event);
  }
}

export function canReleaseSlackIngressSeen(value: object, error: unknown): boolean {
  const participant = participants.get(value);
  if (!participant || participant.closed || participant.adoptionStarted || !participant.prepared) return false;
  const proof = readNativePreAdmissionRefusal(error);
  return Boolean(proof && proof.sessionKey === participant.prepared.sessionKey && proof.sourceTurnId === readChannelSourceTurnId(participant.prepared.context));
}

export function isSlackIngressAdopted(value: object): boolean { return participants.get(value)?.completed === true; }

/** Only called with an exact local dedupe cleanup closure, never a queue settlement. */
export function registerSlackControlUnseen(value: object, release: () => void): void {
  const control = controls.get(value);
  if (control && !control.closed) control.releases.push(release);
}
export async function dispatchSlackControlProbe(body: unknown, dispatch: (event: SlackIngressEnvelope) => Promise<unknown>) {
  const value = body && typeof body === "object" ? body as Record<string,unknown> : undefined;
  const event = value?.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return { disposition: "UNVERIFIED" as const, responseCompleted: false };
  const control: ControlParticipant = { closed:false, releases:[] };
  controls.set(event, control);
  try {
    const result = await withNativeControlProbe(async () => { await dispatch({body,ack:async () => {}}); });
    const prepared = control.prepared;
    const receipt = result.receipt;
    if (!receipt || !prepared || receipt.sessionKey !== prepared.sessionKey || receipt.sourceTurnId !== readChannelSourceTurnId(prepared.context)) {
      return { disposition: "UNVERIFIED" as const, responseCompleted: result.responseCompleted };
    }
    if (result.disposition === "NOT_HANDLED") {
      // The actual core verified there was no control effect; undo only this probe's transient seen state.
      for (const release of control.releases) release();
    }
    return result;
  } catch { return { disposition: "UNVERIFIED" as const, responseCompleted: false }; }
  finally { control.closed = true; controls.delete(event); }
}
