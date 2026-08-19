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
import { assertSingleStatement } from "./db-query-shared";
import type { DbQueryResult } from "./db-query-shared";

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

  if (timedOut) {
    throw new Error(
      `Query exceeded the ${budgetMs}ms budget and was terminated. Filter on an indexed column and add LIMIT 1000 or less.`,
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
