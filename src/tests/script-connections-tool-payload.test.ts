import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { registerScriptConnectionsTool } from "../tools/script-connections";

const TEST_DB_PATH = "./test-script-connections-tool-payload.sqlite";
const SPEC_BYTES = 8_000_000;

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type ToolResult = {
  structuredContent: {
    truncation?: unknown;
    connections: Array<Record<string, unknown>>;
  };
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

function scriptConnectionsTool() {
  const server = new McpServer({ name: "script-connections-payload-test", version: "1.0.0" });
  registerScriptConnectionsTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["script-connections"];
  if (!tool) throw new Error("script-connections tool not registered");
  return tool;
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  closeDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("script-connections tool payload (SAV-6951)", () => {
  test("list omits the heavy columns and stays under the wire limit", async () => {
    const lead = await createAgent({ name: "payload-lead", isLead: true, status: "idle" });
    await getDbClient().run(
      `INSERT INTO script_connections
         (id, slug, kind, scope, base_url, openapi_spec_json, generated_types, generated_runtime_json)
       VALUES (?, 'heavy', 'openapi', 'global', 'https://api.example.test', ?, ?, ?)`,
      [crypto.randomUUID(), "x".repeat(SPEC_BYTES), "t".repeat(1_000_000), "r".repeat(2_000_000)],
    );

    const result = (await scriptConnectionsTool().handler(
      { action: "list" },
      {
        sessionId: "script-connections-payload-test-session",
        requestInfo: { headers: { "x-agent-id": lead.id } },
      },
    )) as ToolResult;

    const structured = result.structuredContent;
    expect(structured.truncation).toBeUndefined();
    expect(JSON.stringify(structured).length).toBeLessThan(10_000);
    const [connection] = structured.connections;
    expect(connection?.slug).toBe("heavy");
    expect(connection?.openapiSpecJson).toBeUndefined();
    expect(connection?.generatedTypes).toBeUndefined();
    expect(connection?.generatedRuntimeJson).toBeUndefined();
    expect(connection?.openapiSpecBytes).toBe(SPEC_BYTES);
    expect(connection?.generatedTypesBytes).toBe(1_000_000);
    expect(connection?.generatedRuntimeBytes).toBe(2_000_000);
  });
});
