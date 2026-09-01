import { AsyncLocalStorage } from "node:async_hooks";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { getDbClient } from "./db";
import { MAX_DB_RETENTION_DAYS } from "./swarm-config-guard";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 5_000;
const PER_TABLE_BATCH_CAP = 40;
const WALL_CLOCK_CAP_MS = 60_000;
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
  /** "failed" means the sweep threw. The table was neither swept nor counted. */
  status: "ok" | "failed";
  /**
   * Deleted rows, or rows that would be deleted when dryRun is true. Present
   * only when the sweep completed, because an operator reads this as a final
   * total. An interrupted scan reports `partialRowsMatched` instead.
   */
  rowsDeleted?: number;
  batches: number;
  durationMs: number;
  dryRun: boolean;
  cumulativeRowsDeleted: number;
  /** False when the scan stopped early. `rowsDeleted` is then absent. */
  complete: boolean;
  /** Rows the interrupted scan matched before it stopped. Never a total. */
  partialRowsMatched?: number;
  /** Failure reason when status is "failed". */
  error?: string;
};

/**
 * Written on every tick, whatever the per-table results are. A tick that swept
 * nothing still proves to an operator that the timer fired.
 */
export type DbRetentionTickInfo = {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
};

export type DbRetentionStats = Partial<Record<RetentionMetricsKey, DbRetentionTableStats>> & {
  lastTick?: DbRetentionTickInfo;
};

/**
 * A partial dry-run count must never be published as a total, but the operator
 * still needs the failure and what the interrupted scan did see. The throw
 * stays; the partial travels with it to the catch that records state.
 */
class IncompleteDryRunError extends Error {
  constructor(readonly partial: { rowsDeleted: number; batches: number }) {
    super("dry-run count stopped before completion");
    this.name = "IncompleteDryRunError";
  }
}

/** Test-only controls; production callers always use the bounded defaults above. */
export type DbRetentionTickOptions = {
  now?: Date;
  batchSize?: number;
  perTableBatchCap?: number;
  wallClockCapMs?: number;
};

let retentionTimer: ReturnType<typeof setInterval> | null = null;
let retentionTickPromise: Promise<void> | null = null;
let retentionAbortController: AbortController | null = null;
let retentionStats: DbRetentionStats = {};
let cumulativeRowsDeleted: Partial<Record<RetentionMetricsKey, number>> = {};

// Timers must not inherit an open database transaction from their caller.
const scheduleContextFree = AsyncLocalStorage.snapshot();

function readPositiveIntEnv(key: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DB_RETENTION_DAYS ? value : null;
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, YIELD_MS));
}

function retentionDays(table: RetentionTable): number | null {
  return readPositiveIntEnv(table.envKey);
}

function dryRunEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DB_RETENTION_DRY_RUN;
  if (raw === undefined || raw.trim() === "") return false;
  return isEnvFlagEnabled("DB_RETENTION_DRY_RUN", true, env);
}

async function sweepTable(
  table: RetentionTable,
  cutoff: string,
  dryRun: boolean,
  deadline: number,
  batchSize: number,
  perTableBatchCap: number,
  signal: AbortSignal,
): Promise<{ rowsDeleted: number; batches: number; complete: boolean }> {
  const client = getDbClient();
  let rowsDeleted = 0;
  let batches = 0;
  let pagesFetched = 0;
  let cursor: string | null = null;
  let complete = true;
  let exhausted = false;
  // Bounded on pages fetched, not on delete batches: a sparse or no-match
  // table would otherwise walk every primary-key page until the wall-clock
  // deadline, since batches only increments when a page has expired rows.
  const pageLimit = dryRun ? Number.POSITIVE_INFINITY : perTableBatchCap;
  while (!signal.aborted && pagesFetched < pageLimit && Date.now() < deadline) {
    // Page by the primary key, not by the retention predicate. A query that
    // filters on createdAt while ordering by id can scan the whole PK index
    // before finding LIMIT matches when eligible rows are sparse. This query
    // visits at most batchSize rows per statement; cutoff filtering happens in
    // memory and deletes are restricted to the IDs in that bounded page.
    const page: Array<{ id: string; createdAt: string }> = await client.query<{
      id: string;
      createdAt: string;
    }>(
      `SELECT id, ${table.timeColumn} AS createdAt
       FROM ${table.table}
       ${cursor === null ? "" : "WHERE id > ?"}
       ORDER BY id
       LIMIT ?`,
      cursor === null ? [batchSize] : [cursor, batchSize],
    );
    pagesFetched += 1;
    if (Date.now() >= deadline || signal.aborted) {
      complete = false;
      break;
    }
    if (page.length === 0) {
      exhausted = true;
      break;
    }

    cursor = page[page.length - 1]?.id ?? null;
    const expiredIds = page.filter((row) => row.createdAt < cutoff).map((row) => row.id);
    if (expiredIds.length > 0) {
      if (dryRun) {
        rowsDeleted += expiredIds.length;
      } else {
        // IDs came directly from the bounded page and are placeholders, so
        // this statement is bounded by the page size and remains retryable.
        const placeholders = expiredIds.map(() => "?").join(", ");
        const result = await client.run(
          `DELETE FROM ${table.table} WHERE id IN (${placeholders})`,
          expiredIds,
        );
        rowsDeleted += result.changes;
      }
      batches += 1;
    }
    if (page.length < batchSize) {
      exhausted = true;
      break;
    }
    await yieldTick();
  }
  // A dry-run count is only useful if the full table was scanned. Never
  // publish a partial count when the wall-clock budget or shutdown interrupted
  // the keyset scan.
  return { rowsDeleted, batches, complete: !dryRun || (complete && exhausted) };
}

/** Run one bounded sweep over every enabled table. Failures are isolated per table. */
export function runDbRetentionTick(options: DbRetentionTickOptions = {}): Promise<void> {
  if (retentionTickPromise) return retentionTickPromise;

  const abortController = new AbortController();
  retentionAbortController = abortController;
  const tickStartedAt = Date.now();
  const dryRun = dryRunEnabled();
  const promise = Promise.resolve().then(async () => {
    try {
      const cutoffBase = options.now ?? new Date(tickStartedAt);
      const batchSize = options.batchSize ?? BATCH_SIZE;
      const perTableBatchCap = options.perTableBatchCap ?? PER_TABLE_BATCH_CAP;
      const deadline = tickStartedAt + (options.wallClockCapMs ?? WALL_CLOCK_CAP_MS);
      let deletedAny = false;

      for (const table of DB_RETENTION_TABLES) {
        if (abortController.signal.aborted || Date.now() >= deadline) break;
        const days = retentionDays(table);
        if (days === null) continue;

        const startedAt = Date.now();
        try {
          const cutoff = new Date(cutoffBase.getTime() - days * DAY_MS).toISOString();
          const result = await sweepTable(
            table,
            cutoff,
            dryRun,
            deadline,
            batchSize,
            perTableBatchCap,
            abortController.signal,
          );
          if (dryRun && !result.complete) {
            throw new IncompleteDryRunError(result);
          }
          deletedAny ||= !dryRun && result.rowsDeleted > 0;
          const cumulative =
            (cumulativeRowsDeleted[table.metricsKey] ?? 0) + (dryRun ? 0 : result.rowsDeleted);
          cumulativeRowsDeleted[table.metricsKey] = cumulative;
          retentionStats[table.metricsKey] = {
            at: new Date().toISOString(),
            status: "ok",
            rowsDeleted: result.rowsDeleted,
            batches: result.batches,
            durationMs: Date.now() - startedAt,
            dryRun,
            cumulativeRowsDeleted: cumulative,
            complete: result.complete,
          };
          if (result.rowsDeleted > 0) {
            console.log(
              `[db-retention] ${table.table}: ${dryRun ? "would delete" : "deleted"} ${result.rowsDeleted} row(s) in ${result.batches} batch(es) after ${Date.now() - startedAt}ms`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[db-retention] ${table.table} sweep failed:`, message);
          // A failure that only reaches the log is invisible to an operator
          // reading GET /api/metrics: it looks identical to a tick that never
          // ran. Record the outcome so the two are distinguishable.
          const partial = err instanceof IncompleteDryRunError ? err.partial : null;
          retentionStats[table.metricsKey] = {
            at: new Date().toISOString(),
            status: "failed",
            batches: partial?.batches ?? 0,
            durationMs: Date.now() - startedAt,
            dryRun,
            cumulativeRowsDeleted: cumulativeRowsDeleted[table.metricsKey] ?? 0,
            complete: false,
            ...(partial ? { partialRowsMatched: partial.rowsDeleted } : {}),
            error: message,
          };
        }
      }

      if (deletedAny && !abortController.signal.aborted) {
        try {
          // Harmless when auto_vacuum is not INCREMENTAL; never run a blocking VACUUM here.
          await getDbClient().run("PRAGMA incremental_vacuum(2000)");
        } catch (err) {
          console.error("[db-retention] incremental vacuum failed:", (err as Error).message);
        }
      }
    } finally {
      retentionStats.lastTick = {
        startedAt: new Date(tickStartedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        dryRun,
      };
      if (retentionAbortController === abortController) retentionAbortController = null;
      retentionTickPromise = null;
    }
  });
  retentionTickPromise = promise;
  return promise;
}

export function getDbRetentionStats(): DbRetentionStats {
  return { ...retentionStats };
}

/** Start the hourly sweep. The first tick runs immediately. */
export async function startDbRetention(intervalMs = RETENTION_INTERVAL_MS): Promise<void> {
  if (retentionTimer) return;
  const configured = DB_RETENTION_TABLES.map(
    (table) => `${table.table}=${retentionDays(table) ?? "disabled"}`,
  ).join(", ");
  console.log(`[db-retention] starting (${configured}, dryRun=${dryRunEnabled()})`);
  retentionTimer = scheduleContextFree(() =>
    setInterval(() => void runDbRetentionTick(), intervalMs),
  );
  if (typeof retentionTimer.unref === "function") retentionTimer.unref();
  await runDbRetentionTick();
}

export async function stopDbRetention(): Promise<void> {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  retentionAbortController?.abort();
  await retentionTickPromise;
}

/** Test hook to prevent module state leaking between Bun test files. */
export async function resetDbRetentionForTests(): Promise<void> {
  await stopDbRetention();
  retentionStats = {};
  cumulativeRowsDeleted = {};
}
