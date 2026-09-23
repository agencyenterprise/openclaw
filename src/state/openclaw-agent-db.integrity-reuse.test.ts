// Agent database integrity reuse tests: full checks run once per verified open file, not per connection.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  openOpenClawAgentDatabaseReader,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const integrity = vi.hoisted(() => ({ checkedPaths: [] as string[] }));

vi.mock("../infra/sqlite-integrity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-integrity.js")>();
  return {
    ...actual,
    assertSqliteIntegrity: (database: DatabaseSync, databaseLabel: string) => {
      integrity.checkedPaths.push(databaseLabel);
      return actual.assertSqliteIntegrity(database, databaseLabel);
    },
  };
});

const tempDirs: string[] = [];

function createAgentEnv(): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-agent-db-integrity-") };
}

function withConnection<T>(pathname: string, run: (db: DatabaseSync) => T): T {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function createStaleIndexDrift(pathname: string): void {
  withConnection(pathname, (db) => {
    db.exec(`
      CREATE TABLE drift_records (id INTEGER PRIMARY KEY, indexed TEXT NOT NULL, other TEXT NOT NULL);
      CREATE INDEX drift_records_value ON drift_records(indexed);
      INSERT INTO drift_records (indexed, other) VALUES ('alpha', 'zeta'), ('beta', 'eta');
    `);
    db.enableDefensive?.(false);
    db.exec("PRAGMA writable_schema = ON;");
    db.prepare(
      "UPDATE sqlite_schema SET sql = 'CREATE INDEX drift_records_value ON drift_records(other)' WHERE name = 'drift_records_value'",
    ).run();
    const { schema_version: schemaVersion } = db.prepare("PRAGMA schema_version").get() as {
      schema_version: number;
    };
    db.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  });
}

function countIntegrityChecks(pathname: string): number {
  return integrity.checkedPaths.filter((checkedPath) => checkedPath === pathname).length;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  integrity.checkedPaths.length = 0;
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("agent database integrity reuse", () => {
  it("skips the full check for extra connections while the verified writer stays open", () => {
    const env = createAgentEnv();
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(countIntegrityChecks(writer.path)).toBe(1);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      withConnection(writer.path, (db) =>
        ensureOpenClawAgentDatabaseSchema(db, { agentId: "main", env, path: writer.path }),
      );
    }

    expect(countIntegrityChecks(writer.path)).toBe(1);
  });

  it("re-checks after the writer closes and rejects damage made while it was closed", () => {
    const env = createAgentEnv();
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const pathname = writer.path;
    closeOpenClawAgentDatabasesForTest();
    createStaleIndexDrift(pathname);

    expect(() =>
      withConnection(pathname, (db) =>
        ensureOpenClawAgentDatabaseSchema(db, { agentId: "main", env, path: pathname }),
      ),
    ).toThrow(/integrity_check failed/iu);
    expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
      /integrity_check failed/iu,
    );
  });

  it("re-checks a different file that replaced the verified path", () => {
    const env = createAgentEnv();
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const replacementPath = `${writer.path}.replacement`;
    writer.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    withConnection(writer.path, (db) => {
      db.prepare("VACUUM INTO ?").run(replacementPath);
    });
    createStaleIndexDrift(replacementPath);
    fs.renameSync(replacementPath, writer.path);

    expect(() =>
      withConnection(writer.path, (db) =>
        ensureOpenClawAgentDatabaseSchema(db, { agentId: "main", env, path: writer.path }),
      ),
    ).toThrow(/integrity_check failed/iu);
    expect(countIntegrityChecks(writer.path)).toBe(2);
  });
});

describe("agent database reader", () => {
  it("opens read-only without a full check and validates owner and schema", () => {
    const env = createAgentEnv();
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const reader = openOpenClawAgentDatabaseReader({ agentId: "main", env, path: writer.path });
    try {
      expect(reader.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
      expect(() => reader.exec("DELETE FROM sessions")).toThrow(/readonly/iu);
    } finally {
      reader.close();
    }
    expect(countIntegrityChecks(writer.path)).toBe(1);
    expect(() =>
      openOpenClawAgentDatabaseReader({ agentId: "other", env, path: writer.path }),
    ).toThrow(/belongs to agent main; requested agent other/u);
  });

  it("rejects databases the writer has not migrated to the current schema", () => {
    const env = createAgentEnv();
    const pathname = path.join(env.OPENCLAW_STATE_DIR ?? "", "unmigrated.sqlite");
    withConnection(pathname, (db) => db.exec("CREATE TABLE placeholder (id INTEGER);"));

    expect(() => openOpenClawAgentDatabaseReader({ agentId: "main", env, path: pathname })).toThrow(
      /has no schema ownership metadata/u,
    );
  });
});
