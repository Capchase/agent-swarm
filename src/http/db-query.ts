import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getAgentById, getDb, getSwarmConfigs } from "../be/db";
import { can, type RbacDecision, type RbacPrincipal } from "../rbac";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

/** Agent-scoped swarm_config key that grants a non-lead agent db-query access. */
export const DB_QUERY_ALLOWED_KEY = "DB_QUERY_ALLOWED";

export function isDbQueryGranted(agentId: string): boolean {
  return (
    getSwarmConfigs({ scope: "agent", scopeId: agentId, key: DB_QUERY_ALLOWED_KEY })[0]?.value ===
    "true"
  );
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Resolve the calling principal for db-query.execute, preferring an explicit
 * X-Agent-ID over the shared API key — same pattern as
 * src/http/mcp-servers.ts's mcpServerPrincipal — so an agent cannot use that
 * key to bypass its own lead-or-grant check.
 */
function dbQueryPrincipal(req: IncomingMessage): RbacPrincipal {
  const agentId = singleHeader(req, "x-agent-id");
  if (agentId) {
    const agent = getAgentById(agentId);
    return { kind: "agent", agentId, isLead: agent?.isLead ?? false };
  }

  const auth = getRequestAuth(req);
  if (auth?.kind === "operator") return { kind: "operator" };
  if (auth?.kind === "user") return { kind: "user", userId: auth.userId };
  return { kind: "agent", agentId: "", isLead: false };
}

/**
 * Shared db-query.execute authorization gate used by both the MCP tool
 * (src/tools/db-query.ts) and the direct HTTP route below, so the two paths
 * can never drift. Lead is always allowed. A non-lead agent needs an
 * explicit DB_QUERY_ALLOWED grant. The bare shared API key with no
 * X-Agent-ID (dashboard/operator or authenticated-user context, e.g. the
 * dashboard Debug page) is trusted admin access and stays allowed — same
 * "operator bypasses, agent identity is gated" boundary already used by
 * config.ts's ensureConfigAdmin and mcp-servers.ts's
 * ensureMcpServerPermission. The MCP tool always resolves an agent
 * principal, so this never loosens that path.
 */
export function checkDbQueryAccess(principal: RbacPrincipal, source: "mcp" | "http"): RbacDecision {
  if (principal.kind !== "agent") return { allow: true };

  const granted = principal.isLead ? false : isDbQueryGranted(principal.agentId);
  return can({
    principal,
    verb: "db-query.execute",
    resource: { kind: "capability-grant", granted },
    source,
  });
}

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  elapsed: number;
  total: number;
}

export const DbQueryInputShape = {
  sql: z.string().min(1).max(10_000).optional(),
  query: z.string().min(1).max(10_000).optional().describe("Deprecated runtime alias for sql."),
  params: z.array(z.any()).optional().default([]),
};

export const DbQueryInputSchema = z
  .object(DbQueryInputShape)
  .refine((body) => body.sql !== undefined || body.query !== undefined, {
    message: "Either sql or query is required",
  });

export type DbQueryInput = z.infer<typeof DbQueryInputSchema>;

export function resolveDbQuerySql(input: Pick<DbQueryInput, "sql" | "query">): string {
  return input.sql ?? input.query ?? "";
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim();
}

function assertSingleStatement(sql: string): void {
  const stripped = stripTrailingSemicolon(sql);
  if (stripped.includes(";")) {
    throw new Error("Only one SQL statement is allowed");
  }
}

export function assertSelectOnlyQuery(sql: string): void {
  assertSingleStatement(sql);
  const normalized = stripTrailingSemicolon(sql).toLowerCase();
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
    throw new Error("Metric queries must start with SELECT or WITH");
  }
}

/**
 * Execute a read-only SQL query against the swarm database.
 * Detects write statements via bun:sqlite's columnNames (empty for INSERT/UPDATE/DELETE/DROP).
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

const dbQueryRoute = route({
  method: "post",
  path: "/api/db-query",
  pattern: ["api", "db-query"],
  summary: "Execute a read-only SQL query",
  tags: ["Debug"],
  rbac: { permission: "db-query.execute" },
  body: DbQueryInputSchema,
  responses: {
    200: {
      description: "Query results",
      schema: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.any())),
        elapsed: z.number(),
        total: z.number(),
      }),
    },
    400: { description: "Invalid or disallowed SQL" },
    403: {
      description: "Only the lead agent, or an agent explicitly granted db-query access, may query",
    },
  },
  auth: { apiKey: true },
});

export async function handleDbQuery(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!dbQueryRoute.match(req.method, pathSegments)) {
    return false;
  }

  const parsed = await dbQueryRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  const decision = checkDbQueryAccess(dbQueryPrincipal(req), "http");
  if (!decision.allow) {
    jsonError(
      res,
      "Only the lead agent, or an agent explicitly granted db-query access, can run this query.",
      403,
    );
    return true;
  }

  try {
    const result = executeReadOnlyQuery(resolveDbQuerySql(parsed.body), parsed.body.params);
    json(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    jsonError(res, message);
  }

  return true;
}
