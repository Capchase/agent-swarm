import { AsyncLocalStorage } from "node:async_hooks";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { getDbClient } from "./db";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 5_000;
const PER_TABLE_BATCH_CAP = 40;
const WALL_CLOCK_CAP_MS = 60_000;
const DRY_RUN_COUNT_LIMIT = 250_000;
const YIELD_MS = 5;

/**
 * This is deliberately a closed list. Neither table nor column names may come
 * from operator configuration: a retention policy must never target a table
 * that code review has not explicitly approved as safe to delete from.
 */
export const DB_RETENTION_TABLES = [
  {
    table: "session_logs",
    timeColumn: "createdAt",
    envKey: "SESSION_LOG_RETENTION_DAYS",
    metricsKey: "sessionLogs",
  },
  {
    table: "agent_log",
    timeColumn: "createdAt",
    envKey: "AGENT_LOG_RETENTION_DAYS",
    metricsKey: "agentLog",
  },
  {
    table: "events",
    timeColumn: "createdAt",
    envKey: "EVENTS_RETENTION_DAYS",
    metricsKey: "events",
  },
] as const;

type RetentionTable = (typeof DB_RETENTION_TABLES)[number];
type RetentionMetricsKey = RetentionTable["metricsKey"];

export type DbRetentionTableStats = {
  at: string;
  /** Deleted rows, or rows that would be deleted when dryRun is true. */
  rowsDeleted: number;
  batches: number;
  durationMs: number;
  dryRun: boolean;
  cumulativeRowsDeleted: number;
};

export type DbRetentionStats = Partial<Record<RetentionMetricsKey, DbRetentionTableStats>>;

/** Test-only controls; production callers always use the bounded defaults above. */
export type DbRetentionTickOptions = {
  now?: Date;
  batchSize?: number;
  perTableBatchCap?: number;
  wallClockCapMs?: number;
};

let retentionTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;
let retentionStats: DbRetentionStats = {};
let cumulativeRowsDeleted: Partial<Record<RetentionMetricsKey, number>> = {};

// Timers must not inherit an open database transaction from their caller.
const scheduleContextFree = AsyncLocalStorage.snapshot();

function readPositiveIntEnv(key: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, YIELD_MS));
}

function retentionDays(table: RetentionTable): number | null {
  return readPositiveIntEnv(table.envKey);
}

async function sweepTable(
  table: RetentionTable,
  cutoff: string,
  dryRun: boolean,
  deadline: number,
  batchSize: number,
  perTableBatchCap: number,
): Promise<{ rowsDeleted: number; batches: number }> {
  const client = getDbClient();
  if (dryRun) {
    const row = await client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM (SELECT id FROM ${table.table} WHERE ${table.timeColumn} < ? LIMIT ?)`,
      [cutoff, DRY_RUN_COUNT_LIMIT],
    );
    return { rowsDeleted: row?.count ?? 0, batches: 0 };
  }

  let rowsDeleted = 0;
  let batches = 0;
  while (batches < perTableBatchCap && Date.now() < deadline) {
    // The identifiers come only from DB_RETENTION_TABLES. This stays one
    // top-level statement so DbClient's cross-process SQLITE_BUSY retry applies.
    const result = await client.run(
      `DELETE FROM ${table.table}
       WHERE id IN (SELECT id FROM ${table.table} WHERE ${table.timeColumn} < ? LIMIT ?)`,
      [cutoff, batchSize],
    );
    rowsDeleted += result.changes;
    batches += 1;
    if (result.changes < batchSize) break;
    await yieldTick();
  }
  return { rowsDeleted, batches };
}

/** Run one bounded sweep over every enabled table. Failures are isolated per table. */
export async function runDbRetentionTick(options: DbRetentionTickOptions = {}): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  const tickStartedAt = Date.now();
  const cutoffBase = options.now ?? new Date(tickStartedAt);
  const dryRun = isEnvFlagEnabled("DB_RETENTION_DRY_RUN", false);
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const perTableBatchCap = options.perTableBatchCap ?? PER_TABLE_BATCH_CAP;
  const deadline = tickStartedAt + (options.wallClockCapMs ?? WALL_CLOCK_CAP_MS);

  try {
    for (const table of DB_RETENTION_TABLES) {
      if (Date.now() >= deadline) break;
      const days = retentionDays(table);
      if (days === null) continue;

      const startedAt = Date.now();
      const cutoff = new Date(cutoffBase.getTime() - days * DAY_MS).toISOString();
      try {
        const result = await sweepTable(
          table,
          cutoff,
          dryRun,
          deadline,
          batchSize,
          perTableBatchCap,
        );
        const cumulative =
          (cumulativeRowsDeleted[table.metricsKey] ?? 0) + (dryRun ? 0 : result.rowsDeleted);
        cumulativeRowsDeleted[table.metricsKey] = cumulative;
        retentionStats[table.metricsKey] = {
          at: new Date().toISOString(),
          rowsDeleted: result.rowsDeleted,
          batches: result.batches,
          durationMs: Date.now() - startedAt,
          dryRun,
          cumulativeRowsDeleted: cumulative,
        };
        console.log(
          `[db-retention] ${table.table}: ${dryRun ? "would delete" : "deleted"} ${result.rowsDeleted} row(s) in ${result.batches} batch(es)`,
        );
      } catch (err) {
        console.error(`[db-retention] ${table.table} sweep failed:`, (err as Error).message);
      }
    }

    try {
      // Harmless when auto_vacuum is not INCREMENTAL; never run a blocking VACUUM here.
      await getDbClient().run("PRAGMA incremental_vacuum(2000)");
    } catch (err) {
      console.error("[db-retention] incremental vacuum failed:", (err as Error).message);
    }
  } finally {
    tickInFlight = false;
  }
}

export function getDbRetentionStats(): DbRetentionStats {
  return { ...retentionStats };
}

/** Start the hourly sweep. The first tick runs before the API begins serving traffic. */
export async function startDbRetention(intervalMs = RETENTION_INTERVAL_MS): Promise<void> {
  if (retentionTimer) return;
  const configured = DB_RETENTION_TABLES.map(
    (table) => `${table.table}=${retentionDays(table) ?? "disabled"}`,
  ).join(", ");
  console.log(
    `[db-retention] starting (${configured}, dryRun=${isEnvFlagEnabled("DB_RETENTION_DRY_RUN", false)})`,
  );
  await runDbRetentionTick();
  retentionTimer = scheduleContextFree(() =>
    setInterval(() => void runDbRetentionTick(), intervalMs),
  );
  if (typeof retentionTimer.unref === "function") retentionTimer.unref();
}

export function stopDbRetention(): void {
  if (!retentionTimer) return;
  clearInterval(retentionTimer);
  retentionTimer = null;
}

/** Test hook to prevent module state leaking between Bun test files. */
export function resetDbRetentionForTests(): void {
  stopDbRetention();
  tickInFlight = false;
  retentionStats = {};
  cumulativeRowsDeleted = {};
}
