import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, createAgent, getTaskById, initDb } from "../be/db";
import { registerSendTaskTool, sendTaskInputSchema } from "../tools/send-task";

const TEST_DB_PATH = "./test-send-task-output-schema.sqlite";

const LEAD_ID = "11111111-1111-4111-a111-111111111111";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callSendTask(
  server: McpServer,
  args: Record<string, unknown>,
  callerAgentId: string,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["send-task"];
  if (!tool) throw new Error("send-task not registered");
  const extra = {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": callerAgentId } },
  };
  return tool.handler(args, extra);
}

function structuredOf(result: CallToolResult) {
  return result.structuredContent as {
    success: boolean;
    task?: { id: string; outputSchema?: Record<string, unknown> };
    message: string;
  };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  closeDb();
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "Test Lead", isLead: true, status: "idle" });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("sendTaskInputSchema: outputSchema field validation", () => {
  test("accepts a well-formed JSON Schema object", () => {
    const result = sendTaskInputSchema.safeParse({
      task: "do the thing",
      outputSchema: {
        type: "object",
        required: ["verdict"],
        properties: { verdict: { type: "string", enum: ["approved", "changes_requested"] } },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects a non-object outputSchema", () => {
    const result = sendTaskInputSchema.safeParse({
      task: "do the thing",
      outputSchema: "not-a-schema",
    });
    expect(result.success).toBe(false);
  });

  test("is absent by default — omitting it still validates", () => {
    const result = sendTaskInputSchema.safeParse({ task: "do the thing" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputSchema).toBeUndefined();
    }
  });
});

describe("send-task: outputSchema propagation", () => {
  const server = new McpServer({ name: "test-send-task-output-schema", version: "1.0.0" });
  registerSendTaskTool(server);

  test("existing callers that omit outputSchema keep working (backwards compatible)", async () => {
    const result = await callSendTask(
      server,
      { task: "unassigned task without a schema", allowDuplicate: true },
      LEAD_ID,
    );
    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.outputSchema).toBeUndefined();
  });

  test("a provided outputSchema is persisted on the created task", async () => {
    const schema = {
      type: "object",
      required: ["verdict", "headSha"],
      properties: {
        verdict: { type: "string", enum: ["approved", "changes_requested"] },
        headSha: { type: "string", const: "abc123" },
      },
    };
    const result = await callSendTask(
      server,
      { task: "unassigned task with a schema", outputSchema: schema, allowDuplicate: true },
      LEAD_ID,
    );
    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = await getTaskById(s.task!.id);
    expect(created?.outputSchema).toEqual(schema);
  });
});
