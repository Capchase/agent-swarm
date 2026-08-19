import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getSwarmConfigs } from "@/be/db";
import { DbQueryInputShape, executeReadOnlyQuery, resolveDbQuerySql } from "@/http/db-query";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

const MCP_MAX_ROWS = 100;

/** Agent-scoped swarm_config key that grants a non-lead agent db-query access. */
const DB_QUERY_ALLOWED_KEY = "DB_QUERY_ALLOWED";

/**
 * Lead is always allowed. A non-lead agent is allowed only if the lead has
 * explicitly granted it via `set-config` (scope: "agent", key:
 * "DB_QUERY_ALLOWED", value: "true") — that write path is itself lead-gated
 * (src/tools/swarm-config/set-config.ts), so this is a real security
 * boundary, unlike the self-editable `agent.capabilities` field.
 */
function isDbQueryGranted(agentId: string): boolean {
  return (
    getSwarmConfigs({ scope: "agent", scopeId: agentId, key: DB_QUERY_ALLOWED_KEY })[0]?.value ===
    "true"
  );
}

const DbQueryToolInputSchema = z
  .object({
    ...DbQueryInputShape,
    sql: z.string().optional().describe("SQL query (read-only only — writes are rejected)"),
    query: z.string().optional().describe("Deprecated runtime alias for sql."),
    params: z.array(z.any()).optional().default([]).describe("Query parameters"),
  })
  .refine((body) => body.sql !== undefined || body.query !== undefined, {
    message: "Either sql or query is required",
  });

export const registerDbQueryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "db-query",
    {
      title: "Execute database query",
      description:
        "Execute a read-only SQL query against the swarm database. Lead agents, or agents explicitly granted db-query access, only. The database is SQLite inside the API process, and the query runs to completion before the API answers anything else — there is no query timeout yet, so a large query stops the whole API for its full duration. Do NOT use COUNT(*), SUM(...) or typeof() across `session_logs`, `agent_log`, `events` or `task_context_snapshots`. Each holds millions of rows. A `rowid` range does NOT make such a query cheap: it still reads every row in the range. Filter on an indexed column and add LIMIT 1000 or less. Results capped at 100 rows. Results may include sensitive data: `session_logs`/`agent_log` hold plaintext agent transcripts; secret config/OAuth columns return ciphertext, not plaintext.",
      annotations: { readOnlyHint: true },
      inputSchema: DbQueryToolInputSchema,
      outputSchema: swarmToolOutputSchema({
        columns: z.array(z.string()).optional(),
        rows: z.array(z.array(z.any())).optional(),
        elapsed: z.number().optional(),
        total: z.number().optional(),
        truncated: z.boolean().optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
      const granted = requestInfo.agentId ? isDbQueryGranted(requestInfo.agentId) : false;
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId ?? "",
          isLead: callerAgent?.isLead ?? false,
        },
        verb: "db-query.execute",
        resource: { kind: "capability-grant", granted },
        source: "mcp",
      });
      if (!decision.allow || !callerAgent) {
        return toolErr(
          "Only the lead agent, or an agent explicitly granted db-query access, can run this query.",
        );
      }

      try {
        const sql = resolveDbQuerySql(input);
        const params = input.params ?? [];
        const result = executeReadOnlyQuery(sql, params, MCP_MAX_ROWS);
        const truncated = result.total > MCP_MAX_ROWS;

        // Build a simple text table for Claude
        const header = result.columns.join(" | ");
        const separator = result.columns.map(() => "---").join(" | ");
        const dataRows = result.rows.map((row) => row.map((v) => String(v ?? "NULL")).join(" | "));
        const table = [header, separator, ...dataRows].join("\n");
        const suffix = truncated ? `\n(Showing ${MCP_MAX_ROWS} of ${result.total} rows)` : "";
        const details = `${table}${suffix}\n\n${result.total} rows in ${result.elapsed}ms`;

        return toolOk(`${result.total} row(s) in ${result.elapsed}ms`, {
          details,
          data: { ...result, truncated },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolErr(`Query error: ${message}`);
      }
    },
  );
};
