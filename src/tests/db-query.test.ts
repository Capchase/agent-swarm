import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, getDb, initDb } from "../be/db";
import { DbQueryInputSchema, handleDbQuery, resolveDbQuerySql } from "../http/db-query";
import { executeReadOnlyQueryBounded } from "../http/db-query-bounded";
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
});
