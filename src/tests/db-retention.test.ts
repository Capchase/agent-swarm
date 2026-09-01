import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
  _getLastSweepOrderForTests,
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
const TUNING_KEYS = [
  "DB_RETENTION_TICK_BUDGET_MS",
  "DB_RETENTION_CATCHUP_INTERVAL_MS",
  "DB_RETENTION_MAX_STATEMENT_MS",
];

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

/** Bulk-insert `count` session_logs rows via a recursive CTE — far cheaper than one INSERT per row. */
async function bulkInsertSessionLogs(
  idPrefix: string,
  count: number,
  createdAt: string,
): Promise<void> {
  await getDbClient().run(
    `WITH RECURSIVE candidates(value) AS (
       SELECT 1
       UNION ALL
       SELECT value + 1 FROM candidates WHERE value < ${count}
     )
     INSERT INTO session_logs (id, sessionId, iteration, cli, content, lineNumber, createdAt)
     SELECT '${idPrefix}-' || value, '${idPrefix}-session', 0, 'bun', 'log', value, ?
     FROM candidates`,
    [createdAt],
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
  for (const key of [...RETENTION_KEYS, "DB_RETENTION_DRY_RUN", ...TUNING_KEYS])
    delete process.env[key];
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

  test("dry run reports candidates without deleting any enabled table rows", async () => {
    for (const table of DB_RETENTION_TABLES) {
      process.env[table.envKey] = "1";
      await insertRow(table.table, `${table.table}-old`, "2026-08-01T00:00:00.000Z");
    }
    process.env.DB_RETENTION_DRY_RUN = "true";

    await runDbRetentionTick({ now: NOW });

    for (const table of DB_RETENTION_TABLES) expect(await countRows(table.table)).toBe(1);
    // A dry run is a single indexed COUNT(*): rowsDeleted is always 0, and the
    // candidate count lives in backlogRemaining instead.
    expect(getDbRetentionStats()).toMatchObject({
      sessionLogs: { rowsDeleted: 0, backlogRemaining: 1, dryRun: true },
      agentLog: { rowsDeleted: 0, backlogRemaining: 1, dryRun: true },
      events: { rowsDeleted: 0, backlogRemaining: 1, dryRun: true },
    });
  });

  test("uses dry run when the deployed dry-run value is invalid", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_DRY_RUN = "treu";
    await insertRow("session_logs", "invalid-dry-run-old", "2026-08-01T00:00:00.000Z");

    await runDbRetentionTick({ now: NOW });

    expect(await countRows("session_logs")).toBe(1);
    expect(getDbRetentionStats().sessionLogs).toMatchObject({
      rowsDeleted: 0,
      backlogRemaining: 1,
      dryRun: true,
    });
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
    // Large enough that, even with the adaptive sizer ramping toward its
    // 2,000-row ceiling, dozens of batches (each separated by a 25ms yield)
    // are needed — giving the polling loop below a wide window to observe a
    // partial delete and interrupt before the sweep fully drains.
    await bulkInsertSessionLogs("shutdown", 50_000, "2026-08-01T00:00:00.000Z");

    const tick = runDbRetentionTick({ now: NOW });
    while ((await countRows("session_logs")) === 50_000) {
      await Bun.sleep(1);
    }
    await stopDbRetention();
    await tick;

    const remaining = await countRows("session_logs");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(50_000);
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

  test("dry run is one indexed count", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_DRY_RUN = "true";
    await bulkInsertSessionLogs("dry-below", 20_000, "2026-08-01T00:00:00.000Z");
    await bulkInsertSessionLogs("dry-above", 30_000, "2026-08-23T11:59:59.999Z");

    await runDbRetentionTick({ now: NOW });

    expect(getDbRetentionStats().sessionLogs).toMatchObject({
      rowsDeleted: 0,
      backlogRemaining: 20_000,
      dryRun: true,
    });
  });

  test("convergence: drains the backlog without a tick decaying below the previous one", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    await bulkInsertSessionLogs("converge", 30_000, "2026-08-01T00:00:00.000Z");

    const perTickDeletes: number[] = [];
    for (let ticks = 0; ticks < 20; ticks++) {
      await runDbRetentionTick({ now: NOW });
      const stats = getDbRetentionStats().sessionLogs;
      perTickDeletes.push(stats?.rowsDeleted ?? 0);
      if (stats?.drained) break;
    }

    expect(await countRows("session_logs")).toBe(0);
    expect(getDbRetentionStats().sessionLogs?.drained).toBe(true);
    // Direct regression test for the old geometric decay (55,181 -> 340 over
    // 5 ticks): once the sweep is running, only the final partial tick may
    // delete fewer rows than the one before it.
    for (let i = 1; i < perTickDeletes.length - 1; i++) {
      expect(perTickDeletes[i]).toBeGreaterThanOrEqual(perTickDeletes[i - 1]!);
    }
  });

  test("delete plan uses the index", async () => {
    for (const table of DB_RETENTION_TABLES) {
      const plan = await getDbClient().query<{ detail: string }>(
        `EXPLAIN QUERY PLAN DELETE FROM ${table.table} WHERE rowid IN (
           SELECT rowid FROM ${table.table} WHERE ${table.timeColumn} < ? ORDER BY ${table.timeColumn} LIMIT 500
         )`,
        ["2026-08-01T00:00:00.000Z"],
      );
      const detail = plan.map((row) => row.detail).join("\n");
      expect(detail).toContain(`USING COVERING INDEX idx_${table.table}_createdAt`);
      expect(detail).not.toContain(`SCAN ${table.table}`);
    }
  });

  test("no starvation: an oversized session_logs backlog does not block the other tables", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.AGENT_LOG_RETENTION_DAYS = "1";
    process.env.EVENTS_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_TICK_BUDGET_MS = "1000"; // minimum allowed budget

    await bulkInsertSessionLogs("starve", 200_000, "2026-08-01T00:00:00.000Z");
    await insertRow("agent_log", "agent-log-1", "2026-08-01T00:00:00.000Z");
    await insertRow("events", "events-1", "2026-08-01T00:00:00.000Z");

    await runDbRetentionTick({ now: NOW });

    expect(getDbRetentionStats().agentLog?.batches).toBeGreaterThanOrEqual(1);
    expect(getDbRetentionStats().events?.batches).toBeGreaterThanOrEqual(1);
  });

  test("budget division: the tick budget splits evenly across enabled tables", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.AGENT_LOG_RETENTION_DAYS = "1";
    process.env.EVENTS_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_TICK_BUDGET_MS = "3000";
    for (const table of DB_RETENTION_TABLES) {
      await insertRow(table.table, `${table.table}-budget`, "2026-08-01T00:00:00.000Z");
    }

    await runDbRetentionTick({ now: NOW });

    const stats = getDbRetentionStats();
    const durations = [
      stats.sessionLogs?.durationMs ?? 0,
      stats.agentLog?.durationMs ?? 0,
      stats.events?.durationMs ?? 0,
    ];
    // Generous ceiling for one DELETE/COUNT statement under test-machine load.
    const STATEMENT_SLOP_MS = 200;
    for (const duration of durations) {
      expect(duration).toBeLessThanOrEqual(1000 + STATEMENT_SLOP_MS);
    }
    expect(durations.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3000 + STATEMENT_SLOP_MS);
  });

  test("rotation: each table sweeps first across an equal share of ticks", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.AGENT_LOG_RETENTION_DAYS = "1";
    process.env.EVENTS_RETENTION_DAYS = "1";

    const firstCounts: Partial<Record<string, number>> = {};
    for (let tick = 0; tick < 6; tick++) {
      await runDbRetentionTick({ now: NOW });
      const order = _getLastSweepOrderForTests();
      const first = order[0]!;
      firstCounts[first] = (firstCounts[first] ?? 0) + 1;
    }

    for (const table of DB_RETENTION_TABLES) {
      expect(firstCounts[table.metricsKey]).toBe(2);
    }
  });

  test("failure writes a stats record", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    const client = getDbClient();
    await client.run("ALTER TABLE session_logs RENAME TO session_logs_test_hidden");
    try {
      await runDbRetentionTick({ now: NOW });
    } finally {
      await client.run("ALTER TABLE session_logs_test_hidden RENAME TO session_logs");
    }

    const stats = getDbRetentionStats().sessionLogs;
    expect(stats).not.toBeUndefined();
    expect(stats?.outcome).toBe("error");
    expect(stats?.lastError).toBeTruthy();
  });

  test("adaptive batch size reaches the ceiling under a permissive target", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_MAX_STATEMENT_MS = "5000";
    await bulkInsertSessionLogs("ceiling", 50_000, "2026-08-01T00:00:00.000Z");

    await runDbRetentionTick({ now: NOW });

    expect(getDbRetentionStats().sessionLogs?.batchSize).toBe(2000);
  });

  // A deterministic "reaches exactly the floor (50)" assertion is not
  // reproducible on fast test hardware: DB_RETENTION_MAX_STATEMENT_MS's valid
  // floor is 25ms (Section 5 of the implementation plan; readBoundedIntEnv
  // falls back to the 250ms default for the plan's literal "1", since 1 is
  // out of range), and a single autocommit DELETE against this table
  // typically completes in 1-30ms regardless of batch size — measured
  // directly (performance.now(), via the same client.run seam sweepTable
  // uses): session_logs batch=500 -> 1.5-29ms, batch=50 -> ~0.25-0.33ms,
  // events (7 indexes) batch=2000 -> 10-56ms. Whether any given statement
  // crosses even the 25ms minimum is inherently noisy, so a run can shrink,
  // hold, or grow on any iteration and is not guaranteed to visit every value
  // down to 50. What IS deterministic and worth pinning: the size never
  // leaves [50, 2000] no matter how many shrink/grow steps occur. A custom
  // timeout is required — 5 ticks at a 1000ms budget each exceeds bun:test's
  // default 5000ms, and a timed-out test's dangling background loop was
  // observed to corrupt later tests' module state.
  test("adaptive batch size never leaves [floor, ceiling] under a strict target", async () => {
    process.env.EVENTS_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_MAX_STATEMENT_MS = "25"; // the valid minimum (Section 5)
    process.env.DB_RETENTION_TICK_BUDGET_MS = "1000"; // minimum allowed budget, forces many ticks
    await getDbClient().run(
      `WITH RECURSIVE candidates(value) AS (
           SELECT 1
           UNION ALL
           SELECT value + 1 FROM candidates WHERE value < 500000
         )
         INSERT INTO events (id, category, event, source, createdAt)
         SELECT 'floor-' || value, 'test', 'retention.test', 'test', '2026-08-01T00:00:00.000Z'
         FROM candidates`,
    );

    const sizes: number[] = [];
    for (let ticks = 0; ticks < 5; ticks++) {
      await runDbRetentionTick({ now: NOW });
      const stats = getDbRetentionStats().events;
      if (stats?.batchSize !== undefined) sizes.push(stats.batchSize);
      if (stats?.drained) break;
    }

    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(50);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2000);
  }, 10_000);

  test("a table the tick budget never reached still arms catch-up", async () => {
    // Regression: pass 1 breaks out at the global deadline, so tables behind a
    // slow leading one are never entered. They used to be absent from the
    // undrained set, which left catch-up unarmed and made them wait for the
    // hourly timer.
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.AGENT_LOG_RETENTION_DAYS = "1";
    process.env.EVENTS_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_TICK_BUDGET_MS = "1000"; // minimum allowed budget
    process.env.DB_RETENTION_CATCHUP_INTERVAL_MS = "5000"; // minimum allowed interval

    // tickCount becomes 1 on the tick below, so the rotation starts at index 1:
    // [agent_log, events, session_logs].
    const client = getDbClient();
    // One row under the initial batch size, so agent_log drains in a single
    // batch and never adds ITSELF to the undrained set. Catch-up can then only
    // be armed by the tables pass 1 skipped — which is what this test is for.
    for (let i = 0; i < 499; i++) {
      await insertRow("agent_log", `slow-batch-${i}`, "2026-08-01T00:00:00.000Z");
    }
    await insertRow("events", "skipped-event", "2026-08-01T00:00:00.000Z");
    await insertRow("session_logs", "skipped-log", "2026-08-01T00:00:00.000Z");

    // Make agent_log's first DELETE batch overrun the whole tick budget on its
    // own. Deterministic, not a sleep: every deleted row drives one unindexed
    // LIKE scan over a 90k-row probe table that retention never touches. That
    // measured ~2.9s for the batch against a 1000ms budget on CI-class
    // hardware, so the overrun has roughly 3x of headroom.
    await client.run(
      "CREATE TABLE IF NOT EXISTS retention_slow_probe (id INTEGER PRIMARY KEY, payload TEXT)",
    );
    await client.run("DELETE FROM retention_slow_probe");
    await client.run(
      `WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 90000)
       INSERT INTO retention_slow_probe (id, payload) SELECT value, 'payload-' || value FROM n`,
    );
    await client.run(
      `CREATE TRIGGER agent_log_slow_probe BEFORE DELETE ON agent_log
       BEGIN SELECT COUNT(*) FROM retention_slow_probe WHERE payload LIKE '%no-such-needle%'; END`,
    );
    try {
      await runDbRetentionTick({ now: NOW });
    } finally {
      // Dropping the trigger is what matters — it is the only thing that makes
      // a later agent_log DELETE slow. The probe TABLE stays: bun:sqlite's
      // cached DELETE statement still references it through the trigger, so
      // DROP TABLE raises SQLITE_LOCKED. It is not a retention table, and
      // afterAll deletes the whole test database anyway.
      await client.run("DROP TRIGGER agent_log_slow_probe");
    }

    // The budget is gone by the time pass 1 reaches the tables behind
    // agent_log: they are never entered, so they have no stats at all.
    expect(_getLastSweepOrderForTests()[0]).toBe("agentLog");
    expect(getDbRetentionStats().sessionLogs).toBeUndefined();
    expect(await countRows("session_logs")).toBe(1);

    // Catch-up must still be armed for them. The trigger is gone, so the
    // catch-up tick (~5s out, plus its own budget) drains what pass 1 skipped.
    await Bun.sleep(9_000);
    expect(getDbRetentionStats().sessionLogs?.rowsDeleted).toBe(1);
    expect(await countRows("session_logs")).toBe(0);
  }, 40_000);

  test("catch-up scheduling runs a second tick without waiting for the hourly interval, and shutdown cancels a pending one", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "1";
    process.env.DB_RETENTION_TICK_BUDGET_MS = "1000"; // minimum allowed budget
    process.env.DB_RETENTION_CATCHUP_INTERVAL_MS = "5000"; // minimum allowed interval
    await bulkInsertSessionLogs("catchup", 200_000, "2026-08-01T00:00:00.000Z");

    await runDbRetentionTick({ now: NOW });
    expect(getDbRetentionStats().sessionLogs?.drained).toBe(false);
    const afterFirstTick = getDbRetentionStats().sessionLogs?.at;

    // A catch-up tick is armed for ~5s from now, and (given the same 1000ms
    // budget) needs up to another ~1s to complete and write its stats
    // record — wait past both, plus a safety margin, to confirm it ran on
    // its own, without a manual runDbRetentionTick call and without waiting
    // for the (much longer) hourly interval.
    await Bun.sleep(7_500);
    const afterCatchup = getDbRetentionStats().sessionLogs?.at;
    expect(afterCatchup).not.toBe(afterFirstTick);

    if (getDbRetentionStats().sessionLogs?.drained === false) {
      // Another catch-up timer is now pending from the tick above; stop it
      // before it fires and confirm it never runs.
      await stopDbRetention();
      const afterStop = getDbRetentionStats().sessionLogs?.at;
      await Bun.sleep(7_500);
      expect(getDbRetentionStats().sessionLogs?.at).toBe(afterStop);
    }
  }, 25_000);
});
