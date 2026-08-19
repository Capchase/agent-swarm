/**
 * Bounded db-query execution — Fix 1 for the API event-loop freeze.
 *
 * `bun:sqlite` is synchronous and exposes no interrupt, progress handler, or
 * statement timeout (verified two ways — see the design doc referenced from
 * the PR). A single expensive query therefore blocks the whole API process
 * until SQLite finishes. Running the query in a short-lived child process
 * lets the parent SIGKILL it on a wall-clock budget: the child dies and its
 * CPU is reclaimed immediately, unlike a worker thread's `terminate()`,
 * which detaches the main thread's view of the worker but leaves the native
 * SQLite call running to completion.
 *
 * SQL and params travel over the child's stdin (not argv), so query text
 * never appears in `ps` output. The child opens its own read-only
 * connection to the same on-disk WAL database file and loads the
 * sqlite-vec extension itself, from the same path the parent process uses
 * (env var first, npm resolver fallback in dev) — the child cannot see the
 * parent's already-loaded extension across the process boundary.
 */

import { getDb, resolveSqliteVecExtensionPath } from "../be/db";
import type { DbQueryResult } from "./db-query-shared";
import { assertSingleStatement } from "./db-query-shared";

interface ChildPayload {
  file: string;
  sql: string;
  params: unknown[];
  vecExtensionPath?: string;
}

interface ChildSuccess {
  columns: string[];
  rows: unknown[][];
  elapsed: number;
  total: number;
}

/** Exit code the child uses when the query is a write statement. */
const WRITE_REJECTED_EXIT_CODE = 2;

// Plain JS (no TypeScript syntax) — this string is executed directly by
// `bun -e`, not compiled first. Mirrors executeReadOnlyQuery's read-only
// guard and materialize-then-cap shape exactly, so `total` keeps meaning
// "rows SQLite actually returned" regardless of which path ran the query.
const CHILD_SCRIPT = `
const { Database } = require("bun:sqlite");

(async () => {
  let payload = "";
  for await (const chunk of Bun.stdin.stream()) {
    payload += Buffer.from(chunk).toString("utf8");
  }

  const { file, sql, params, vecExtensionPath } = JSON.parse(payload);

  try {
    const db = new Database(file, { readonly: true });
    if (vecExtensionPath) {
      try {
        db.loadExtension(vecExtensionPath);
      } catch {
        // Non-fatal: only queries that reference vec0 tables/functions need it.
      }
    }

    const stmt = db.prepare(sql);
    if (stmt.columnNames.length === 0) {
      process.stderr.write("Only read-only queries are allowed");
      process.exit(${WRITE_REJECTED_EXIT_CODE});
    }

    const columns = stmt.columnNames;
    const start = performance.now();
    const rows = params && params.length > 0 ? stmt.all(...params) : stmt.all();
    const elapsed = Math.round(performance.now() - start);
    const rowArrays = rows.map((row) => columns.map((col) => row[col]));

    process.stdout.write(JSON.stringify({ columns, rows: rowArrays, elapsed, total: rows.length }));
  } catch (err) {
    process.stderr.write(err && err.message ? err.message : String(err));
    process.exit(1);
  }
})();
`;

/**
 * Concurrency cap for in-flight bounded child-process queries.
 *
 * Before this cap, N concurrent callers spawned N children in parallel, each
 * materializing its own full result set — peak memory went from roughly 1x
 * (the old synchronous path serialized callers on one thread) to roughly
 * 3x-per-query and unbounded in N (the child's own rows array, the parent's
 * raw stdout buffer, and the parent's parsed JS object all live at once per
 * in-flight query).
 *
 * Sized against the largest payload measured against this code path — a 68MB
 * result set, ~15ms to `JSON.parse` on the parent side (see the PR
 * discussion) — and the API pod's 10Gi memory limit. Treating 3x that
 * payload as one query's worst-case footprint (~200MB), a cap of 8 bounds
 * worst-case fan-out to ~1.6GB: comfortable headroom inside 10Gi, leaving the
 * rest for the pod's steady-state work. Rejects immediately when full rather
 * than queueing — an unbounded queue would just move the memory growth from
 * "many children" to "many pending callers," and a caller that's told to
 * retry can back off, whereas a caller stuck in an in-process queue can't.
 */
export const DB_QUERY_CONCURRENCY_CAP = 8;

let activeBoundedQueryCount = 0;

function acquireBoundedQuerySlot(): void {
  if (activeBoundedQueryCount >= DB_QUERY_CONCURRENCY_CAP) {
    throw new Error(
      `Too many concurrent db-query executions in flight (cap ${DB_QUERY_CONCURRENCY_CAP}). Retry shortly.`,
    );
  }
  activeBoundedQueryCount++;
}

function releaseBoundedQuerySlot(): void {
  activeBoundedQueryCount--;
}

/**
 * Run one read-only query in a bounded `bun -e` child process, SIGKILLing it
 * if it runs past `budgetMs`. Semantics match executeReadOnlyQuery exactly:
 * the full result set is materialized before `maxRows` caps it, so `total`
 * still means "rows SQLite returned," not "rows delivered" (callers such as
 * src/tools/db-query.ts:41 and src/http/metrics.ts:168 compare the two to
 * decide whether a result was truncated).
 */
export async function executeReadOnlyQueryBounded(
  sql: string,
  params: unknown[] = [],
  budgetMs: number,
  maxRows?: number,
): Promise<DbQueryResult> {
  assertSingleStatement(sql);
  acquireBoundedQuerySlot();

  try {
    return await runBoundedQueryChild(sql, params, budgetMs, maxRows);
  } finally {
    releaseBoundedQuerySlot();
  }
}

/**
 * Whether a fired timer should be reported to the caller as a timeout.
 *
 * A complete, correct result can land in the same tick the budget timer
 * fires — the SIGKILL is a no-op on an already-exited child, and its stdout
 * is still the real answer. Only report a timeout when the kill genuinely
 * prevented a clean result (no successful, non-empty stdout); pulled out as
 * its own function so both halves of the condition can be pinned directly in
 * tests instead of only through process-timing races.
 */
export function isReportableTimeout(timedOut: boolean, exitCode: number, stdout: string): boolean {
  return timedOut && !(exitCode === 0 && stdout.length > 0);
}

async function runBoundedQueryChild(
  sql: string,
  params: unknown[],
  budgetMs: number,
  maxRows?: number,
): Promise<DbQueryResult> {
  const payload: ChildPayload = {
    file: getDb().filename,
    sql,
    params,
    vecExtensionPath: resolveSqliteVecExtensionPath(),
  };

  const proc = Bun.spawn(["bun", "-e", CHILD_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, budgetMs);

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (isReportableTimeout(timedOut, exitCode, stdout)) {
    throw new Error(
      `Query exceeded the ${budgetMs}ms budget and was terminated. Filter on an indexed column and add a LIMIT. Aggregates such as COUNT(*), SUM(...) or typeof() over session_logs, agent_log, events or task_context_snapshots read every row in range and cannot be made cheap by chunking on rowid.`,
    );
  }

  if (exitCode === WRITE_REJECTED_EXIT_CODE) {
    throw new Error(stderr.trim() || "Only read-only queries are allowed");
  }

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Query failed with exit code ${exitCode}`);
  }

  const parsed = JSON.parse(stdout) as ChildSuccess;
  const rows = maxRows ? parsed.rows.slice(0, maxRows) : parsed.rows;

  return { columns: parsed.columns, rows, elapsed: parsed.elapsed, total: parsed.total };
}
