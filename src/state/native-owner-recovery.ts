import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

type Claim = {
  claimId: string;
  scopeKey: string;
  epoch: number;
  fingerprint: string;
  kind: string;
};
type Identity = { pid: number; startTicks: string; bootId: string; machineId: string };
type Owner = {
  schema: "fractal-native-owner-v1";
  claim: Claim;
  databasePath: string;
  device: string;
  inode: string;
  owner: Identity;
  admittedAtMs: number;
};
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const fail = (): never => {
  throw new Error("NATIVE_OWNER_RECORD_UNVERIFIED");
};
function processStartTicks(pid: number): string {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).split(" ");
  const startTicks = fields[19];
  if (end < 0 || !startTicks || !/^(?:0|[1-9][0-9]*)$/.test(startTicks)) fail();
  return startTicks ?? fail();
}
function identity(pid: number): Identity {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const machineId = readFileSync("/etc/machine-id", "utf8").trim();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(bootId) ||
    !/^[a-f0-9]{32}$/.test(machineId)
  )
    fail();
  return { pid, startTicks: processStartTicks(pid), bootId, machineId };
}
function location(databasePath: string, claim: Claim, create = false) {
  const canonical = realpathSync(databasePath);
  const db = lstatSync(canonical);
  if (!db.isFile() || db.uid !== process.getuid?.() || db.mode & 0o077) fail();
  const directory = canonical + ".native-owners";
  if (create) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) fail();
  return {
    directory,
    filename: path.join(directory, hash(claim.claimId) + ".json"),
    canonical,
    db,
  };
}
function readPrivate(filename: string): unknown {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077 || st.size > 16384) fail();
    const buffer = Buffer.alloc(16385);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count !== st.size) fail();
    return JSON.parse(buffer.subarray(0, count).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
function flushPrivate(filename: string): void {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077) fail();
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (const directory of [path.dirname(filename), path.dirname(path.dirname(filename))]) {
    const d = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  }
}
function writePrivate(filename: string, value: unknown): void {
  const fd = openSync(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  flushPrivate(filename);
}
function readOwner(databasePath: string, claim: Claim): { record: Owner; filename: string } {
  const loc = location(databasePath, claim);
  const record = readPrivate(loc.filename) as Owner;
  if (
    !record ||
    record.schema !== "fractal-native-owner-v1" ||
    hash(record.claim) !== hash(claim) ||
    record.databasePath !== loc.canonical ||
    record.device !== String(loc.db.dev) ||
    record.inode !== String(loc.db.ino) ||
    !Number.isSafeInteger(record.admittedAtMs) ||
    record.admittedAtMs < 0 ||
    !record.owner ||
    !Number.isSafeInteger(record.owner.pid) ||
    record.owner.pid < 1 ||
    typeof record.owner.startTicks !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(record.owner.startTicks) ||
    typeof record.owner.bootId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.owner.bootId) ||
    typeof record.owner.machineId !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.owner.machineId)
  )
    fail();
  return { record, filename: loc.filename };
}
export function captureNativeOwner(databasePath: string, claim: Claim): void {
  const loc = location(databasePath, claim, true);
  const record: Owner = {
    schema: "fractal-native-owner-v1",
    claim,
    databasePath: loc.canonical,
    device: String(loc.db.dev),
    inode: String(loc.db.ino),
    owner: identity(process.pid),
    admittedAtMs: Date.now(),
  };
  try {
    writePrivate(loc.filename, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const old = readOwner(databasePath, claim).record;
    if (hash(old.owner) !== hash(record.owner)) fail();
    flushPrivate(loc.filename);
  }
}
export function inspectNativeOwner(databasePath: string, claim: Claim) {
  try {
    const { record, filename } = readOwner(databasePath, claim);
    const current = identity(process.pid);
    let liveness: "LIVE" | "DEAD" | "UNVERIFIED" = "UNVERIFIED";
    let reason = "HOST_IDENTITY_MISMATCH";
    if (record.owner.machineId === current.machineId) {
      if (record.owner.bootId !== current.bootId) {
        liveness = "DEAD";
        reason = "PREVIOUS_BOOT";
      } else {
        try {
          const observed = processStartTicks(record.owner.pid);
          liveness = observed === record.owner.startTicks ? "LIVE" : "DEAD";
          reason = liveness === "LIVE" ? "EXACT_OWNER_PRESENT" : "PID_REUSED";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            liveness = "DEAD";
            reason = "OWNER_PID_ABSENT";
          } else {
            reason = "PROCESS_OBSERVATION_UNVERIFIED";
          }
        }
      }
    }
    let deadlineAtMs: number | null = null;
    try {
      const deadline = readPrivate(filename + ".deadline") as {
        ownerHash?: string;
        deadlineAtMs?: number;
      };
      if (
        deadline.ownerHash !== hash(record) ||
        !Number.isSafeInteger(deadline.deadlineAtMs) ||
        Number(deadline.deadlineAtMs) < record.admittedAtMs
      )
        fail();
      deadlineAtMs = Number(deadline.deadlineAtMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return {
          ...claim,
          liveness: "UNVERIFIED" as const,
          reason: "DEADLINE_UNVERIFIED",
          owner: null,
        };
    }
    return {
      ...claim,
      liveness,
      reason,
      owner: { ...record.owner, admittedAtMs: record.admittedAtMs, deadlineAtMs },
    };
  } catch {
    return {
      ...claim,
      liveness: "UNVERIFIED" as const,
      reason: "OWNER_RECEIPT_UNVERIFIED",
      owner: null,
    };
  }
}
export function bindNativeOwnerDeadline(
  databasePath: string,
  claim: Claim,
  timeoutMs: number,
): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) fail();
  const { record, filename } = readOwner(databasePath, claim);
  if (hash(record.owner) !== hash(identity(process.pid))) fail();
  const deadline = {
    ownerHash: hash(record),
    deadlineAtMs: record.admittedAtMs + timeoutMs + 30000,
  };
  try {
    writePrivate(filename + ".deadline", deadline);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const old = readPrivate(filename + ".deadline") as typeof deadline;
    if (
      old.ownerHash !== deadline.ownerHash ||
      !Number.isSafeInteger(old.deadlineAtMs) ||
      old.deadlineAtMs < record.admittedAtMs
    )
      fail();
    flushPrivate(filename + ".deadline");
  }
}
export function recoverDeadNativeOwner(
  db: DatabaseSync,
  databasePath: string,
  claim: Claim,
): boolean {
  const observed = inspectNativeOwner(databasePath, claim);
  if (observed.liveness !== "DEAD") return false;
  const { record, filename } = readOwner(databasePath, claim);
  const receipt = {
    schema: "fractal-native-owner-death-v1",
    ownerHash: hash(record),
    claim,
    outcome: "failed_owner_process_dead",
    children: "unchanged",
    costs: "unassessed",
    observedAtMs: Date.now(),
    observer: identity(process.pid),
    reason: observed.reason,
  };
  let saved: unknown = receipt;
  try {
    writePrivate(filename + ".death", receipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    saved = readPrivate(filename + ".death");
    const old = saved as typeof receipt;
    if (
      old.schema !== receipt.schema ||
      old.ownerHash !== receipt.ownerHash ||
      hash(old.claim) !== hash(claim) ||
      old.outcome !== receipt.outcome ||
      old.children !== receipt.children ||
      old.costs !== receipt.costs
    )
      fail();
    flushPrivate(filename + ".death");
  }
  const result = db
    .prepare(
      "UPDATE thread_dispatch_claims SET state='TERMINAL',terminal_receipt=?,updated_at_ms=? WHERE claim_id=? AND scope_key=? AND epoch=? AND fingerprint=? AND kind='native' AND state IN ('STARTING','RUNNING','UNKNOWN')",
    )
    .run(hash(saved), Date.now(), claim.claimId, claim.scopeKey, claim.epoch, claim.fingerprint);
  return Number(result.changes) === 1;
}
