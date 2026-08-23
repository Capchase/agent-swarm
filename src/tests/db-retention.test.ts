import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
  DB_RETENTION_TABLES,
  getDbRetentionStats,
  resetDbRetentionForTests,
  runDbRetentionTick,
  startDbRetention,
  stopDbRetention,
} from "../be/db-retention";
import { MAX_DB_RETENTION_DAYS, validateConfigValue } from "../be/swarm-config-guard";

const TEST_DB_PATH = "./test-db-retention.sqlite";
const NOW = new Date("2026-08-23T12:00:00.000Z");
const RETENTION_KEYS = DB_RETENTION_TABLES.map((table) => table.envKey);

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

async function insertRow(
  table: (typeof DB_RETENTION_TABLES)[number]["table"],
  id: string,
  createdAt: string,
): Promise<void> {
  const client = getDbClient();
  if (table === "session_logs") {
    await client.run(
      "INSERT INTO session_logs (id, sessionId, iteration, cli, content, lineNumber, createdAt) VALUES (?, ?, 0, 'bun', 'log', 1, ?)",
      [id, `session-${id}`, createdAt],
    );
    return;
  }
  if (table === "agent_log") {
    await client.run("INSERT INTO agent_log (id, eventType, createdAt) VALUES (?, 'test', ?)", [
      id,
      createdAt,
    ]);
    return;
  }
  await client.run(
    "INSERT INTO events (id, category, event, source, createdAt) VALUES (?, 'test', 'retention.test', 'test', ?)",
    [id, createdAt],
  );
}

async function countRows(table: (typeof DB_RETENTION_TABLES)[number]["table"]): Promise<number> {
  const row = await getDbClient().get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return row?.count ?? 0;
}

beforeAll(async () => {
  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  await resetDbRetentionForTests();
  closeDb();
  await removeDbFiles();
});

beforeEach(async () => {
  await resetDbRetentionForTests();
  for (const table of DB_RETENTION_TABLES) await getDbClient().run(`DELETE FROM ${table.table}`);
  for (const key of [...RETENTION_KEYS, "DB_RETENTION_DRY_RUN"]) delete process.env[key];
});

afterEach(async () => {
  await stopDbRetention();
});

describe("DB retention", () => {
  test("keeps the closed allowlist limited to the three approved tables", () => {
    expect(DB_RETENTION_TABLES.map((table) => table.table)).toEqual([
      "session_logs",
      "agent_log",
      "events",
    ]);
  });

  test("validates each retention setting as an integer of at least one day", () => {
    for (const key of RETENTION_KEYS) {
      expect(validateConfigValue(key, "30")).toBeNull();
      expect(validateConfigValue(key, "0")).toContain("between 1");
      expect(validateConfigValue(key, "-1")).toContain("integer");
      expect(validateConfigValue(key, "abc")).toContain("integer");
      expect(validateConfigValue(key, String(MAX_DB_RETENTION_DAYS))).toBeNull();
      expect(validateConfigValue(key, String(MAX_DB_RETENTION_DAYS + 1))).toContain("between");
    }
  });

  test("validates the dry-run setting as a strict boolean literal", () => {
    for (const value of ["true", "false", "1", "0"]) {
      expect(validateConfigValue("DB_RETENTION_DRY_RUN", value)).toBeNull();
    }
    expect(validateConfigValue("DB_RETENTION_DRY_RUN", "treu")).toContain(
      "Invalid DB_RETENTION_DRY_RUN",
    );
  });

  test("is opt-in and rejects invalid retention windows", async () => {
    for (const table of DB_RETENTION_TABLES)
      await insertRow(table.table, `${table.table}-old`, "2026-08-01T00:00:00.000Z");
    process.env.SESSION_LOG_RETENTION_DAYS = "0";
    process.env.AGENT_LOG_RETENTION_DAYS = "abc";
    process.env.EVENTS_RETENTION_DAYS = "-1";

    await runDbRetentionTick({ now: NOW });

    for (const table of DB_RETENTION_TABLES) expect(await countRows(table.table)).toBe(1);
  });

  test("sweeps only enabled tables and preserves rows at or after the ISO cutoff", async () => {
    const cutoff = "2026-08-22T12:00:00.000Z";
    for (const table of DB_RETENTION_TABLES) {
      await insertRow(table.table, `${table.table}-old`, "2026-08-22T11:59:59.999Z");
      await insertRow(table.table, `${table.table}-cutoff`, cutoff);
    }
    process.env.SESSION_LOG_RETENTION_DAYS = "1";

    await runDbRetentionTick({ now: NOW });

    expect(await countRows("session_logs")).toBe(1);
    expect(await countRows("agent_log")).toBe(2);
    expect(await countRows("events")).toBe(2);
    expect(await getDbRetentionStats().sessionLogs).toMatchObject({
      rowsDeleted: 1,
      dryRun: false,
    });
  });

  test("never deletes old rows from critical tables", async () => {
    const old = "2020-01-01T00:00:00.000Z";
    const client = getDbClient();
    await client.run(
      "INSERT INTO agents (id, name, status, createdAt, lastUpdatedAt) VALUES ('critical-agent', 'Critical', 'idle', ?, ?)",
      [old, old],
    );
    await client.run(
      "INSERT INTO agent_tasks (id, task, status, source, createdAt, lastUpdatedAt) VALUES ('critical-task', 'keep', 'completed', 'mcp', ?, ?)",
      [old, old],
    );
    await client.run(
      "INSERT INTO agent_memory (id, scope, name, content, source, createdAt, accessedAt) VALUES ('critical-memory', 'swarm', 'keep', 'keep', 'manual', ?, ?)",
      [old, old],
    );
    await client.run(
      "INSERT INTO permission_audit (id, ts, principalType, verb, decision, source) VALUES ('critical-audit', ?, 'operator', 'config.read', 'allow', 'http')",
      [old],
    );
    for (const table of DB_RETENTION_TABLES) process.env[table.envKey] = "1";

    await runDbRetentionTick({ now: NOW });

    for (const table of ["agents", "agent_tasks", "agent_memory", "permission_audit"]) {
      const row = await client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE id LIKE 'critical-%'`,
      );
      expect(row?.count).toBe(1);
    }
  });

  test("uses bounded batches and continues on the next tick", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    for (let index = 0; index < 5; index++) {
      await insertRow("session_logs", `old-${index}`, "2026-08-01T00:00:00.000Z");
    }

    await runDbRetentionTick({ now: NOW, batchSize: 2, perTableBatchCap: 1 });
    expect(await countRows("session_logs")).toBe(3);
    await runDbRetentionTick({ now: NOW, batchSize: 2, perTableBatchCap: 1 });
    expect(await countRows("session_logs")).toBe(1);
    await runDbRetentionTick({ now: NOW, batchSize: 2, perTableBatchCap: 1 });
    expect(await countRows("session_logs")).toBe(0);
    expect(getDbRetentionStats().sessionLogs).toMatchObject({
      rowsDeleted: 1,
      batches: 1,
      cumulativeRowsDeleted: 5,
    });
  });

  test("dry run reports candidates without deleting any enabled table rows", async () => {
    for (const table of DB_RETENTION_TABLES) {
      process.env[table.envKey] = "1";
      await insertRow(table.table, `${table.table}-old`, "2026-08-01T00:00:00.000Z");
    }
    process.env.DB_RETENTION_DRY_RUN = "true";

    await runDbRetentionTick({ now: NOW });

    for (const table of DB_RETENTION_TABLES) expect(await countRows(table.table)).toBe(1);
    expect(getDbRetentionStats()).toMatchObject({
      sessionLogs: { rowsDeleted: 1, dryRun: true },
      agentLog: { rowsDeleted: 1, dryRun: true },
      events: { rowsDeleted: 1, dryRun: true },
    });
  });

  test("uses dry run when the deployed dry-run value is invalid", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_DRY_RUN = "treu";
    await insertRow("session_logs", "invalid-dry-run-old", "2026-08-01T00:00:00.000Z");

    await runDbRetentionTick({ now: NOW });

    expect(await countRows("session_logs")).toBe(1);
    expect(getDbRetentionStats().sessionLogs).toMatchObject({ rowsDeleted: 1, dryRun: true });
  });

  test("dry run reports an exact count above the former safety cap", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_DRY_RUN = "true";
    await getDbClient().run(
      `WITH RECURSIVE candidates(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM candidates WHERE value < 250001
       )
       INSERT INTO session_logs (id, sessionId, iteration, cli, content, lineNumber, createdAt)
       SELECT 'dry-' || value, 'dry-session', 0, 'bun', 'log', value, '2026-08-01T00:00:00.000Z'
       FROM candidates`,
    );

    await runDbRetentionTick({ now: NOW });

    expect(getDbRetentionStats().sessionLogs?.rowsDeleted).toBe(250_001);
    expect(await countRows("session_logs")).toBe(250_001);
  });

  test("dry run scans sparse tables in bounded keyset pages when no rows are eligible", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_DRY_RUN = "true";
    await getDbClient().run(
      `WITH RECURSIVE recent(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM recent WHERE value < 10000
       )
       INSERT INTO session_logs (id, sessionId, iteration, cli, content, lineNumber, createdAt)
       SELECT 'recent-' || printf('%05d', value), 'recent-session', 0, 'bun', 'log', value,
              '2026-08-23T11:59:59.999Z'
       FROM recent`,
    );

    await runDbRetentionTick({ now: NOW, batchSize: 100, wallClockCapMs: 1 });

    expect(getDbRetentionStats().sessionLogs).toBeUndefined();
    expect(await countRows("session_logs")).toBe(10_000);
  });

  test("stops a dry-run count when its wall-clock budget expires", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_DRY_RUN = "true";
    await getDbClient().run(
      `WITH RECURSIVE candidates(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM candidates WHERE value < 1000
       )
       INSERT INTO session_logs (id, sessionId, iteration, cli, content, lineNumber, createdAt)
       SELECT 'deadline-' || value, 'deadline-session', 0, 'bun', 'log', value, '2026-08-01T00:00:00.000Z'
       FROM candidates`,
    );

    const startedAt = Date.now();
    await runDbRetentionTick({ now: NOW, batchSize: 1, wallClockCapMs: 10 });

    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(await countRows("session_logs")).toBe(1000);
    expect(getDbRetentionStats().sessionLogs).toBeUndefined();
  });

  test("rejects an excessive window without aborting later table sweeps", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = String(MAX_DB_RETENTION_DAYS + 1);
    process.env.AGENT_LOG_RETENTION_DAYS = "1";
    await insertRow("session_logs", "oversized-window", "2026-08-01T00:00:00.000Z");
    await insertRow("agent_log", "valid-window", "2026-08-01T00:00:00.000Z");

    await runDbRetentionTick({ now: NOW });

    expect(await countRows("session_logs")).toBe(1);
    expect(await countRows("agent_log")).toBe(0);
  });

  test("shutdown cancels an in-flight sweep between batches and waits for it", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    for (let index = 0; index < 100; index++) {
      await insertRow("session_logs", `shutdown-${index}`, "2026-08-01T00:00:00.000Z");
    }

    const tick = runDbRetentionTick({ now: NOW, batchSize: 1, perTableBatchCap: 100 });
    while ((await countRows("session_logs")) === 100) {
      await Bun.sleep(1);
    }
    await stopDbRetention();
    await tick;

    const remaining = await countRows("session_logs");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(100);
    await Bun.sleep(20);
    expect(await countRows("session_logs")).toBe(remaining);
  });

  test("runs the first lifecycle tick immediately and can stop cleanly", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    await insertRow("session_logs", "lifecycle-old", "2026-08-01T00:00:00.000Z");

    await startDbRetention(60_000);

    expect(await countRows("session_logs")).toBe(0);
    await stopDbRetention();
  });
});
