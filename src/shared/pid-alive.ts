// PID liveness helpers check whether process ids still refer to active processes.
import childProcess from "node:child_process";
import fsSync from "node:fs";

const DARWIN_PS_TIMEOUT_MS = 1000;

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Check if a process is a zombie on Linux by reading /proc/<pid>/status.
 * Returns false on non-Linux platforms or if the proc file can't be read.
 */
function isZombieProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return stateMatch?.[1] === "Z";
  } catch {
    return false;
  }
}

/** Returns true only when a positive PID exists and is not a Linux zombie process. */
export function isPidAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (isZombieProcess(pid)) {
    return false;
  }
  return true;
}

/** Returns true only when the PID is invalid, missing, or known to be a Linux zombie. */
export function isPidDefinitelyDead(pid: number): boolean {
  if (!isValidPid(pid)) {
    return true;
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
  return isZombieProcess(pid);
}

// comm is truncated to 15 bytes, so match on a substring rather than equality.
const LOCK_OWNER_RUNTIME_PATTERN = /node|openclaw/i;

function readProcField(pid: number, field: "comm" | "cmdline"): string | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/${field}`, "utf8");
    const text = field === "cmdline" ? raw.replaceAll("\0", " ").trim() : raw.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Whether a live pid provably belongs to something other than an OpenClaw
 * runtime of this user - the signature of pid reuse behind a recorded lock
 * owner. Only positive proof returns true: an unreadable process, a pid this
 * process cannot classify, or a non-Linux host all report false so callers
 * keep treating the owner as a live holder.
 */
export function isForeignRuntimeOwnerPid(pid: number): boolean {
  if (!isValidPid(pid) || pid === process.pid || process.platform !== "linux") {
    return false;
  }
  let ownerUid: number;
  try {
    ownerUid = fsSync.statSync(`/proc/${pid}`).uid;
  } catch {
    return false;
  }
  const selfUid = process.getuid?.();
  if (selfUid !== undefined && ownerUid !== selfUid) {
    // The state directory is this user's; another user's process holding its
    // lock means the recorded pid was reused, not that the owner is live.
    return true;
  }
  const comm = readProcField(pid, "comm");
  if (comm !== null && LOCK_OWNER_RUNTIME_PATTERN.test(comm)) {
    return false;
  }
  const cmdline = readProcField(pid, "cmdline");
  if (cmdline === null) {
    return false;
  }
  return !LOCK_OWNER_RUNTIME_PATTERN.test(cmdline);
}

function getDarwinProcessStartTime(pid: number): number | null {
  try {
    const startedAt = childProcess
      .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: DARWIN_PS_TIMEOUT_MS,
      })
      .trim();
    // Darwin's lstart output has no timezone. Force UTC for both ps and parsing so
    // a system timezone change cannot make a live lock owner look like PID reuse.
    const startedAtMs = Date.parse(`${startedAt} UTC`);
    return Number.isFinite(startedAtMs) ? Math.floor(startedAtMs / 1000) : null;
  } catch {
    return null;
  }
}

/** Read the Linux procfs start identity used by Linux-owned runtime state. */
export function getProcessStartTime(pid: number): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEndIndex = stat.lastIndexOf(")");
    if (commEndIndex < 0) {
      return null;
    }
    // The comm field (field 2) is wrapped in parens and can contain spaces,
    // so split after the last ")" to get fields 3..N reliably.
    const afterComm = stat.slice(commEndIndex + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    // field 22 (starttime) = index 19 after the comm-split (field 3 is index 0).
    const starttime = Number(fields[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch {
    return null;
  }
}

/** Read a cross-platform process identity for filesystem lock ownership. */
export function getFileLockProcessStartTime(pid: number): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  return process.platform === "darwin" ? getDarwinProcessStartTime(pid) : getProcessStartTime(pid);
}
