import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, getDb, initDb } from "../be/db";
import {
  DbQueryInputSchema,
  executeReadOnlyQueryGated,
  handleDbQuery,
  resolveDbQuerySql,
} from "../http/db-query";
import { executeReadOnlyQueryBounded } from "../http/db-query-bounded";
import {
  getDbQueryHttpBudgetMs,
  getDbQueryHttpMaxRows,
  getDbQueryMcpBudgetMs,
  resetDbQueryBoundedWarningForTests,
} from "../http/db-query-shared";
import { getPathSegments, parseQueryParams } from "../http/utils";

describe("db-query input compatibility", () => {
  test("canonical sql input resolves to sql", () => {
    const parsed = DbQueryInputSchema.parse({ sql: "SELECT 1", params: [] });

    expect(resolveDbQuerySql(parsed)).toBe("SELECT 1");
  });

  test("legacy query input remains a runtime alias", () => {
    const parsed = DbQueryInputSchema.parse({ query: "SELECT 2" });

    expect(resolveDbQuerySql(parsed)).toBe("SELECT 2");
  });

  test("sql takes precedence when both sql and query are present", () => {
    const parsed = DbQueryInputSchema.parse({ sql: "SELECT 3", query: "SELECT 4" });

    expect(resolveDbQuerySql(parsed)).toBe("SELECT 3");
  });

  test("rejects input without sql or query", () => {
    const parsed = DbQueryInputSchema.safeParse({});

    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — bounded child-process execution (proposal §5.1, Tests A-F).
// Needs a real on-disk database: the bounded path spawns a separate `bun -e`
// process that opens its own connection, so an in-memory/deserialized test
// template (invisible outside this process) won't work. This swaps out the
// fast in-memory `__testMigrationTemplate` for a real file for the duration
// of this describe block, following the pattern in asset-key-migration.test.ts.
// ---------------------------------------------------------------------------

const BOUNDED_TEST_DB_PATH = "./test-db-query-bounded.sqlite";
const HTTP_TEST_PORT = 13097;

// A CPU-bound query with near-zero fixture setup cost (no table/data needed)
// and deterministic timing that doesn't depend on disk cache state, unlike
// the proposal's own I/O-bound synthetic table. Reliably takes >1s in this
// sandbox; must stay a SELECT so the read-only guard lets it through.
const SLOW_QUERY = `
  WITH RECURSIVE cnt(x) AS (
    SELECT 1
    UNION ALL
    SELECT x + 1 FROM cnt WHERE x < 6000000
  )
  SELECT COUNT(*) AS c FROM cnt WHERE (x * x) % 998244353 = 12345
`;

const boundedTestGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedDbQueryBoundedTemplate?: Uint8Array;
};

/** Starts handleDbQuery on HTTP_TEST_PORT for the duration of `fn`, exposing a small `post` helper. */
async function withDbQueryHttpServer<T>(
  fn: (post: (body: unknown) => Promise<{ status: number; body: DbQueryHttpBody }>) => Promise<T>,
): Promise<T> {
  let server: Server | undefined;
  try {
    server = createHttpServer(async (req, res) => {
      const pathSegments = getPathSegments(req.url || "");
      const queryParams = parseQueryParams(req.url || "");
      const handled = await handleDbQuery(req, res, pathSegments, queryParams);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server?.listen(HTTP_TEST_PORT, () => resolve()));

    const post = async (body: unknown) => {
      const res = await fetch(`http://localhost:${HTTP_TEST_PORT}/api/db-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as DbQueryHttpBody };
    };
    return await fn(post);
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
}

interface DbQueryHttpBody {
  rows?: unknown[][];
  total?: number;
  error?: string;
}

/** Env keys the flag/budget-override tests touch — reset after each so tests don't leak into each other. */
const DB_QUERY_OVERRIDE_ENV_KEYS = [
  "DB_QUERY_BOUNDED_ENABLED",
  "DB_QUERY_HTTP_BUDGET_MS",
  "DB_QUERY_HTTP_MAX_ROWS",
  "DB_QUERY_MCP_BUDGET_MS",
] as const;

async function removeBoundedTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(`${BOUNDED_TEST_DB_PATH}${suffix}`).delete();
    } catch {}
  }
}

describe("db-query bounded execution (Fix 1)", () => {
  beforeAll(async () => {
    boundedTestGlobals.__savedDbQueryBoundedTemplate = boundedTestGlobals.__testMigrationTemplate;
    boundedTestGlobals.__testMigrationTemplate = undefined;
    closeDb();
    await removeBoundedTestDb();
    initDb(BOUNDED_TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    boundedTestGlobals.__testMigrationTemplate = boundedTestGlobals.__savedDbQueryBoundedTemplate;
    boundedTestGlobals.__savedDbQueryBoundedTemplate = undefined;
    await removeBoundedTestDb();
  });

  afterEach(() => {
    for (const key of DB_QUERY_OVERRIDE_ENV_KEYS) delete process.env[key];
    resetDbQueryBoundedWarningForTests();
  });

  // Test A: budget is enforced — fails today because there is no budget
  // parameter or timeout path; the synchronous call only returns after the
  // full scan.
  test("A: rejects with a timeout error once the budget expires, well under 1s wall time", async () => {
    const start = performance.now();
    await expect(executeReadOnlyQueryBounded(SLOW_QUERY, [], 200)).rejects.toThrow(/budget/i);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  // Test B: the event loop stays responsive — fails today because the
  // interval fires about once regardless of query duration. This is the
  // assertion that encodes the actual defect.
  test("B: keeps a 50ms heartbeat ticking at close to its expected rate while the child runs", async () => {
    const heartbeatMs = 50;
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks++;
    }, heartbeatMs);

    const start = performance.now();
    await executeReadOnlyQueryBounded(SLOW_QUERY, [], 10_000);
    const elapsed = performance.now() - start;
    clearInterval(heartbeat);

    const expectedTicks = elapsed / heartbeatMs;
    expect(ticks).toBeGreaterThanOrEqual(expectedTicks * 0.6);
  });

  // Test C: `total` semantics do not move — this is the regression guard for
  // src/tools/db-query.ts:41 and src/http/metrics.ts:168, which compare
  // `total` against the delivered row count to compute `truncated`. Must
  // keep passing: the bounded path materializes fully before capping, same
  // as the synchronous path.
  test("C: total reflects rows returned, not rows delivered, when capped", async () => {
    const db = getDb();
    db.run("CREATE TABLE cap_test (id INTEGER PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO cap_test DEFAULT VALUES");
    for (let i = 0; i < 250; i++) insert.run();

    const result = await executeReadOnlyQueryBounded("SELECT id FROM cap_test", [], 5000, 100);
    expect(result.total).toBe(250);
    expect(result.rows.length).toBe(100);
  });

  // Test E: the read-only guard survives the new path — passes today via a
  // different code path (the synchronous columnNames check); must keep
  // passing with the exact same error message through the child process.
  test("E: rejects a write with the exact pre-existing error message", async () => {
    const db = getDb();
    db.run("CREATE TABLE guard_test (id INTEGER PRIMARY KEY)");

    await expect(executeReadOnlyQueryBounded("DELETE FROM guard_test", [], 5000)).rejects.toThrow(
      "Only read-only queries are allowed",
    );
  });

  // Test F: the HTTP route is capped — fails today because
  // src/http/db-query.ts's handler passes no cap at all, so every row comes
  // back.
  test("F: /api/db-query caps rows at the new default and still reports the true total", async () => {
    const db = getDb();
    db.run("CREATE TABLE http_cap_test (id INTEGER PRIMARY KEY)");
    const insert = db.prepare("INSERT INTO http_cap_test DEFAULT VALUES");
    for (let i = 0; i < 1500; i++) insert.run();

    let server: Server | undefined;
    try {
      server = createHttpServer(async (req, res) => {
        const pathSegments = getPathSegments(req.url || "");
        const queryParams = parseQueryParams(req.url || "");
        const handled = await handleDbQuery(req, res, pathSegments, queryParams);
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server?.listen(HTTP_TEST_PORT, () => resolve()));

      const res = await fetch(`http://localhost:${HTTP_TEST_PORT}/api/db-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT id FROM http_cap_test", params: [] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: unknown[][]; total: number };
      expect(body.rows.length).toBe(1000);
      expect(body.total).toBeGreaterThan(1000);
    } finally {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    }
  });

  // Regression guard for src/http/db-query-bounded.ts:148-150 — a non-write
  // error must propagate the child's stderr as-is, not just the
  // WRITE_REJECTED_EXIT_CODE path (Test E already covers that one).
  // Reviewer 2's non-blocking suggestion on PR #87.
  test("N: propagates the child's stderr on a non-write, non-zero exit (a SQL error)", async () => {
    await expect(
      executeReadOnlyQueryBounded("SELECT * FROM this_table_does_not_exist_xyz", [], 5000),
    ).rejects.toThrow(/no such table/i);
  });

  // -------------------------------------------------------------------------
  // Feature-flag addendum (follow-up to Fix 1, PR #87): DB_QUERY_BOUNDED_ENABLED
  // kill switch + DB_QUERY_HTTP_BUDGET_MS / DB_QUERY_HTTP_MAX_ROWS /
  // DB_QUERY_MCP_BUDGET_MS overrides. See the plan doc addendum for the design.
  // -------------------------------------------------------------------------

  test("defaults apply when unset, and an invalid override falls back to the default", () => {
    expect(getDbQueryHttpBudgetMs()).toBe(10_000);
    expect(getDbQueryHttpMaxRows()).toBe(1000);
    expect(getDbQueryMcpBudgetMs()).toBe(5_000);

    process.env.DB_QUERY_HTTP_BUDGET_MS = "-5";
    expect(getDbQueryHttpBudgetMs()).toBe(10_000);

    process.env.DB_QUERY_HTTP_MAX_ROWS = "not-a-number";
    expect(getDbQueryHttpMaxRows()).toBe(1000);
  });

  // G: flag ON (default, unset) — the gate still runs the bounded path and
  // enforces the budget, same as calling executeReadOnlyQueryBounded directly.
  test("G: gated executor runs the bounded path by default and still enforces the budget", async () => {
    await expect(executeReadOnlyQueryGated(SLOW_QUERY, [], 200)).rejects.toThrow(/budget/i);
  });

  // H: flag explicitly "true" behaves the same as unset.
  test("H: DB_QUERY_BOUNDED_ENABLED=true behaves the same as unset", async () => {
    process.env.DB_QUERY_BOUNDED_ENABLED = "true";
    await expect(executeReadOnlyQueryGated(SLOW_QUERY, [], 200)).rejects.toThrow(/budget/i);
  });

  // I: flag OFF — the gate must fall back to the legacy, unbounded in-process
  // path. A budget that would trip the bounded path must be ignored entirely,
  // not just extended, and the query must complete normally.
  test("I: DB_QUERY_BOUNDED_ENABLED=false runs the legacy in-process path, ignoring the budget", async () => {
    process.env.DB_QUERY_BOUNDED_ENABLED = "false";
    const result = await executeReadOnlyQueryGated(SLOW_QUERY, [], 200);
    expect(result.rows.length).toBe(1);
  });

  // J: HTTP route, flag OFF — still caps rows via the legacy path (the cap is
  // applied by executeReadOnlyQuery too, not just the bounded executor), and
  // must not throw despite a budget that would trip the bounded path.
  test("J: /api/db-query with DB_QUERY_BOUNDED_ENABLED=false still caps rows via the legacy path", async () => {
    process.env.DB_QUERY_BOUNDED_ENABLED = "false";
    process.env.DB_QUERY_HTTP_BUDGET_MS = "1";

    const { status, body } = await withDbQueryHttpServer((post) =>
      post({ sql: "SELECT id FROM http_cap_test", params: [] }),
    );
    expect(status).toBe(200);
    expect(body.rows?.length).toBe(1000);
    expect(body.total).toBeGreaterThan(1000);
  });

  // K: DB_QUERY_HTTP_BUDGET_MS actually reaches the bounded executor via the
  // HTTP route — a tightened budget trips the timeout on a query that would
  // otherwise pass under the 10s default.
  test("K: DB_QUERY_HTTP_BUDGET_MS overrides the bounded HTTP budget", async () => {
    process.env.DB_QUERY_HTTP_BUDGET_MS = "150";
    expect(getDbQueryHttpBudgetMs()).toBe(150);

    const { status, body } = await withDbQueryHttpServer((post) =>
      post({ sql: SLOW_QUERY, params: [] }),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/150ms budget/);
  });

  // L: DB_QUERY_HTTP_MAX_ROWS actually reaches the HTTP route's row cap.
  test("L: DB_QUERY_HTTP_MAX_ROWS overrides the HTTP row cap", async () => {
    process.env.DB_QUERY_HTTP_MAX_ROWS = "5";
    expect(getDbQueryHttpMaxRows()).toBe(5);

    const { status, body } = await withDbQueryHttpServer((post) =>
      post({ sql: "SELECT id FROM http_cap_test", params: [] }),
    );
    expect(status).toBe(200);
    expect(body.rows?.length).toBe(5);
    expect(body.total).toBeGreaterThan(5);
  });

  // M: DB_QUERY_MCP_BUDGET_MS actually reaches the bounded executor on the
  // MCP tool's path (same gated executor the HTTP route uses, with the MCP
  // budget getter instead of the HTTP one).
  test("M: DB_QUERY_MCP_BUDGET_MS overrides the MCP query budget", async () => {
    process.env.DB_QUERY_MCP_BUDGET_MS = "150";
    expect(getDbQueryMcpBudgetMs()).toBe(150);

    await expect(
      executeReadOnlyQueryGated(SLOW_QUERY, [], getDbQueryMcpBudgetMs()),
    ).rejects.toThrow(/150ms budget/);
  });
});
