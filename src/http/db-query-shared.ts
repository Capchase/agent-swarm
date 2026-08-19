/**
 * Primitives shared between the synchronous db-query path (db-query.ts) and
 * the bounded child-process path (db-query-bounded.ts). Split out to avoid a
 * circular import: db-query.ts's HTTP handler calls into the bounded
 * executor, and the bounded executor reuses the same single-statement guard.
 *
 * Also holds the Fix-1 operator knobs (the `DB_QUERY_*` kill switch and
 * budget/row overrides), since both db-query.ts (HTTP) and tools/db-query.ts
 * (MCP) need to read them without importing each other.
 */

import { getDb } from "../be/db";
import { isEnvFlagEnabled } from "../utils/env-flag";

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  elapsed: number;
  total: number;
}

export function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim();
}

export function assertSingleStatement(sql: string): void {
  const stripped = stripTrailingSemicolon(sql);
  if (stripped.includes(";")) {
    throw new Error("Only one SQL statement is allowed");
  }
}

/**
 * Execute a read-only SQL query against the swarm database, synchronously,
 * on the caller's own thread.
 *
 * Lives here (not db-query.ts) so db-query-bounded.ts can fall back to it
 * without a circular import — db-query.ts already imports the bounded
 * executor. Two callers rely on this fallback path: the
 * `DB_QUERY_BOUNDED_ENABLED=false` kill switch, and runBoundedQueryChild when
 * no `bun` executable can be spawned (see warnDbQuerySpawnUnavailableOnce).
 */
export function executeReadOnlyQuery(
  sql: string,
  params: unknown[] = [],
  maxRows?: number,
): DbQueryResult {
  assertSingleStatement(sql);
  const stmt = getDb().prepare(sql);

  // bun:sqlite: columnNames is empty for write statements, populated for SELECT/PRAGMA/EXPLAIN
  if (stmt.columnNames.length === 0) {
    throw new Error("Only read-only queries are allowed");
  }

  const columns = stmt.columnNames as string[];
  const start = performance.now();
  const rows = (params.length > 0 ? stmt.all(...(params as [string])) : stmt.all()) as Record<
    string,
    unknown
  >[];
  const elapsed = Math.round(performance.now() - start);

  const capped = maxRows ? rows.slice(0, maxRows) : rows;
  const rowArrays = capped.map((row) => columns.map((col) => row[col]));

  return { columns, rows: rowArrays, elapsed, total: rows.length };
}

/** Hardcoded pre-flag defaults — kept equal to the values PR #87 shipped with, so adding the flag changes no behaviour out of the box. */
export const DB_QUERY_HTTP_BUDGET_MS_DEFAULT = 10_000;
export const DB_QUERY_HTTP_MAX_ROWS_DEFAULT = 1000;
export const DB_QUERY_MCP_BUDGET_MS_DEFAULT = 5_000;

/**
 * Master kill switch for the bounded child-process execution path (Fix 1).
 * Enabled by default — the fix ships active; an operator sets this to
 * `false` to restore the pre-fix synchronous, unbounded path. Read
 * dynamically on every call (never captured in a module-level const) so a
 * `swarm_config` edit takes effect on the next request with no restart —
 * mirrors `isSteeringEnabled` / `isPoolAffinityEnforcementEnabled`.
 */
export function isDbQueryBoundedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagEnabled("DB_QUERY_BOUNDED_ENABLED", true, env);
}

/** Read a positive-integer override, falling back to `defaultValue` for anything absent, non-numeric, or <= 0. */
function readPositiveIntEnv(
  key: string,
  defaultValue: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;
}

/** Wall-clock budget for `/api/db-query`. Overridable via `DB_QUERY_HTTP_BUDGET_MS`. */
export function getDbQueryHttpBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv("DB_QUERY_HTTP_BUDGET_MS", DB_QUERY_HTTP_BUDGET_MS_DEFAULT, env);
}

/** Row cap for `/api/db-query`. Overridable via `DB_QUERY_HTTP_MAX_ROWS`. */
export function getDbQueryHttpMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv("DB_QUERY_HTTP_MAX_ROWS", DB_QUERY_HTTP_MAX_ROWS_DEFAULT, env);
}

/** Wall-clock budget for the MCP `db-query` tool. Overridable via `DB_QUERY_MCP_BUDGET_MS`. */
export function getDbQueryMcpBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv("DB_QUERY_MCP_BUDGET_MS", DB_QUERY_MCP_BUDGET_MS_DEFAULT, env);
}

let hasWarnedBoundedDisabled = false;
let hasWarnedSpawnUnavailable = false;

/** Exposed for tests only — resets the one-time warning between cases. */
export function resetDbQueryBoundedWarningForTests(): void {
  hasWarnedBoundedDisabled = false;
}

/** Exposed for tests only — resets the one-time warning between cases. */
export function resetDbQuerySpawnUnavailableWarningForTests(): void {
  hasWarnedSpawnUnavailable = false;
}

/**
 * Logs once per process the first time a query runs the legacy unbounded
 * path because `DB_QUERY_BOUNDED_ENABLED=false`. An operator can turn the
 * protection off, but not silently — this is the trace that they did.
 */
export function warnDbQueryBoundedDisabledOnce(): void {
  if (hasWarnedBoundedDisabled) return;
  hasWarnedBoundedDisabled = true;
  console.warn(
    "[db-query] DB_QUERY_BOUNDED_ENABLED=false — db-query timeout protection is disabled. " +
      "Queries now run in-process with no wall-clock budget and can freeze the API event loop " +
      "until they finish. Set DB_QUERY_BOUNDED_ENABLED=true (or delete the override) to restore " +
      "the bounded child-process path.",
  );
}

/**
 * Logs once per process the first time the bounded path can't spawn a `bun`
 * executable at all (no separate Bun CLI on $PATH — e.g. the standalone
 * `dist/agent-swarm` binary built by `bun run build:binary`, which embeds
 * the Bun runtime for its own execution but does not bundle a
 * spawnable `bun` binary alongside it). Every other documented deployment
 * path (Docker images, npm/bunx, the systemd installer) ships or requires a
 * separate `bun` CLI, so this is expected to be rare.
 */
export function warnDbQuerySpawnUnavailableOnce(): void {
  if (hasWarnedSpawnUnavailable) return;
  hasWarnedSpawnUnavailable = true;
  console.warn(
    "[db-query] No spawnable `bun` executable found on $PATH — db-query timeout protection is " +
      "unavailable on this host. Falling back to the in-process path with no wall-clock budget; " +
      "queries can freeze the API event loop until they finish. Install the `bun` CLI alongside " +
      "this process to restore the bounded child-process path.",
  );
}
