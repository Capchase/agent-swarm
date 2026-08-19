import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, initDb, upsertSwarmConfig } from "../be/db";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { DbQueryInputSchema, handleDbQuery, resolveDbQuerySql } from "../http/db-query";
import { handleMcpBridge } from "../http/mcp-bridge";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerDbQueryTool } from "../tools/db-query";
import { registerGetOauthAccessTokenTool } from "../tools/oauth-access-token";

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

// ── Test G — lead guard on db-query and get-oauth-access-token ─────────────
//
// Both tools were registered under a comment claiming they "self-guard with
// lead check" (src/server.ts) while ignoring the caller entirely. This
// section pins the fixed behavior: db-query is lead OR an explicit per-agent
// grant (script-SDK callers run as non-lead agents at scale — see the
// db-query-event-loop-freeze proposal doc §12.3); get-oauth-access-token is
// plain lead-only.
//
// Pattern: src/tests/rbac-charact-misc-tools.test.ts (in-process MCP server,
// invoke the registered handler directly — no subprocess, no real MCP wire).
describe("db-query / get-oauth-access-token lead guard (Test G)", () => {
  const TEST_DB_PATH = "./test-db-query-lead-guard.sqlite";

  const LEAD_ID = "dddd4000-0000-4000-8000-000000000001";
  const WORKER_ID = "eeee4000-0000-4000-8000-000000000002";
  const GRANTED_WORKER_ID = "ffff4000-0000-4000-8000-000000000003";

  type Structured = { success: boolean; message: string; [key: string]: unknown };
  type ToolResult = { structuredContent: Structured };

  let server: McpServer;

  async function callTool(
    name: string,
    callerAgentId: string | undefined,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
      ._registeredTools;
    const handler = tools[name]?.handler;
    if (!handler) throw new Error(`Tool not registered: ${name}`);

    const extra = {
      sessionId: "test-session",
      requestInfo: { headers: { "x-agent-id": callerAgentId ?? "" } },
    };
    return (await handler(args, extra)) as ToolResult;
  }

  async function removeDbFiles() {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
  }

  beforeAll(async () => {
    await removeDbFiles();
    closeDb();
    initDb(TEST_DB_PATH);

    createAgent({ id: LEAD_ID, name: "Test G Lead", isLead: true, status: "idle" });
    createAgent({ id: WORKER_ID, name: "Test G Worker", isLead: false, status: "idle" });
    createAgent({
      id: GRANTED_WORKER_ID,
      name: "Test G Granted Worker",
      isLead: false,
      status: "idle",
    });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: GRANTED_WORKER_ID,
      key: "DB_QUERY_ALLOWED",
      value: "true",
    });

    server = new McpServer({ name: "test-db-query-lead-guard", version: "1.0.0" });
    registerDbQueryTool(server);
    registerGetOauthAccessTokenTool(server);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles();
  });

  test("a non-lead, non-granted agent cannot run db-query", async () => {
    const result = await callTool("db-query", WORKER_ID, { sql: "SELECT 1" });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Only the lead agent, or an agent explicitly granted db-query access, can run this query.",
    );
  });

  test("the lead agent can run db-query", async () => {
    const result = await callTool("db-query", LEAD_ID, { sql: "SELECT 1 AS one" });

    expect(result.structuredContent.success).toBe(true);
  });

  test("a non-lead agent with an explicit DB_QUERY_ALLOWED grant can run db-query", async () => {
    const result = await callTool("db-query", GRANTED_WORKER_ID, { sql: "SELECT 1 AS one" });

    expect(result.structuredContent.success).toBe(true);
  });

  test("a non-lead agent cannot read an OAuth access token", async () => {
    const result = await callTool("get-oauth-access-token", WORKER_ID, { provider: "acme" });

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Only the lead agent can read OAuth access tokens.",
    );
  });
});

// ── HTTP-route + script-bridge coverage (PR #85 review) ─────────────────────
//
// Test G above only exercises the MCP tool handler in-process. The direct
// HTTP route (/api/db-query) — which is also exactly how the scripts SDK's
// `ctx.swarm.db_query()` reaches the server (src/scripts-runtime/swarm-sdk.ts)
// — carried no guard at all until this section's fix landed. This spins up a
// real HTTP server on the same auth → handler pipeline as src/http/index.ts
// (pattern: src/tests/kv-http.test.ts) so the bearer gate, X-Agent-ID header
// parsing, and RBAC decision are all exercised for real, not bypassed.
describe("db-query HTTP route + script bridge — RBAC (PR #85 review)", () => {
  const TEST_DB_PATH = "./test-db-query-http-rbac.sqlite";
  const API_KEY = "test-db-query-http-rbac-key";

  let server: Server;
  let port: number;
  let leadAgentId: string;
  let workerAgentId: string;
  let grantedWorkerAgentId: string;

  async function removeDbFiles() {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
  }

  function createTestServer(apiKey: string): Server {
    return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const myAgentId = req.headers["x-agent-id"] as string | undefined;
      const handled = await handleCore(req, res, myAgentId, apiKey);
      if (handled) return;
      const pathSegments = getPathSegments(req.url || "");
      const queryParams = parseQueryParams(req.url || "");
      const routed =
        (await handleDbQuery(req, res, pathSegments, queryParams)) ||
        (await handleMcpBridge(req, res, pathSegments, queryParams, myAgentId)) ||
        (await handleConfig(req, res, pathSegments, queryParams));
      if (!routed) {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
  }

  async function listen(httpServer: Server): Promise<number> {
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    return addr.port;
  }

  function url(path: string): string {
    return `http://localhost:${port}${path}`;
  }

  function authedFetch(
    path: string,
    init: RequestInit & { agentId?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (init.agentId !== undefined) headers["X-Agent-ID"] = init.agentId;
    return fetch(url(path), { ...init, headers });
  }

  beforeAll(async () => {
    await removeDbFiles();
    closeDb();
    initDb(TEST_DB_PATH);
    server = createTestServer(API_KEY);
    port = await listen(server);

    leadAgentId = createAgent({ name: "http-rbac-lead", isLead: true, status: "idle" }).id;
    workerAgentId = createAgent({ name: "http-rbac-worker", isLead: false, status: "idle" }).id;
    grantedWorkerAgentId = createAgent({
      name: "http-rbac-granted",
      isLead: false,
      status: "idle",
    }).id;
    upsertSwarmConfig({
      scope: "agent",
      scopeId: grantedWorkerAgentId,
      key: "DB_QUERY_ALLOWED",
      value: "true",
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    await removeDbFiles();
  });

  // ── Blocking item 1: the direct HTTP route now shares the MCP tool's gate ──

  test("an ungranted non-lead agent is denied via the direct HTTP route", async () => {
    const res = await authedFetch("/api/db-query", {
      method: "POST",
      agentId: workerAgentId,
      body: JSON.stringify({ sql: "SELECT 1" }),
    });

    expect(res.status).toBe(403);
  });

  test("the lead agent is allowed via the direct HTTP route", async () => {
    const res = await authedFetch("/api/db-query", {
      method: "POST",
      agentId: leadAgentId,
      body: JSON.stringify({ sql: "SELECT 1 AS one" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { columns: string[] };
    expect(body.columns).toEqual(["one"]);
  });

  test("a non-lead agent with an explicit grant is allowed via the direct HTTP route", async () => {
    const res = await authedFetch("/api/db-query", {
      method: "POST",
      agentId: grantedWorkerAgentId,
      body: JSON.stringify({ sql: "SELECT 1 AS one" }),
    });

    expect(res.status).toBe(200);
  });

  test("the bare shared key with no X-Agent-ID keeps working (dashboard Debug page)", async () => {
    const res = await authedFetch("/api/db-query", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT 1 AS one" }),
    });

    expect(res.status).toBe(200);
  });

  // ── Blocking item 3: no-side-effect assertion on denial ─────────────────
  //
  // The original incident (db-query-event-loop-freeze) was a query that ran
  // to completion and froze the API event loop for its full duration. A
  // regression that checks the guard AFTER calling executeReadOnlyQuery (or
  // not at all) would still return 403 eventually but only after the
  // expensive query finished — status-code-only assertions can't catch that.
  // This recursive CTE takes multiple seconds if it actually executes; a
  // denial must land near-instantly and must not carry query-result fields.
  test("denial happens before the query executes — no side effect", async () => {
    const expensiveSql =
      "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 20000000) " +
      "SELECT count(*) FROM cnt";
    const start = performance.now();
    const res = await authedFetch("/api/db-query", {
      method: "POST",
      agentId: workerAgentId,
      body: JSON.stringify({ sql: expensiveSql }),
    });
    const elapsed = performance.now() - start;

    expect(res.status).toBe(403);
    expect(elapsed).toBeLessThan(1000);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.columns).toBeUndefined();
    expect(body.rows).toBeUndefined();
  });

  // ── Blocking item 3: malformed grant values fail closed ─────────────────

  test.each([
    ["TRUE"],
    ["1"],
    [""],
  ])("a DB_QUERY_ALLOWED value of %j fails closed", async (value) => {
    const agentId = createAgent({
      name: `http-rbac-malformed-${value || "empty"}`,
      isLead: false,
      status: "idle",
    }).id;
    upsertSwarmConfig({ scope: "agent", scopeId: agentId, key: "DB_QUERY_ALLOWED", value });

    const res = await authedFetch("/api/db-query", {
      method: "POST",
      agentId,
      body: JSON.stringify({ sql: "SELECT 1" }),
    });

    expect(res.status).toBe(403);
  });

  test("an agent with no DB_QUERY_ALLOWED row at all fails closed", async () => {
    const agentId = createAgent({
      name: "http-rbac-never-granted",
      isLead: false,
      status: "idle",
    }).id;

    const res = await authedFetch("/api/db-query", {
      method: "POST",
      agentId,
      body: JSON.stringify({ sql: "SELECT 1" }),
    });

    expect(res.status).toBe(403);
  });

  // ── Blocking item 3: script-bridge identity survives to the guard ───────

  test("an ungranted non-lead agent is denied via the script SDK bridge (/api/mcp-bridge)", async () => {
    const res = await authedFetch("/api/mcp-bridge", {
      method: "POST",
      agentId: workerAgentId,
      body: JSON.stringify({ tool: "db-query", args: { sql: "SELECT 1" } }),
    });

    const body = (await res.json()) as { success: boolean; message: string };
    expect(body.success).toBe(false);
    expect(body.message).toBe(
      "Only the lead agent, or an agent explicitly granted db-query access, can run this query.",
    );
  });

  test("a granted non-lead agent is allowed via the script SDK bridge (/api/mcp-bridge)", async () => {
    const res = await authedFetch("/api/mcp-bridge", {
      method: "POST",
      agentId: grantedWorkerAgentId,
      body: JSON.stringify({ tool: "db-query", args: { sql: "SELECT 1 AS one" } }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  // ── Blocking item 2: config write path can no longer mint its own grant ─

  test("a non-lead agent cannot self-grant DB_QUERY_ALLOWED via config write", async () => {
    const res = await authedFetch("/api/config", {
      method: "PUT",
      agentId: workerAgentId,
      body: JSON.stringify({
        scope: "agent",
        scopeId: workerAgentId,
        key: "DB_QUERY_ALLOWED",
        value: "true",
      }),
    });

    expect(res.status).toBe(403);

    // No side effect: the write must not have landed — the agent still
    // cannot run db-query afterward.
    const dbRes = await authedFetch("/api/db-query", {
      method: "POST",
      agentId: workerAgentId,
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(dbRes.status).toBe(403);
  });

  test("a non-lead agent cannot grant DB_QUERY_ALLOWED to a different agent either", async () => {
    const targetAgentId = createAgent({
      name: "http-rbac-collusion-target",
      isLead: false,
      status: "idle",
    }).id;

    const res = await authedFetch("/api/config", {
      method: "PUT",
      agentId: workerAgentId,
      body: JSON.stringify({
        scope: "agent",
        scopeId: targetAgentId,
        key: "DB_QUERY_ALLOWED",
        value: "true",
      }),
    });

    expect(res.status).toBe(403);
  });

  test("the lead agent can grant another agent DB_QUERY_ALLOWED via config write", async () => {
    const targetAgentId = createAgent({
      name: "http-rbac-lead-grant-target",
      isLead: false,
      status: "idle",
    }).id;

    const res = await authedFetch("/api/config", {
      method: "PUT",
      agentId: leadAgentId,
      body: JSON.stringify({
        scope: "agent",
        scopeId: targetAgentId,
        key: "DB_QUERY_ALLOWED",
        value: "true",
      }),
    });

    expect(res.status).toBe(200);

    const dbRes = await authedFetch("/api/db-query", {
      method: "POST",
      agentId: targetAgentId,
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(dbRes.status).toBe(200);
  });

  test("operator/dashboard provisioning (no X-Agent-ID) can still write DB_QUERY_ALLOWED", async () => {
    const targetAgentId = createAgent({
      name: "http-rbac-dashboard-grant-target",
      isLead: false,
      status: "idle",
    }).id;

    const res = await authedFetch("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        scope: "agent",
        scopeId: targetAgentId,
        key: "DB_QUERY_ALLOWED",
        value: "true",
      }),
    });

    expect(res.status).toBe(200);
  });
});
