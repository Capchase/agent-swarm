/**
 * Tests for capability-based pool routing.
 *
 * Verifies that `getUnassignedTaskIds` correctly filters the pool based on
 * `requiredCapabilities` on tasks vs `capabilities` on the claiming agent.
 *
 * Key invariants:
 * - Tasks with NULL / empty `requiredCapabilities` are claimable by ANY agent
 *   (fail-open / backward-compatible default).
 * - Tasks with non-empty `requiredCapabilities` are ONLY claimable by agents
 *   whose capabilities array contains ALL required values.
 * - Agents with no declared capabilities can only claim unrestricted tasks.
 * - The AgentTaskExecutor config schema accepts and forwards `requiredCapabilities`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getUnassignedTaskIds,
  initDb,
} from "../be/db";
import type { ExecutorMeta } from "../types";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import type { ExecutorDependencies } from "../workflows/executors/base";

const TEST_DB_PATH = "./test-capability-routing.sqlite";

// ─── Shared mock deps (db wired in beforeAll) ─────────────────────────────

const mockDeps: ExecutorDependencies = {
  db: null as unknown as typeof import("../be/db"),
  eventBus: { emit: () => {}, on: () => {}, off: () => {} },
  interpolate: (template: string, ctx: Record<string, unknown>) =>
    template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
      const keys = path.trim().split(".");
      let value: unknown = ctx;
      for (const key of keys) {
        if (value == null || typeof value !== "object") return "";
        value = (value as Record<string, unknown>)[key];
      }
      return value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    }),
};

let workflowId: string;
let runId: string;

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {
    // ignore
  }
  initDb(TEST_DB_PATH);

  const db = await import("../be/db");
  (mockDeps as { db: typeof import("../be/db") }).db = db;

  const wf = createWorkflow({
    name: "test-capability-routing",
    definition: { nodes: [], edges: [] },
  });
  workflowId = wf.id;

  const run = createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
  runId = run.id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeTask(requiredCapabilities?: string[]) {
  return createTaskExtended("test task", {
    source: "workflow",
    requiredCapabilities: requiredCapabilities?.length ? requiredCapabilities : undefined,
  });
}

// ─── getUnassignedTaskIds — capability filter ─────────────────────────────────

describe("getUnassignedTaskIds — capability-based routing", () => {
  test("task with no requiredCapabilities is claimable by agent with no caps", () => {
    const task = makeTask(); // no requirement
    const ids = getUnassignedTaskIds(10, []);
    expect(ids).toContain(task.id);
  });

  test("task with no requiredCapabilities is claimable by agent with caps", () => {
    const task = makeTask();
    const ids = getUnassignedTaskIds(10, ["researcher"]);
    expect(ids).toContain(task.id);
  });

  test("task with requiredCapabilities is NOT claimable by agent with no caps", () => {
    const task = makeTask(["researcher"]);
    const ids = getUnassignedTaskIds(10, []);
    expect(ids).not.toContain(task.id);
  });

  test("task requiring researcher is NOT claimable by coder", () => {
    const task = makeTask(["researcher"]);
    const ids = getUnassignedTaskIds(10, ["coder"]);
    expect(ids).not.toContain(task.id);
  });

  test("task requiring researcher IS claimable by researcher", () => {
    const task = makeTask(["researcher"]);
    const ids = getUnassignedTaskIds(10, ["researcher"]);
    expect(ids).toContain(task.id);
  });

  test("task requiring coder IS claimable by agent with coder + other caps", () => {
    const task = makeTask(["coder"]);
    const ids = getUnassignedTaskIds(10, ["coder", "typescript"]);
    expect(ids).toContain(task.id);
  });

  test("task requiring multiple caps is claimable only when agent has ALL", () => {
    const task = makeTask(["researcher", "nlp"]);
    // Agent with only one of the two required
    expect(getUnassignedTaskIds(10, ["researcher"])).not.toContain(task.id);
    expect(getUnassignedTaskIds(10, ["nlp"])).not.toContain(task.id);
    // Agent with both
    expect(getUnassignedTaskIds(10, ["researcher", "nlp"])).toContain(task.id);
    expect(getUnassignedTaskIds(10, ["researcher", "nlp", "extra"])).toContain(task.id);
  });

  test("no capability substring false-positives (coder vs code-reviewer)", () => {
    const task = makeTask(["coder"]);
    // "code-reviewer" is NOT "coder" — must not match
    expect(getUnassignedTaskIds(10, ["code-reviewer"])).not.toContain(task.id);
    // "coder" itself does match
    expect(getUnassignedTaskIds(10, ["coder"])).toContain(task.id);
  });
});

// ─── AgentTaskExecutor config schema ─────────────────────────────────────────

describe("AgentTaskExecutor — requiredCapabilities in config schema", () => {
  test("schema accepts requiredCapabilities", () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const parsed = executor.configSchema.safeParse({
      template: "Do something",
      requiredCapabilities: ["researcher"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.requiredCapabilities).toEqual(["researcher"]);
    }
  });

  test("schema accepts empty requiredCapabilities array", () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const parsed = executor.configSchema.safeParse({
      template: "Do something",
      requiredCapabilities: [],
    });
    expect(parsed.success).toBe(true);
  });

  test("schema works without requiredCapabilities (backward compat)", () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const parsed = executor.configSchema.safeParse({ template: "Do something" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.requiredCapabilities).toBeUndefined();
    }
  });

  test("execute() creates task with requiredCapabilities stored", async () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const stepId = createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId,
      nodeId: "plan-node",
      nodeType: "agent-task",
    }).id;

    const meta: ExecutorMeta = {
      runId,
      stepId,
      nodeId: "plan-node",
      workflowId,
      dryRun: false,
    };

    const result = await executor.run({
      config: { template: "Research this", requiredCapabilities: ["researcher"] },
      context: {},
      meta,
    });

    expect(result.status).toBe("success");
    const { getTaskById } = await import("../be/db");
    const taskId = (result as { correlationId?: string }).correlationId;
    expect(taskId).toBeDefined();
    const task = getTaskById(taskId!);
    expect(task).toBeDefined();
    expect(task!.requiredCapabilities).toEqual(["researcher"]);
  });

  test("execute() creates task without requiredCapabilities (backward compat)", async () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const stepId = createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId,
      nodeId: "implement-node",
      nodeType: "agent-task",
    }).id;

    const meta: ExecutorMeta = {
      runId,
      stepId,
      nodeId: "implement-node",
      workflowId,
      dryRun: false,
    };

    const result = await executor.run({
      config: { template: "Implement this" },
      context: {},
      meta,
    });

    expect(result.status).toBe("success");
    const { getTaskById } = await import("../be/db");
    const taskId = (result as { correlationId?: string }).correlationId;
    const task = getTaskById(taskId!);
    expect(task!.requiredCapabilities).toBeUndefined();
  });
});
