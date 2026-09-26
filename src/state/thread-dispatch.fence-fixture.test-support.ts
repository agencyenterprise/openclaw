import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginNativeCleanupAttempt,
  withNativeCleanupTracking,
} from "../agents/embedded-agent-runner/native-cleanup-proof.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { DispatchConfig } from "./thread-dispatch.js";

const RUNNER_FIXTURE = new URL(
  "../agents/embedded-agent-runner/run.thread-dispatch.test.ts",
  import.meta.url,
);
/** The frozen V2 fence schema from the thread-dispatch runner fixture, not a relaxed test copy. */
function frozenFenceSchema(): string {
  const literal = readFileSync(RUNNER_FIXTURE, "utf8").match(
    /const fenceSql =\s*("(?:[^"\\]|\\.)*");/,
  )?.[1];
  if (!literal) {
    throw new Error(`fenceSql fixture not found in ${RUNNER_FIXTURE.pathname}`);
  }
  return JSON.parse(literal) as string;
}

const roots: string[] = [];
export function removeFenceFixtures(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One OPEN Slack thread scope on a real fence database, mapped from session key "session". */
export function fenceFixture() {
  const root = mkdtempSync(join(tmpdir(), "fence-fixture-"));
  roots.push(root);
  const databasePath = join(root, "state.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(frozenFenceSchema());
  chmodSync(databasePath, 0o600);
  const scope = "slack/C123/1788816064.061969";
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
  const config: DispatchConfig = {
    databasePath,
    scopes: { [scope]: 1 },
    sessionScopes: { session: scope },
  };
  const turn = (source: string) => ({
    config,
    sessionKey: "session",
    sourceTurnId: `channel-user:v1:${source.repeat(64)}`,
    prompt: "prompt",
  });
  const claims = () =>
    db
      .prepare("SELECT claim_id AS claimId, kind, state FROM thread_dispatch_claims ORDER BY rowid")
      .all() as { claimId: string; kind: string; state: string }[];
  const nativeStates = () =>
    claims()
      .filter((claim) => claim.kind === "native")
      .map((claim) => claim.state);
  return { db, config, scope, turn, claims, nativeStates };
}

export const cleanupIdentity = "cleanup-identity";
/** A run result whose cleanup the real native tracker verified. */
export function verifiedResult(): Promise<{ meta: Record<string, unknown> }> {
  return withNativeCleanupTracking(cleanupIdentity, async () => {
    beginNativeCleanupAttempt()(true);
    return { meta: {} };
  });
}
