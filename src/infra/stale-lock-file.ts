// Determines whether persisted lock-file owners are stale.
import {
  getFileLockProcessStartTime as defaultGetProcessStartTime,
  isPidDefinitelyDead as defaultIsPidDefinitelyDead,
} from "../shared/pid-alive.js";

type LockFileOwnerPayload = {
  pid?: number;
  createdAt?: string;
  starttime?: number;
};

function readLockFileOwnerPayload(
  payload: Record<string, unknown> | null,
): LockFileOwnerPayload | null {
  if (!payload) {
    return null;
  }
  return {
    pid:
      typeof payload.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0
        ? payload.pid
        : undefined,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
    starttime:
      typeof payload.starttime === "number" &&
      Number.isInteger(payload.starttime) &&
      payload.starttime >= 0
        ? payload.starttime
        : undefined,
  };
}

export function isLockOwnerDefinitelyStale(params: {
  payload: Record<string, unknown> | null;
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
}): boolean {
  const payload = readLockFileOwnerPayload(params.payload);
  if (payload?.pid) {
    // Timestamp age alone cannot prove the owner stopped writing. Only a
    // mismatched process start time proves PID reuse while the PID is alive.
    if (payload.starttime !== undefined) {
      const currentStarttime = (params.getProcessStartTime ?? defaultGetProcessStartTime)(
        payload.pid,
      );
      const normalizedStored =
        process.platform === "darwin" && payload.starttime > 10_000_000_000
          ? Math.floor(payload.starttime / 1_000_000)
          : payload.starttime;
      if (currentStarttime !== null && currentStarttime !== normalizedStored) {
        return true;
      }
    }
    return (params.isPidDefinitelyDead ?? defaultIsPidDefinitelyDead)(payload.pid);
  }
  // The sidecar is created before its owner payload is written. Without a PID,
  // age cannot distinguish a crashed writer from a suspended live writer.
  return false;
}

/**
 * A lock sidecar is created before its owner payload is written, so a sidecar
 * that names no owner is either microseconds old or abandoned. Nothing ever
 * releases an abandoned one: the writer that created it died (or was killed)
 * between creating the file and writing its payload, or wrote a truncated
 * payload. Past the grace window - orders of magnitude wider than the two
 * adjacent synchronous syscalls that open the window - an owner-less sidecar
 * can only be abandoned, and holding it forever wedges every future acquirer.
 */
export function isAbandonedOwnerlessLock(params: {
  payload: Record<string, unknown> | null;
  ageMs: number;
  graceMs: number;
}): boolean {
  if (readLockFileOwnerPayload(params.payload)?.pid) {
    return false;
  }
  return params.ageMs >= params.graceMs;
}

export function shouldRemoveDeadOwnerOrExpiredLock(params: {
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs?: number;
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
}): boolean {
  const payload = readLockFileOwnerPayload(params.payload);
  if (payload?.pid) {
    return isLockOwnerDefinitelyStale({
      payload: params.payload,
      isPidDefinitelyDead: params.isPidDefinitelyDead,
      getProcessStartTime: params.getProcessStartTime,
    });
  }
  if (!payload?.createdAt) {
    return false;
  }
  const createdAt = Date.parse(payload.createdAt);
  return !Number.isFinite(createdAt) || (params.nowMs ?? Date.now()) - createdAt > params.staleMs;
}
