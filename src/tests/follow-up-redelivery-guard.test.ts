import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  findCompletedTaskInThread,
  findRecentCancelledTaskInThread,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import { registerSendTaskTool } from "../tools/send-task";
import type { AgentTask, CreateTaskOptions } from "../types";

const TEST_DB_PATH = "./test-follow-up-redelivery-guard.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore if files don't exist
  }
});

describe("findCompletedTaskInThread", () => {
  test("finds completed tasks in a thread within the time window", async () => {
    const agent = await createAgent({
      name: "dedup-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("test task for thread", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_1",
      slackThreadTs: "1000.0001",
    });

    // Mark as completed
    await completeTask(task.id, "done");

    // Should find the completed task within a 2880-minute (48h) window
    const result = await findCompletedTaskInThread("C_DEDUP_1", "1000.0001", 2880);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);
    expect(result!.status).toBe("completed");
  });

  test("returns null when no completed tasks exist in the thread", async () => {
    const agent = await createAgent({
      name: "dedup-worker-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create a task but don't complete it
    await createTaskExtended("pending task in thread", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_2",
      slackThreadTs: "2000.0001",
    });

    const result = await findCompletedTaskInThread("C_DEDUP_2", "2000.0001", 2880);
    expect(result).toBeNull();
  });

  test("returns null outside the time window", async () => {
    const agent = await createAgent({
      name: "dedup-worker-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("old completed task", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_3",
      slackThreadTs: "3000.0001",
    });

    await completeTask(task.id, "done long ago");

    // Backdate the lastUpdatedAt to 49 hours ago (beyond the 48h window)
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      fortyNineHoursAgo,
      task.id,
    ]);

    // Should not find with a 48 hour window
    const result = await findCompletedTaskInThread("C_DEDUP_3", "3000.0001", 2880);
    expect(result).toBeNull();
  });

  test("returns null for a different thread", async () => {
    const agent = await createAgent({
      name: "dedup-worker-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("task in different thread", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_4",
      slackThreadTs: "4000.0001",
    });

    await completeTask(task.id, "done");

    // Search in a different thread — should not find
    const result = await findCompletedTaskInThread("C_DEDUP_4", "4000.9999", 2880);
    expect(result).toBeNull();
  });
});

describe("follow-up re-delegation guard logic", () => {
  let leadAgent: Awaited<ReturnType<typeof createAgent>>;
  let workerAgent: Awaited<ReturnType<typeof createAgent>>;

  beforeAll(async () => {
    leadAgent = await createAgent({
      name: "guard-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    workerAgent = await createAgent({
      name: "guard-worker",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 5,
    });
  });

  test("blocks re-delegation when source task is a follow-up and thread has completed work", async () => {
    // Step 1: Create and complete a worker task in a Slack thread
    const workerTask = await createTaskExtended("implement feature X", {
      agentId: workerAgent.id,
      slackChannelId: "C_GUARD_1",
      slackThreadTs: "5000.0001",
    });
    await completeTask(workerTask.id, "Feature X implemented");

    // Step 2: Create a follow-up task (as store-progress would)
    const followUpTask = await createTaskExtended("Worker task completed — review needed.", {
      agentId: leadAgent.id,
      source: "system",
      taskType: "follow-up",
      parentTaskId: workerTask.id,
      slackChannelId: "C_GUARD_1",
      slackThreadTs: "5000.0001",
    });

    // Step 3: Simulate the guard logic from send-task.ts
    // The lead's sourceTaskId would be the follow-up task
    const sourceTask = await getTaskById(followUpTask.id);
    expect(sourceTask).not.toBeNull();
    expect(sourceTask!.taskType).toBe("follow-up");
    expect(sourceTask!.slackChannelId).toBe("C_GUARD_1");
    expect(sourceTask!.slackThreadTs).toBe("5000.0001");

    // The guard should find the completed worker task
    const recentCompleted = await findCompletedTaskInThread(
      sourceTask!.slackChannelId!,
      sourceTask!.slackThreadTs!,
      2880,
    );
    expect(recentCompleted).not.toBeNull();
    expect(recentCompleted!.id).toBe(workerTask.id);

    // → Guard would block: re-delegation should be prevented
  });

  test("allows delegation when source task is NOT a follow-up (normal behavior)", async () => {
    // Create a normal Slack task (not a follow-up)
    const slackTask = await createTaskExtended("user asked a question", {
      agentId: leadAgent.id,
      source: "slack",
      taskType: "inbox",
      slackChannelId: "C_GUARD_2",
      slackThreadTs: "6000.0001",
    });

    // Even if there are completed tasks in the thread, guard shouldn't trigger
    // because the source task is not a "follow-up"
    const sourceTask = await getTaskById(slackTask.id);
    expect(sourceTask).not.toBeNull();
    expect(sourceTask!.taskType).not.toBe("follow-up");

    // Guard condition: sourceTask?.taskType === "follow-up" → false
    // → Guard does NOT block: delegation proceeds normally
    const shouldBlock =
      sourceTask?.taskType === "follow-up" && sourceTask.slackThreadTs && sourceTask.slackChannelId;
    expect(shouldBlock).toBeFalsy();
  });

  test("allows delegation when source task is a follow-up but thread has NO completed work", async () => {
    // Create a follow-up task in a thread with no completed work
    const followUpTask = await createTaskExtended("Worker task failed — action needed.", {
      agentId: leadAgent.id,
      source: "system",
      taskType: "follow-up",
      slackChannelId: "C_GUARD_3",
      slackThreadTs: "7000.0001",
    });

    const sourceTask = await getTaskById(followUpTask.id);
    expect(sourceTask).not.toBeNull();
    expect(sourceTask!.taskType).toBe("follow-up");

    // No completed tasks in this thread
    const recentCompleted = await findCompletedTaskInThread(
      sourceTask!.slackChannelId!,
      sourceTask!.slackThreadTs!,
      2880,
    );
    expect(recentCompleted).toBeNull();

    // → Guard does NOT block: first-time delegation is fine
  });

  test("findRecentCancelledTaskInThread finds tasks with status='cancelled'", async () => {
    const agent = await createAgent({
      name: "cancel-thread-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("cancelled work", {
      agentId: agent.id,
      slackChannelId: "C_CANCEL_1",
      slackThreadTs: "9000.0001",
    });
    await cancelTask(task.id, "user cancelled");

    const result = await findRecentCancelledTaskInThread("C_CANCEL_1", "9000.0001", 2880);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);
    expect(result!.status).toBe("cancelled");
  });

  test("findRecentCancelledTaskInThread finds failed tasks with 'cancelled' failureReason", async () => {
    const agent = await createAgent({
      name: "cancel-thread-worker-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("aborted work", {
      agentId: agent.id,
      slackChannelId: "C_CANCEL_2",
      slackThreadTs: "9000.0002",
    });
    await failTask(task.id, "cancelled");

    const result = await findRecentCancelledTaskInThread("C_CANCEL_2", "9000.0002", 2880);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);
    expect(result!.failureReason).toBe("cancelled");
  });

  test("findRecentCancelledTaskInThread finds failed tasks with 'exit 130' failureReason", async () => {
    const agent = await createAgent({
      name: "cancel-thread-worker-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("aborted work via SIGINT", {
      agentId: agent.id,
      slackChannelId: "C_CANCEL_3",
      slackThreadTs: "9000.0003",
    });
    await failTask(task.id, "exit 130: aborted by user");

    const result = await findRecentCancelledTaskInThread("C_CANCEL_3", "9000.0003", 2880);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);
  });

  test("findRecentCancelledTaskInThread ignores plain failed tasks (no cancellation marker)", async () => {
    const agent = await createAgent({
      name: "cancel-thread-worker-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("genuinely failed work", {
      agentId: agent.id,
      slackChannelId: "C_CANCEL_4",
      slackThreadTs: "9000.0004",
    });
    await failTask(task.id, "TypeError: cannot read property of undefined");

    const result = await findRecentCancelledTaskInThread("C_CANCEL_4", "9000.0004", 2880);
    expect(result).toBeNull();
  });

  test("guard bypasses re-delegation block when cancellation is more recent than completion", async () => {
    const channel = "C_BYPASS_1";
    const thread = "10000.0001";

    // Step 1: An old completed task in the thread
    const completedTask = await createTaskExtended("first attempt — completed", {
      agentId: workerAgent.id,
      slackChannelId: channel,
      slackThreadTs: thread,
    });
    await completeTask(completedTask.id, "first attempt done");

    // Backdate to 30 minutes ago so the cancellation is more recent.
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      thirtyMinAgo,
      completedTask.id,
    ]);

    // Step 2: A more-recent cancellation in the same thread
    const cancelledTask = await createTaskExtended("second attempt — cancelled mid-work", {
      agentId: workerAgent.id,
      slackChannelId: channel,
      slackThreadTs: thread,
    });
    await cancelTask(cancelledTask.id, "cancelled");

    // Guard checks:
    const recentCompleted = await findCompletedTaskInThread(channel, thread, 2880);
    const recentCancelled = await findRecentCancelledTaskInThread(channel, thread, 2880);
    expect(recentCompleted).not.toBeNull();
    expect(recentCancelled).not.toBeNull();

    // The bypass condition: cancellation is more recent than completion.
    const cancelledMoreRecent =
      recentCancelled &&
      new Date(recentCancelled.lastUpdatedAt).getTime() >
        new Date(recentCompleted!.lastUpdatedAt).getTime();
    expect(cancelledMoreRecent).toBe(true);

    // → Guard does NOT block: re-delegation is allowed.
  });

  test("guard still blocks when completion is more recent than any cancellation", async () => {
    const channel = "C_BYPASS_2";
    const thread = "11000.0001";

    // Step 1: A cancelled task (older)
    const cancelledTask = await createTaskExtended("attempt 1 — cancelled", {
      agentId: workerAgent.id,
      slackChannelId: channel,
      slackThreadTs: thread,
    });
    await cancelTask(cancelledTask.id, "cancelled");

    // Backdate the cancellation to 30 minutes ago
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      thirtyMinAgo,
      cancelledTask.id,
    ]);

    // Step 2: A more-recent completion (the retry succeeded)
    const completedTask = await createTaskExtended("attempt 2 — completed", {
      agentId: workerAgent.id,
      slackChannelId: channel,
      slackThreadTs: thread,
    });
    await completeTask(completedTask.id, "retry succeeded");

    // Guard:
    const recentCompleted = await findCompletedTaskInThread(channel, thread, 2880);
    const recentCancelled = await findRecentCancelledTaskInThread(channel, thread, 2880);
    expect(recentCompleted).not.toBeNull();
    expect(recentCancelled).not.toBeNull();

    const cancelledMoreRecent =
      recentCancelled &&
      new Date(recentCancelled.lastUpdatedAt).getTime() >
        new Date(recentCompleted!.lastUpdatedAt).getTime();
    expect(cancelledMoreRecent).toBe(false);

    // → Guard BLOCKS as before: the work was already redone successfully.
  });

  test("allows delegation when source task is a follow-up but completed work is outside time window", async () => {
    // Create and complete a worker task, then backdate it
    const oldWorkerTask = await createTaskExtended("old task", {
      agentId: workerAgent.id,
      slackChannelId: "C_GUARD_4",
      slackThreadTs: "8000.0001",
    });
    await completeTask(oldWorkerTask.id, "done long ago");

    // Backdate to 49 hours ago (beyond the 48h window)
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      fortyNineHoursAgo,
      oldWorkerTask.id,
    ]);

    // Create a follow-up in the same thread
    const followUpTask = await createTaskExtended("Worker task completed — review needed.", {
      agentId: leadAgent.id,
      source: "system",
      taskType: "follow-up",
      slackChannelId: "C_GUARD_4",
      slackThreadTs: "8000.0001",
    });

    const sourceTask = await getTaskById(followUpTask.id);
    const recentCompleted = await findCompletedTaskInThread(
      sourceTask!.slackChannelId!,
      sourceTask!.slackThreadTs!,
      2880,
    );
    expect(recentCompleted).toBeNull();

    // → Guard does NOT block: completed work is too old
  });
});

describe("send-task re-delegation guard, end to end", () => {
  type Tool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };
  let sendTask: Tool;
  let leadId: string;
  let workerId: string;

  beforeAll(async () => {
    const server = new McpServer({ name: "follow-up-redelivery-guard", version: "1.0.0" });
    registerSendTaskTool(server);
    sendTask = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[
      "send-task"
    ]!;
    leadId = (
      await createAgent({ name: "e2e-guard-lead", isLead: true, status: "idle", capabilities: [] })
    ).id;
    workerId = (
      await createAgent({
        name: "e2e-guard-worker",
        isLead: false,
        status: "idle",
        capabilities: [],
        maxTasks: 50,
      })
    ).id;
  });

  function callSendTask(task: string, followUpId: string, parentTaskId?: string) {
    return sendTask.handler(
      {
        task,
        agentId: workerId,
        routingReason: "skill",
        routingNote: "worker owns this area of the codebase",
        ...(parentTaskId ? { parentTaskId } : {}),
      },
      {
        sessionId: crypto.randomUUID(),
        requestInfo: { headers: { "x-agent-id": leadId, "x-source-task-id": followUpId } },
      },
    );
  }

  function resultOf(result: CallToolResult) {
    return result.structuredContent as { success: boolean; message: string; task?: AgentTask };
  }

  async function workerTask(
    description: string,
    thread: string,
    outcome: "completed" | "failed",
    options: Partial<CreateTaskOptions> = {},
    failureReason = "boom",
  ) {
    const task = await createTaskExtended(description, {
      agentId: workerId,
      slackChannelId: "C_E2E",
      slackThreadTs: thread,
      ...options,
    });
    if (outcome === "completed") await completeTask(task.id, "done");
    else await failTask(task.id, failureReason);
    return task;
  }

  async function followUpOf(parentId: string, thread: string) {
    return createTaskExtended("Worker task ended — review needed.", {
      agentId: leadId,
      source: "system",
      taskType: "follow-up",
      parentTaskId: parentId,
      slackChannelId: "C_E2E",
      slackThreadTs: thread,
    });
  }

  type ChainOptions = {
    /** Outcome of every worker except the last. */
    stepOutcome?: "completed" | "failed";
    /** Outcome of the last worker. */
    lastOutcome?: "completed" | "failed";
    lastFailureReason?: string;
    followUpConfig?: CreateTaskOptions["followUpConfig"];
  };

  /** worker -> follow-up, `hops` times. Returns the last follow-up and the first worker. */
  async function followUpChain(hops: number, thread: string, chain: ChainOptions = {}) {
    const {
      stepOutcome = "completed",
      lastOutcome = "failed",
      lastFailureReason,
      followUpConfig,
    } = chain;
    let parentId: string | undefined;
    let followUp: AgentTask | undefined;
    let first: AgentTask | undefined;
    for (let hop = 1; hop <= hops; hop++) {
      const last = hop === hops;
      // Keep the last outcome strictly newer than earlier ones in the thread.
      if (last) await Bun.sleep(5);
      const worker = await workerTask(
        `chain step ${hop} in ${thread}`,
        thread,
        last ? lastOutcome : stepOutcome,
        { parentTaskId: parentId, followUpConfig },
        last ? lastFailureReason : undefined,
      );
      first ??= worker;
      followUp = await followUpOf(worker.id, thread);
      parentId = followUp.id;
    }
    return { followUp: followUp!, first: first! };
  }

  test("blocks a follow-up with no instruction (PR #345 replay)", async () => {
    const parent = await workerTask("implement feature Y", "9000.0001", "completed");
    const followUp = await followUpOf(parent.id, "9000.0001");

    const result = resultOf(await callSendTask("implement feature Y", followUp.id));
    expect(result.success).toBe(false);
    expect(result.message.startsWith("Blocked: re-delegation from follow-up task")).toBe(true);
  });

  test("allows a follow-up whose parent has onCompleted", async () => {
    const parent = await workerTask("ship PR #1", "9000.0002", "completed", {
      followUpConfig: { onCompleted: "Dispatch a code review of the PR." },
    });
    const followUp = await followUpOf(parent.id, "9000.0002");

    const result = resultOf(await callSendTask("Review PR #1", followUp.id));
    expect(result.success).toBe(true);
    expect(result.task?.parentTaskId).toBe(followUp.id);
  });

  test("allows a follow-up whose parent failed", async () => {
    await workerTask("an earlier request in the thread", "9000.0003", "completed");
    const parent = await workerTask("deploy the fix", "9000.0003", "failed");
    const followUp = await followUpOf(parent.id, "9000.0003");

    const result = resultOf(await callSendTask("Retry the deploy", followUp.id));
    expect(result.success).toBe(true);
  });

  test("blocks a failed parent's follow-up once the hop limit is reached", async () => {
    const { followUp } = await followUpChain(6, "9000.0004");

    const result = resultOf(await callSendTask("Retry the chain step", followUp.id));
    expect(result.success).toBe(false);
    expect(result.message).toContain("delegation hops");
  });

  test("onFailed instruction does not unlock a completed parent", async () => {
    const parent = await workerTask("migrate the table", "9000.0005", "completed", {
      followUpConfig: { onFailed: "Retry." },
    });
    const followUp = await followUpOf(parent.id, "9000.0005");

    const result = resultOf(await callSendTask("Migrate the table again", followUp.id));
    expect(result.success).toBe(false);
  });

  test("allows a failed parent's follow-up at five hops", async () => {
    const { followUp } = await followUpChain(5, "9000.0006");

    const result = resultOf(await callSendTask("Rerun the flaky billing deploy", followUp.id));
    expect(result.success).toBe(true);
  });

  test("hop limit counts the whole chain past 50 deferred wakes", async () => {
    const thread = "9000.0012";
    const { followUp: fifth } = await followUpChain(5, thread, { stepOutcome: "failed" });
    // Each deferred wake is a new task whose parent is the previous attempt.
    let parentId = fifth.id;
    for (let wake = 1; wake <= 50; wake++) {
      const task = await createTaskExtended(`deferred wake ${wake} in ${thread}`, {
        agentId: workerId,
        parentTaskId: parentId,
        slackChannelId: "C_E2E",
        slackThreadTs: thread,
      });
      parentId = task.id;
    }
    await Bun.sleep(5);
    const last = await workerTask(`final wake in ${thread}`, thread, "failed", {
      parentTaskId: parentId,
    });
    const sixth = await followUpOf(last.id, thread);

    const result = resultOf(await callSendTask("Retry after the deferred wakes", sixth.id));
    expect(result.success).toBe(false);
    expect(result.message).toContain("delegation hops");
  });

  test("hop limit holds when the thread has no completed work", async () => {
    const { followUp } = await followUpChain(6, "9000.0007", { stepOutcome: "failed" });

    const result = resultOf(await callSendTask("Rebuild the search index shards", followUp.id));
    expect(result.success).toBe(false);
    expect(result.message).toContain("delegation hops");
  });

  test("hop limit holds when a cancellation is newer than the completed work", async () => {
    const { followUp } = await followUpChain(6, "9000.0008", {
      lastFailureReason: "cancelled by user",
    });

    const result = resultOf(await callSendTask("Regenerate quarterly invoice PDFs", followUp.id));
    expect(result.success).toBe(false);
    expect(result.message).toContain("delegation hops");
  });

  test("a parentTaskId override gets no instructed bypass", async () => {
    const { followUp, first } = await followUpChain(5, "9000.0009", {
      lastOutcome: "completed",
      followUpConfig: { onCompleted: "Dispatch the next step." },
    });

    const kept = resultOf(
      await callSendTask("Open the release notes draft", followUp.id, followUp.id),
    );
    expect(kept.success).toBe(true);

    const reset = resultOf(
      await callSendTask("Rotate the staging TLS certificates", followUp.id, first.id),
    );
    expect(reset.success).toBe(false);
    expect(reset.message.startsWith("Blocked: re-delegation from follow-up task")).toBe(true);
  });

  /**
   * At five hops, an override to the first worker is refused. The child without
   * an override keeps the count: when it fails, its follow-up is at the limit.
   */
  async function expectOverrideKeepsHopCount(
    followUp: AgentTask,
    first: AgentTask,
    thread: string,
  ) {
    const override = resultOf(
      await callSendTask(`Retry from the first worker in ${thread}`, followUp.id, first.id),
    );
    expect(override.success).toBe(false);
    expect(override.message).toContain("reset the follow-up hop count");

    const kept = resultOf(await callSendTask(`Retry on the chain in ${thread}`, followUp.id));
    expect(kept.success).toBe(true);
    expect(kept.task?.parentTaskId).toBe(followUp.id);

    await failTask(kept.task!.id, "boom");
    const nextFollowUp = await followUpOf(kept.task!.id, thread);
    const next = resultOf(
      await callSendTask(`Retry after the sixth hop in ${thread}`, nextFollowUp.id),
    );
    expect(next.success).toBe(false);
    expect(next.message).toContain("delegation hops");
  }

  test("a parentTaskId override cannot reset the hop count with no completed work", async () => {
    const { followUp, first } = await followUpChain(5, "9000.0010", { stepOutcome: "failed" });
    await expectOverrideKeepsHopCount(followUp, first, "9000.0010");
  });

  test("a parentTaskId override cannot reset the hop count after a newer cancellation", async () => {
    const { followUp, first } = await followUpChain(5, "9000.0011", {
      lastFailureReason: "cancelled by user",
    });
    await expectOverrideKeepsHopCount(followUp, first, "9000.0011");
  });
});
