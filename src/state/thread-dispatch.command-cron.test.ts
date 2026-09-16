import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runCronCommandJob } from "../cron/command-runner.js";
import type { CronJob } from "../cron/types.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { admitThreadDispatch, dispatchHash, withThreadDispatch } from "./thread-dispatch.js";
const SQL =
  "CREATE TABLE thread_fences (\n scope_key TEXT PRIMARY KEY NOT NULL,\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n state TEXT NOT NULL CHECK(state IN ('OPEN','DRAINING','RETIRED')),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)\n) STRICT;\nCREATE TABLE thread_dispatch_claims (\n claim_id TEXT PRIMARY KEY NOT NULL,\n scope_key TEXT NOT NULL REFERENCES thread_fences(scope_key),\n epoch INTEGER NOT NULL CHECK(epoch >= 1),\n fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),\n kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),\n state TEXT NOT NULL CHECK(state IN ('STARTING','RUNNING','UNKNOWN','TERMINAL')),\n created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),\n updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),\n terminal_receipt TEXT,\n CHECK((state='TERMINAL' AND terminal_receipt IS NOT NULL AND length(terminal_receipt)=64)\n       OR (state!='TERMINAL' AND terminal_receipt IS NULL))\n) STRICT;\nCREATE INDEX thread_dispatch_open_claims ON thread_dispatch_claims(scope_key,epoch,state);\nCREATE UNIQUE INDEX thread_dispatch_one_native ON thread_dispatch_claims(scope_key) WHERE kind='native' AND state!='TERMINAL';\nPRAGMA user_version=2;\n";
it.each([0, 7])("command exit %i completes native owner but retains child UNKNOWN", async (exitCode) => {
  const dir = mkdtempSync(path.join(tmpdir(), "command-cron-claim-"));
  const databasePath = path.join(dir, "claims.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(databasePath);
  db.exec(SQL);
  chmodSync(databasePath, 0o600);
  const scope = "slack/C123/1788816064.061969";
  db.prepare("INSERT INTO thread_fences VALUES (?,1,'OPEN',0)").run(scope);
  const config = { databasePath, scopes: { [scope]: 1 }, sessionScopes: { test: scope } };
  const marker = path.join(dir, "marker");
  const job = {
    id: "command-job",
    payload: {
      kind: "command",
      argv: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(process.argv[1],'one'); process.exit(${exitCode})`,
        marker,
      ],
      timeoutSeconds: 2,
    },
  } as CronJob;
  try {
    const result = await withThreadDispatch({
      config,
      sessionKey: "test",
      operationId: "command-owner",
      kind: "native",
      identity: { jobId: job.id },
      run: () => runCronCommandJob({ job }),
      terminalReceipt: (value) => dispatchHash({ status: value.status }),
    });
    expect(result.status).toBe(exitCode === 0 ? "ok" : "error");
    expect(existsSync(marker)).toBe(true);
    expect(
      db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='native'").get()?.state,
    ).toBe("TERMINAL");
    expect(
      db.prepare("SELECT state FROM thread_dispatch_claims WHERE kind='process_child'").get()
        ?.state,
    ).toBe("UNKNOWN");
    expect(() => admitThreadDispatch(config, {
      claimId: "successor-owner",
      scopeKey: scope,
      epoch: 1,
      fingerprint: dispatchHash("successor"),
      kind: "native",
    })).not.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM thread_dispatch_claims WHERE kind='process_child' AND state='UNKNOWN'").get()?.n).toBe(1);

  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
