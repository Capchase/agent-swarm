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
  resetDbRetentionForTests();
  closeDb();
  await removeDbFiles();
});

beforeEach(async () => {
  resetDbRetentionForTests();
  for (const table of DB_RETENTION_TABLES) await getDbClient().run(`DELETE FROM ${table.table}`);
  for (const key of [...RETENTION_KEYS, "DB_RETENTION_DRY_RUN"]) delete process.env[key];
});

afterEach(() => {
  stopDbRetention();
});

describe("DB retention", () => {
  test("keeps the closed allowlist limited to the three approved tables", () => {
    expect(DB_RETENTION_TABLES.map((table) => table.table)).toEqual([
      "session_logs",
      "agent_log",
      "events",
    ]);
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

  test("runs the first lifecycle tick immediately and can stop cleanly", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    await insertRow("session_logs", "lifecycle-old", "2026-08-01T00:00:00.000Z");

    await startDbRetention(60_000);

    expect(await countRows("session_logs")).toBe(0);
    stopDbRetention();
  });
});
