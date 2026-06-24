import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createTaskExtended, initDb, upsertKv } from "../be/db";
import { createTrackerSync, getTrackerSync, updateTrackerSync } from "../be/db-queries/tracker";
import { initLinearOutboundSync, teardownLinearOutboundSync } from "../linear/outbound";
import { taskSessionMap } from "../linear/sync";
import { workflowEventBus } from "../workflows/event-bus";

const TEST_DB_PATH = "./test-linear-outbound-sync.sqlite";

// Mock the Linear client module
const mockCreateComment = mock(() => Promise.resolve({ success: true }));

mock.module("../linear/client", () => ({
  getLinearClient: () => ({
    createComment: mockCreateComment,
  }),
  resetLinearClient: () => {},
}));

// Mock the AgentSession helpers in linear/sync so we can assert which activity type
// the outbound handlers post (`action` vs `thought` vs `response`/`error`).
const mockPostAgentSessionThought = mock(() => Promise.resolve());
const mockPostAgentSessionAction = mock(() => Promise.resolve());
const mockEndAgentSession = mock(() => Promise.resolve());

mock.module("../linear/sync", () => ({
  postAgentSessionThought: mockPostAgentSessionThought,
  postAgentSessionAction: mockPostAgentSessionAction,
  endAgentSession: mockEndAgentSession,
  taskSessionMap,
}));

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("Linear Outbound Sync", () => {
  beforeEach(() => {
    mockCreateComment.mockClear();
    mockPostAgentSessionThought.mockClear();
    mockPostAgentSessionAction.mockClear();
    mockEndAgentSession.mockClear();
    taskSessionMap.clear();
    initLinearOutboundSync();
  });

  afterEach(() => {
    teardownLinearOutboundSync();
    taskSessionMap.clear();
  });

  test("task.completed posts comment to Linear when mapping exists", async () => {
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-completed",
      externalId: "LIN-OUT-COMPLETED",
      externalIdentifier: "ENG-200",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-completed",
      output: "All done!",
    });

    // Allow async handler to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateComment.mock.calls[0] as unknown[];
    const arg = callArgs[0] as { issueId: string; body: string };
    expect(arg.issueId).toBe("LIN-OUT-COMPLETED");
    expect(arg.body).toContain("Task completed");
    expect(arg.body).toContain("All done!");

    // Verify sync record updated
    const updated = getTrackerSync("linear", "task", "outbound-task-completed");
    expect(updated!.lastSyncOrigin).toBe("swarm");
  });

  test("task.failed posts failure comment to Linear", async () => {
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-failed",
      externalId: "LIN-OUT-FAILED",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.failed", {
      taskId: "outbound-task-failed",
      failureReason: "Build error in module X",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateComment.mock.calls[0] as unknown[];
    const arg = callArgs[0] as { issueId: string; body: string };
    expect(arg.issueId).toBe("LIN-OUT-FAILED");
    expect(arg.body).toContain("Task failed");
    expect(arg.body).toContain("Build error in module X");
  });

  test("no-op when no tracker_sync mapping exists", async () => {
    workflowEventBus.emit("task.completed", {
      taskId: "nonexistent-task-id",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  test("loop prevention: skips if lastSyncOrigin is external and recent", async () => {
    const sync = createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-loop",
      externalId: "LIN-OUT-LOOP",
      syncDirection: "bidirectional",
    });

    // Simulate a recent external sync
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "external",
      lastSyncedAt: new Date().toISOString(),
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-loop",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  test("allows sync when lastSyncOrigin is external but old", async () => {
    const sync = createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-old-external",
      externalId: "LIN-OUT-OLD",
      syncDirection: "bidirectional",
    });

    // Set a lastSyncedAt well in the past (10 seconds ago)
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "external",
      lastSyncedAt: new Date(Date.now() - 10_000).toISOString(),
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-old-external",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });

  test("allows sync when lastSyncOrigin is swarm (not external)", async () => {
    const sync = createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-swarm-origin",
      externalId: "LIN-OUT-SWARM",
      syncDirection: "bidirectional",
    });

    updateTrackerSync(sync.id, {
      lastSyncOrigin: "swarm",
      lastSyncedAt: new Date().toISOString(),
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-swarm-origin",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });

  test("task.progress posts an action activity with both action AND parameter when sessionId is mapped", async () => {
    const taskId = "outbound-task-progress";
    taskSessionMap.set(taskId, "linear-session-123");

    workflowEventBus.emit("task.progress", {
      taskId,
      progress: "📋 Reviewing task details",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Posts as `action` so the update renders as a structured card in Linear's AgentSession
    // panel. Linear's spec requires BOTH `action` AND `parameter` for action-type activities;
    // the original bug was calling postAgentSessionAction with only a single string (parameter
    // undefined), which Linear silently rejected.
    expect(mockPostAgentSessionAction).toHaveBeenCalledTimes(1);
    expect(mockPostAgentSessionThought).not.toHaveBeenCalled();

    const args = mockPostAgentSessionAction.mock.calls[0] as unknown[];
    expect(args[0]).toBe("linear-session-123");
    // Both action label and parameter must be present and non-empty
    expect(typeof args[1]).toBe("string");
    expect((args[1] as string).length).toBeGreaterThan(0);
    expect(typeof args[2]).toBe("string");
    expect((args[2] as string).length).toBeGreaterThan(0);
    // Parameter carries the actual progress text
    expect(args[2] as string).toBe("📋 Reviewing task details");
  });

  test("task.progress slices long progress strings into the parameter (cap at 2000)", async () => {
    const taskId = "outbound-task-progress-long";
    taskSessionMap.set(taskId, "linear-session-long");

    const longProgress = "x".repeat(5000);
    workflowEventBus.emit("task.progress", { taskId, progress: longProgress });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionAction).toHaveBeenCalledTimes(1);
    const args = mockPostAgentSessionAction.mock.calls[0] as unknown[];
    expect((args[2] as string).length).toBe(2000);
  });

  test("task.progress is a no-op when no sessionId is mapped for the task", async () => {
    workflowEventBus.emit("task.progress", {
      taskId: "outbound-task-progress-no-session",
      progress: "should be dropped",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionThought).not.toHaveBeenCalled();
    expect(mockPostAgentSessionAction).not.toHaveBeenCalled();
  });

  test("task.progress is a no-op when progress string is missing", async () => {
    taskSessionMap.set("outbound-task-progress-empty", "linear-session-empty");

    workflowEventBus.emit("task.progress", {
      taskId: "outbound-task-progress-empty",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionThought).not.toHaveBeenCalled();
    expect(mockPostAgentSessionAction).not.toHaveBeenCalled();
  });

  test("task.created for Linear-sourced tasks still posts an action activity (with parameter)", async () => {
    const taskId = "outbound-task-created-linear";
    taskSessionMap.set(taskId, "linear-session-created");

    workflowEventBus.emit("task.created", {
      taskId,
      source: "linear",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionAction).toHaveBeenCalledTimes(1);
    expect(mockPostAgentSessionThought).not.toHaveBeenCalled();

    const args = mockPostAgentSessionAction.mock.calls[0] as unknown[];
    expect(args[0]).toBe("linear-session-created");
    expect(args[1]).toBe("Processing");
    // parameter (3rd positional arg) must be present for `action` activities to be valid
    expect(typeof args[2]).toBe("string");
    expect(args[2] as string).toContain(taskId);
  });

  test("teardown removes event listeners", async () => {
    teardownLinearOutboundSync();

    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-teardown",
      externalId: "LIN-OUT-TEARDOWN",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-teardown",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  // ── Child-task forwarding tests ────────────────────────────────────────────
  // These tests create real tasks (for parentTaskId resolution) and use a
  // drain+clear pattern: set up root task + session, wait for any async
  // task.created events from createTaskExtended to drain, clear mocks, then
  // create/emit the child event and assert.

  test("child task created posts sub-task action to Linear session", async () => {
    // Set up root task and session BEFORE child, drain root's task.created event
    const rootTask = createTaskExtended("Root task from Linear issue", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: rootTask.id,
      externalId: "LIN-CHILD-CREATED",
      syncDirection: "bidirectional",
    });
    taskSessionMap.set(rootTask.id, "linear-session-child-created");

    // Drain async task.created from root, then reset mocks
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPostAgentSessionAction.mockClear();

    // Create child task — createTaskExtended fires task.created asynchronously
    const childTask = createTaskExtended("Child sub-task", { parentTaskId: rootTask.id });

    // Wait for the async task.created event to fire and be handled
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionAction).toHaveBeenCalledTimes(1);
    const args = mockPostAgentSessionAction.mock.calls[0] as unknown[];
    expect(args[0]).toBe("linear-session-child-created");
    expect(args[1]).toBe("Sub-task started");
    expect(args[2] as string).toContain(childTask.id);
  });

  test("child task progress posts action to Linear session", async () => {
    const rootTask = createTaskExtended("Root task linear", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: rootTask.id,
      externalId: "LIN-CHILD-PROGRESS",
      syncDirection: "bidirectional",
    });
    taskSessionMap.set(rootTask.id, "linear-session-child-progress");

    const childTask = createTaskExtended("Child sub-task progress", { parentTaskId: rootTask.id });

    // Drain setup events, reset mocks, then emit the specific lifecycle event
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPostAgentSessionAction.mockClear();

    workflowEventBus.emit("task.progress", {
      taskId: childTask.id,
      progress: "Working on sub-task...",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionAction).toHaveBeenCalledTimes(1);
    const args = mockPostAgentSessionAction.mock.calls[0] as unknown[];
    expect(args[0]).toBe("linear-session-child-progress");
    expect(args[2] as string).toBe("Working on sub-task...");
  });

  test("child task completed posts thought (not endAgentSession) to Linear", async () => {
    const rootTask = createTaskExtended("Root task linear complete", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: rootTask.id,
      externalId: "LIN-CHILD-COMPLETE",
      syncDirection: "bidirectional",
    });
    taskSessionMap.set(rootTask.id, "linear-session-child-complete");

    const childTask = createTaskExtended("Child sub-task complete", { parentTaskId: rootTask.id });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPostAgentSessionThought.mockClear();
    mockEndAgentSession.mockClear();

    workflowEventBus.emit("task.completed", {
      taskId: childTask.id,
      output: "Sub-task done!",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Must post a thought, NOT end the session
    expect(mockPostAgentSessionThought).toHaveBeenCalledTimes(1);
    expect(mockEndAgentSession).not.toHaveBeenCalled();

    const args = mockPostAgentSessionThought.mock.calls[0] as unknown[];
    expect(args[0]).toBe("linear-session-child-complete");
    expect(args[1] as string).toContain(childTask.id);
    expect(args[1] as string).toContain("Sub-task done!");
  });

  test("child task failed posts thought (not endAgentSession) to Linear", async () => {
    const rootTask = createTaskExtended("Root task linear fail", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: rootTask.id,
      externalId: "LIN-CHILD-FAIL",
      syncDirection: "bidirectional",
    });
    taskSessionMap.set(rootTask.id, "linear-session-child-fail");

    const childTask = createTaskExtended("Child sub-task fail", { parentTaskId: rootTask.id });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPostAgentSessionThought.mockClear();
    mockEndAgentSession.mockClear();

    workflowEventBus.emit("task.failed", {
      taskId: childTask.id,
      failureReason: "Build error!",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionThought).toHaveBeenCalledTimes(1);
    expect(mockEndAgentSession).not.toHaveBeenCalled();

    const args = mockPostAgentSessionThought.mock.calls[0] as unknown[];
    expect(args[0]).toBe("linear-session-child-fail");
    expect(args[1] as string).toContain(childTask.id);
    expect(args[1] as string).toContain("Build error!");
  });

  test("child task cancelled posts thought to Linear", async () => {
    const rootTask = createTaskExtended("Root task linear cancel", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: rootTask.id,
      externalId: "LIN-CHILD-CANCEL",
      syncDirection: "bidirectional",
    });
    taskSessionMap.set(rootTask.id, "linear-session-child-cancel");

    const childTask = createTaskExtended("Child sub-task cancel", { parentTaskId: rootTask.id });

    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPostAgentSessionThought.mockClear();
    mockEndAgentSession.mockClear();

    workflowEventBus.emit("task.cancelled", { taskId: childTask.id });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionThought).toHaveBeenCalledTimes(1);
    expect(mockEndAgentSession).not.toHaveBeenCalled();

    const args = mockPostAgentSessionThought.mock.calls[0] as unknown[];
    expect(args[0]).toBe("linear-session-child-cancel");
    expect(args[1] as string).toContain(childTask.id);
  });

  test("session resolved from KV when not in in-memory map (process restart simulation)", async () => {
    // Simulate process restart: session ID is in KV but not in taskSessionMap
    const rootTask = createTaskExtended("Root task kv session", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: rootTask.id,
      externalId: "LIN-KV-SESSION",
      syncDirection: "bidirectional",
    });
    // Persist session ID to KV (as sync.ts does) but do NOT set taskSessionMap
    upsertKv({
      namespace: "linear:session",
      key: rootTask.id,
      value: "kv-session-id",
      valueType: "string",
    });

    const childTask = createTaskExtended("Child after restart", { parentTaskId: rootTask.id });

    // Drain setup events, reset mocks
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPostAgentSessionAction.mockClear();

    workflowEventBus.emit("task.progress", {
      taskId: childTask.id,
      progress: "progress after restart",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionAction).toHaveBeenCalledTimes(1);
    const args = mockPostAgentSessionAction.mock.calls[0] as unknown[];
    expect(args[0]).toBe("kv-session-id");
  });

  test("non-Linear tasks (no ancestor tracked) are still no-ops", async () => {
    // Task with no Linear session in its ancestry — drain setup events first
    const orphanTask = createTaskExtended("Orphan task no linear");
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockPostAgentSessionAction.mockClear();
    mockPostAgentSessionThought.mockClear();

    workflowEventBus.emit("task.created", {
      taskId: orphanTask.id,
      source: "mcp",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionAction).not.toHaveBeenCalled();
    expect(mockPostAgentSessionThought).not.toHaveBeenCalled();
  });
});
