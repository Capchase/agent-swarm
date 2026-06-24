/**
 * Regression tests for `updated_by` population on schedule and workflow UPDATE paths.
 *
 * Verifies:
 * - `updated_by` is stamped when a source task with a human requester is present.
 * - A pure-automation update (no source task / no human requester) does NOT clobber
 *   an existing `updated_by` value or cause a crash.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  createUser,
  createWorkflow,
  getScheduledTaskById,
  getWorkflow,
  initDb,
  updateScheduledTask,
  updateWorkflow,
} from "../be/db";
import { registerUpdateScheduleTool } from "../tools/schedules/update-schedule";
import { registerPatchWorkflowTool } from "../tools/workflows/patch-workflow";
import { registerUpdateWorkflowTool } from "../tools/workflows/update-workflow";

const TEST_DB_PATH = "./test-audit-updated-by.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  agentId: string,
  sourceTaskId?: string,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`${toolName} not registered`);
  const headers: Record<string, string> = { "x-agent-id": agentId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  return tool.handler(args, {
    sessionId: "test-session",
    requestInfo: { headers },
  });
}

let agentId: string;
let humanUserId: string;
let sourceTaskId: string;

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  const agent = createAgent({ name: "audit-test-agent", isLead: false, status: "idle" });
  agentId = agent.id;

  // Create a real user in the users table (requestedByUserId is a FK)
  const user = createUser({ name: "Audit Test Human", email: "human@example.com" });
  humanUserId = user.id;

  // Create a task with a human requester
  const task = createTaskExtended("test task for audit", {
    agentId,
    requestedByUserId: humanUserId,
  });
  sourceTaskId = task.id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

// ─── Schedule tests ────────────────────────────────────────────────────────────

describe("updateScheduledTask — updated_by column", () => {
  test("direct db call: sets updated_by when provided", () => {
    const schedule = createScheduledTask({
      name: `audit-sched-direct-${Date.now()}`,
      cronExpression: "0 * * * *",
      taskTemplate: "test",
      createdByAgentId: agentId,
      timezone: "UTC",
    });
    expect(schedule.updatedBy).toBeUndefined();

    const updated = updateScheduledTask(schedule.id, {
      description: "patched",
      updatedBy: humanUserId,
    });
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("direct db call: automation update (no updatedBy) does not clobber existing updated_by", () => {
    const schedule = createScheduledTask({
      name: `audit-sched-noclobber-${Date.now()}`,
      cronExpression: "0 * * * *",
      taskTemplate: "test",
      createdByAgentId: agentId,
      timezone: "UTC",
    });

    // Set an initial updated_by
    updateScheduledTask(schedule.id, { description: "first edit", updatedBy: humanUserId });

    // Automation update without updatedBy — must NOT clear existing value
    const after = updateScheduledTask(schedule.id, { description: "automation edit" });
    expect(after?.updatedBy).toBe(humanUserId);
  });
});

describe("update-schedule MCP tool — updated_by column", () => {
  test("stamps updated_by when source task has human requester", async () => {
    const server = new McpServer({ name: "audit-test", version: "1.0.0" });
    registerUpdateScheduleTool(server);

    const schedule = createScheduledTask({
      name: `audit-sched-mcp-${Date.now()}`,
      intervalMs: 60_000,
      taskTemplate: "test",
      createdByAgentId: agentId,
      timezone: "UTC",
    });

    const result = await callTool(
      server,
      "update-schedule",
      { scheduleId: schedule.id, intervalMs: 120_000 },
      agentId,
      sourceTaskId,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const updated = getScheduledTaskById(schedule.id);
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("does not crash or clear updated_by when source task has no human requester", async () => {
    const server = new McpServer({ name: "audit-test-2", version: "1.0.0" });
    registerUpdateScheduleTool(server);

    const schedule = createScheduledTask({
      name: `audit-sched-nouser-${Date.now()}`,
      intervalMs: 60_000,
      taskTemplate: "test",
      createdByAgentId: agentId,
      timezone: "UTC",
    });
    // Pre-stamp
    updateScheduledTask(schedule.id, { updatedBy: humanUserId });

    // Task with no human requester
    const automationTask = createTaskExtended("automation task", { agentId });

    const result = await callTool(
      server,
      "update-schedule",
      { scheduleId: schedule.id, intervalMs: 30_000 },
      agentId,
      automationTask.id,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const after = getScheduledTaskById(schedule.id);
    expect(after?.updatedBy).toBe(humanUserId); // must not be cleared
  });
});

// ─── Workflow tests ────────────────────────────────────────────────────────────

const MINIMAL_DEFINITION = {
  nodes: [{ id: "start", type: "agent-task", config: { task: "hello" }, next: null }],
  onNodeFailure: "fail" as const,
};

describe("updateWorkflow — updated_by column", () => {
  test("direct db call: sets updated_by when provided", () => {
    const wf = createWorkflow({
      name: `audit-wf-direct-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });
    expect(wf.updatedBy).toBeUndefined();

    const updated = updateWorkflow(wf.id, { description: "patched", updatedBy: humanUserId });
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("direct db call: automation update (no updatedBy) does not clobber existing updated_by", () => {
    const wf = createWorkflow({
      name: `audit-wf-noclobber-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });

    updateWorkflow(wf.id, { description: "first edit", updatedBy: humanUserId });
    const after = updateWorkflow(wf.id, { description: "automation edit" });
    expect(after?.updatedBy).toBe(humanUserId);
  });
});

describe("update-workflow MCP tool — updated_by column", () => {
  test("stamps updated_by when source task has human requester", async () => {
    const server = new McpServer({ name: "audit-wf-test", version: "1.0.0" });
    registerUpdateWorkflowTool(server);

    const wf = createWorkflow({
      name: `audit-wf-mcp-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });

    const result = await callTool(
      server,
      "update-workflow",
      { id: wf.id, description: "updated via MCP" },
      agentId,
      sourceTaskId,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const updated = getWorkflow(wf.id);
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("does not clobber updated_by when source task has no human requester", async () => {
    const server = new McpServer({ name: "audit-wf-test-2", version: "1.0.0" });
    registerUpdateWorkflowTool(server);

    const wf = createWorkflow({
      name: `audit-wf-nouser-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });
    updateWorkflow(wf.id, { updatedBy: humanUserId });

    const automationTask = createTaskExtended("automation wf task", { agentId });

    const result = await callTool(
      server,
      "update-workflow",
      { id: wf.id, description: "automation update" },
      agentId,
      automationTask.id,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const after = getWorkflow(wf.id);
    expect(after?.updatedBy).toBe(humanUserId);
  });
});

describe("patch-workflow MCP tool — updated_by column", () => {
  test("stamps updated_by when source task has human requester", async () => {
    const server = new McpServer({ name: "audit-patch-test", version: "1.0.0" });
    registerPatchWorkflowTool(server);

    const wf = createWorkflow({
      name: `audit-patch-mcp-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });

    const result = await callTool(
      server,
      "patch-workflow",
      {
        id: wf.id,
        update: [{ nodeId: "start", node: { config: { task: "updated hello" } } }],
      },
      agentId,
      sourceTaskId,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const updated = getWorkflow(wf.id);
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("does not clobber updated_by on automation patch", async () => {
    const server = new McpServer({ name: "audit-patch-test-2", version: "1.0.0" });
    registerPatchWorkflowTool(server);

    const wf = createWorkflow({
      name: `audit-patch-nouser-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });
    updateWorkflow(wf.id, { updatedBy: humanUserId });

    const automationTask = createTaskExtended("automation patch task", { agentId });

    const result = await callTool(
      server,
      "patch-workflow",
      {
        id: wf.id,
        update: [{ nodeId: "start", node: { config: { task: "auto-patched" } } }],
      },
      agentId,
      automationTask.id,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const after = getWorkflow(wf.id);
    expect(after?.updatedBy).toBe(humanUserId);
  });
});
