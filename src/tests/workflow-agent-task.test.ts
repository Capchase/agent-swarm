import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  cancelTask,
  closeDb,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getTaskById,
  initDb,
} from "../be/db";
import type { ExecutorMeta } from "../types";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import type { ExecutorDependencies } from "../workflows/executors/base";

const TEST_DB_PATH = "./test-workflow-agent-task.sqlite";

// ─── Mock Dependencies ───────────────────────────────────────

const mockDeps: ExecutorDependencies = {
  db: null as unknown as typeof import("../be/db"),
  eventBus: { emit: () => {}, on: () => {}, off: () => {} },
  interpolate: (template: string, ctx: Record<string, unknown>) => {
    return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
      const keys = path.trim().split(".");
      let value: unknown = ctx;
      for (const key of keys) {
        if (value == null || typeof value !== "object") return "";
        value = (value as Record<string, unknown>)[key];
      }
      if (value == null) return "";
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    });
  },
};

// IDs for workflow prerequisites (set in beforeAll)
let workflowId: string;
let runId: string;
let stepId1: string;
let stepId2: string;

// ─── Setup / Teardown ────────────────────────────────────────

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {
    // File doesn't exist
  }
  initDb(TEST_DB_PATH);

  // Wire up real DB as dependency after init
  const db = await import("../be/db");
  (mockDeps as { db: typeof import("../be/db") }).db = db;

  // Create prerequisite workflow records for FK constraints
  const wf = createWorkflow({
    name: "test-workspace-scoping",
    definition: { nodes: [], edges: [] },
  });
  workflowId = wf.id;

  const run = createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
  runId = run.id;

  const step1 = createWorkflowRunStep({
    id: crypto.randomUUID(),
    runId: run.id,
    nodeId: "test-node-1",
    nodeType: "agent-task",
  });
  stepId1 = step1.id;

  const step2 = createWorkflowRunStep({
    id: crypto.randomUUID(),
    runId: run.id,
    nodeId: "test-node-2",
    nodeType: "agent-task",
  });
  stepId2 = step2.id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // File may not exist
    }
  }
});

// ─── Tests ───────────────────────────────────────────────────

describe("AgentTaskExecutor — workspace scoping", () => {
  test("config schema accepts dir, vcsRepo, model, modelTier, parentTaskId", () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const config = {
      template: "Do something",
      dir: "/workspace/repos/my-project",
      vcsRepo: "org/repo",
      model: "sonnet",
      modelTier: "smart",
      effort: "high",
      parentTaskId: "f1b14078-5df1-457d-88a2-33f1d3e621fd",
    };
    const parsed = executor.configSchema.safeParse(config);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dir).toBe("/workspace/repos/my-project");
      expect(parsed.data.vcsRepo).toBe("org/repo");
      expect(parsed.data.model).toBe("sonnet");
      expect(parsed.data.modelTier).toBe("smart");
      expect(parsed.data.effort).toBe("high");
      expect(parsed.data.parentTaskId).toBe("f1b14078-5df1-457d-88a2-33f1d3e621fd");
    }
  });

  test("config schema works without optional workspace fields", () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const config = { template: "Do something" };
    const parsed = executor.configSchema.safeParse(config);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dir).toBeUndefined();
      expect(parsed.data.vcsRepo).toBeUndefined();
      expect(parsed.data.model).toBeUndefined();
      expect(parsed.data.parentTaskId).toBeUndefined();
    }
  });

  test("config schema rejects empty dir string", () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const config = { template: "Do something", dir: "" };
    const parsed = executor.configSchema.safeParse(config);
    expect(parsed.success).toBe(false);
  });

  test("config schema rejects invalid parentTaskId (not UUID)", () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const config = { template: "Do something", parentTaskId: "not-a-uuid" };
    const parsed = executor.configSchema.safeParse(config);
    expect(parsed.success).toBe(false);
  });

  test("execute() creates task with workspace fields forwarded", async () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const config = {
      template: "List files in workspace",
      dir: "/workspace/repos/agent-swarm",
      vcsRepo: "desplega-ai/agent-swarm",
      model: "sonnet",
    };
    const meta: ExecutorMeta = {
      runId,
      stepId: stepId1,
      nodeId: "test-node-1",
      workflowId,
      dryRun: false,
    };

    const result = await executor.run({ config, context: {}, meta });

    expect(result.status).toBe("success");
    const taskId = (result as { correlationId?: string }).correlationId;
    expect(taskId).toBeDefined();

    const task = getTaskById(taskId!);
    expect(task).toBeDefined();
    expect(task!.dir).toBe("/workspace/repos/agent-swarm");
    expect(task!.vcsRepo).toBe("desplega-ai/agent-swarm");
    expect(task!.model).toBeUndefined();
    expect(task!.modelTier).toBe("regular");
    expect(task!.source).toBe("workflow");
  });

  test("execute() creates task without workspace fields (backward compat)", async () => {
    const executor = new AgentTaskExecutor(mockDeps);
    const config = { template: "Simple task" };
    const meta: ExecutorMeta = {
      runId,
      stepId: stepId2,
      nodeId: "test-node-2",
      workflowId,
      dryRun: false,
    };

    const result = await executor.run({ config, context: {}, meta });

    expect(result.status).toBe("success");
    const taskId = (result as { correlationId?: string }).correlationId;
    expect(taskId).toBeDefined();

    const task = getTaskById(taskId!);
    expect(task).toBeDefined();
    expect(task!.dir).toBeUndefined();
    expect(task!.vcsRepo).toBeUndefined();
    expect(task!.model).toBeUndefined();
  });
});

describe("AgentTaskExecutor — retry idempotency (Defect D)", () => {
  test("re-running execute() after the existing task is cancelled (terminal, not completed) creates a fresh task instead of waiting on the dead one forever", async () => {
    const wf = createWorkflow({
      name: "test-retry-terminal",
      definition: { nodes: [], edges: [] },
    });
    const run = createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
    const step = createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "retry-node",
      nodeType: "agent-task",
    });
    const meta: ExecutorMeta = {
      runId: run.id,
      stepId: step.id,
      nodeId: "retry-node",
      workflowId: wf.id,
      dryRun: false,
    };
    const executor = new AgentTaskExecutor(mockDeps);
    const config = { template: "Do the retryable thing" };

    // First attempt: creates a task, returns the async "wait" marker.
    const firstResult = await executor.run({ config, context: {}, meta });
    expect(firstResult.status).toBe("success");
    const firstTaskId = (firstResult as { correlationId?: string }).correlationId;
    expect(firstTaskId).toBeDefined();

    // Simulate the retry-poller re-invoking the SAME step after the first
    // task reached a terminal (but not "completed") status.
    const cancelled = cancelTask(firstTaskId!, "simulated failure for retry test");
    expect(cancelled?.status).toBe("cancelled");

    const retryResult = await executor.run({ config, context: {}, meta });
    expect(retryResult.status).toBe("success");
    const retryTaskId = (retryResult as { correlationId?: string }).correlationId;
    expect(retryTaskId).toBeDefined();
    // Must be a DIFFERENT task — reusing the dead cancelled one would mean
    // the workflow waits forever on an event that will never fire again.
    expect(retryTaskId).not.toBe(firstTaskId);

    const newTask = getTaskById(retryTaskId!);
    expect(newTask).toBeDefined();
    expect(newTask!.status).not.toBe("cancelled");
  });

  test("re-running execute() while the existing task is still non-terminal (in-flight) returns the wait marker, no duplicate dispatch", async () => {
    const wf = createWorkflow({
      name: "test-retry-inflight",
      definition: { nodes: [], edges: [] },
    });
    const run = createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf.id });
    const step = createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "inflight-node",
      nodeType: "agent-task",
    });
    const meta: ExecutorMeta = {
      runId: run.id,
      stepId: step.id,
      nodeId: "inflight-node",
      workflowId: wf.id,
      dryRun: false,
    };
    const executor = new AgentTaskExecutor(mockDeps);
    const config = { template: "Do the in-flight thing" };

    const firstResult = await executor.run({ config, context: {}, meta });
    const firstTaskId = (firstResult as { correlationId?: string }).correlationId;
    expect(firstTaskId).toBeDefined();
    // Freshly created tasks are non-terminal (e.g. "unassigned"/"pending") —
    // don't mutate status, just re-invoke execute() for the same step.

    const secondResult = await executor.run({ config, context: {}, meta });
    expect(secondResult.status).toBe("success");
    const secondTaskId = (secondResult as { correlationId?: string }).correlationId;
    // Same task — no duplicate dispatch while the original is still alive.
    expect(secondTaskId).toBe(firstTaskId);
  });
});
