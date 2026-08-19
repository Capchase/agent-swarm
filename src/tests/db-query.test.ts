import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, initDb, upsertSwarmConfig } from "../be/db";
import { DbQueryInputSchema, resolveDbQuerySql } from "../http/db-query";
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
