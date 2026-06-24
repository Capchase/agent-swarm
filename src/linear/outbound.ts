import { getKv, getRootTaskId } from "../be/db";
import { getTrackerSync, updateTrackerSync } from "../be/db-queries/tracker";
import { ensureToken } from "../oauth/ensure-token";
import type { TrackerSync } from "../tracker/types";
import { workflowEventBus } from "../workflows/event-bus";
import { getLinearClient, resetLinearClient } from "./client";
import {
  endAgentSession,
  postAgentSessionAction,
  postAgentSessionThought,
  taskSessionMap,
} from "./sync";

let subscribed = false;

const LOOP_PREVENTION_WINDOW_MS = 5_000;

interface LinearContext {
  /** Linear AgentSession ID, or undefined when no session is linked. */
  sessionId: string | undefined;
  /** tracker_sync row for the root task, or null when not found. */
  sync: TrackerSync | null;
  /** The root swarm task ID for this task's session. */
  rootTaskId: string;
  /** True when the given taskId IS the root (not a child/descendant). */
  isRoot: boolean;
}

/**
 * Resolve the Linear session context for any task — root OR child/descendant.
 *
 * For root tasks: direct lookup in taskSessionMap + tracker_sync.
 * For child tasks: walks parentTaskId up to the root, then checks the root's
 * session (in-memory map → KV fallback for process-restart resilience) and
 * tracker_sync row.
 */
function resolveLinearContext(taskId: string): LinearContext {
  // Fast path: task is itself tracked (root task)
  const directSession = taskSessionMap.get(taskId);
  const directSync = getTrackerSync("linear", "task", taskId);
  if (directSession !== undefined || directSync !== null) {
    return { sessionId: directSession, sync: directSync, rootTaskId: taskId, isRoot: true };
  }

  // Walk to root and check there
  const rootId = getRootTaskId(taskId);
  if (rootId === taskId) {
    // Already at root but nothing tracked — not a Linear task
    return { sessionId: undefined, sync: null, rootTaskId: taskId, isRoot: true };
  }

  // Check root session: in-memory map first, then KV (survives process restart)
  let rootSession = taskSessionMap.get(rootId);
  if (rootSession === undefined) {
    const kvEntry = getKv("linear:session", rootId);
    rootSession = typeof kvEntry?.value === "string" ? kvEntry.value : undefined;
  }

  const rootSync = getTrackerSync("linear", "task", rootId);
  return { sessionId: rootSession, sync: rootSync, rootTaskId: rootId, isRoot: false };
}

export function initLinearOutboundSync(): void {
  if (subscribed) return;
  subscribed = true;

  workflowEventBus.on("task.created", handleTaskCreated);
  workflowEventBus.on("task.completed", handleTaskCompleted);
  workflowEventBus.on("task.failed", handleTaskFailed);
  workflowEventBus.on("task.cancelled", handleTaskCancelled);
  workflowEventBus.on("task.progress", handleTaskProgress);
  console.log("[Linear] Outbound sync subscribed to event bus");
}

export function teardownLinearOutboundSync(): void {
  if (!subscribed) return;
  subscribed = false;

  workflowEventBus.off("task.created", handleTaskCreated);
  workflowEventBus.off("task.completed", handleTaskCompleted);
  workflowEventBus.off("task.failed", handleTaskFailed);
  workflowEventBus.off("task.cancelled", handleTaskCancelled);
  workflowEventBus.off("task.progress", handleTaskProgress);
  console.log("[Linear] Outbound sync unsubscribed from event bus");
}

async function handleTaskCreated(data: unknown): Promise<void> {
  const { taskId, source } = data as { taskId: string; source?: string };
  if (!taskId) return;

  if (source === "linear") {
    // Root task created by Linear ingestion — use in-memory map (set synchronously in sync.ts)
    const sessionId = taskSessionMap.get(taskId);
    if (!sessionId) return;
    postAgentSessionAction(sessionId, "Processing", `Task ${taskId} assigned to agent`).catch(
      (err) => {
        console.error(`[Linear Outbound] Failed to post action activity for task ${taskId}:`, err);
      },
    );
    return;
  }

  // For non-linear tasks, check if this is a child of a Linear session
  const { sessionId, isRoot } = resolveLinearContext(taskId);
  if (!sessionId || isRoot) return;

  postAgentSessionAction(sessionId, "Sub-task started", `Task ${taskId} created`).catch((err) => {
    console.error(`[Linear Outbound] Failed to post sub-task created activity for ${taskId}:`, err);
  });
}

// Cap parameter length to avoid oversized Linear GraphQL payloads. Linear renders this in the
// AgentSession panel; 2000 chars is plenty for a progress update.
const PROGRESS_PARAMETER_MAX = 2000;

async function handleTaskProgress(data: unknown): Promise<void> {
  const { taskId, progress } = data as { taskId: string; progress?: string };
  if (!taskId || !progress) return;

  // Check in-memory map first (fast path), then fall back to ancestor resolution
  const sessionId = taskSessionMap.get(taskId) ?? resolveLinearContext(taskId).sessionId;
  if (!sessionId) return;

  // Post as `action` activity (renders as a structured card in Linear's AgentSession panel).
  // Per Linear's agentActivityCreate spec, `action` requires BOTH `action` AND `parameter`;
  // the original bug here was passing `progress` as `action` with `parameter` undefined.
  const parameter = progress.slice(0, PROGRESS_PARAMETER_MAX);
  postAgentSessionAction(sessionId, "Progress update", parameter).catch((err) => {
    console.error(`[Linear Outbound] Failed to post progress action for task ${taskId}:`, err);
  });
}

async function handleTaskCompleted(data: unknown): Promise<void> {
  const { taskId, output } = data as { taskId: string; output?: string };
  if (!taskId) return;

  const { sessionId, sync, isRoot } = resolveLinearContext(taskId);

  // Child task completed — post a thought activity so the session stays active
  if (!isRoot) {
    if (sessionId) {
      const shortOutput = output ? ` — ${output.slice(0, 300)}` : "";
      postAgentSessionThought(sessionId, `Sub-task completed: ${taskId}${shortOutput}`).catch(
        (err) => {
          console.error(
            `[Linear Outbound] Failed to post sub-task completed thought for ${taskId}:`,
            err,
          );
        },
      );
    }
    return;
  }

  // Root task completed
  if (!sync) return;
  if (shouldSkipForLoopPrevention(sync)) return;

  const body = output
    ? `Task completed.\n\n+++ Output\n${output.slice(0, 2000)}\n+++`
    : "Task completed.";

  // Prefer AgentSession activity (shows in the agent panel) over issue comment (avoids duplication)
  if (sessionId) {
    endAgentSession(sessionId, body, "response").catch((err) => {
      console.error(`[Linear Outbound] Failed to end AgentSession for task ${taskId}:`, err);
    });
    taskSessionMap.delete(taskId);
    console.log(`[Linear Outbound] Posted completion response to AgentSession for task ${taskId}`);
  } else {
    // No session — fall back to issue comment
    try {
      await ensureToken("linear");
      resetLinearClient(); // Clear cached client so it picks up refreshed token
      const client = getLinearClient();
      if (!client) {
        console.log("[Linear Outbound] No Linear client available, skipping sync for", taskId);
        return;
      }
      const comment = output
        ? `Task completed by swarm agent.\n\n+++ Output\n${output.slice(0, 2000)}\n+++`
        : "Task completed by swarm agent.";
      await client.createComment({ issueId: sync.externalId, body: comment });
      console.log(`[Linear Outbound] Posted completion comment for task ${taskId}`);
    } catch (error) {
      console.error(
        `[Linear Outbound] Failed to sync task completion for ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  updateTrackerSync(sync.id, {
    lastSyncOrigin: "swarm",
    lastSyncedAt: new Date().toISOString(),
  });
}

async function handleTaskFailed(data: unknown): Promise<void> {
  const { taskId, failureReason } = data as { taskId: string; failureReason?: string };
  if (!taskId) return;

  const { sessionId, sync, isRoot } = resolveLinearContext(taskId);

  // Child task failed — post a thought activity so the session stays active
  if (!isRoot) {
    if (sessionId) {
      const shortReason = failureReason ? ` — ${failureReason.slice(0, 300)}` : "";
      postAgentSessionThought(sessionId, `Sub-task failed: ${taskId}${shortReason}`).catch(
        (err) => {
          console.error(
            `[Linear Outbound] Failed to post sub-task failed thought for ${taskId}:`,
            err,
          );
        },
      );
    }
    return;
  }

  // Root task failed
  if (!sync) return;
  if (shouldSkipForLoopPrevention(sync)) return;

  const body = failureReason
    ? `Task failed.\n\n+++ Error Details\n${failureReason.slice(0, 2000)}\n+++`
    : "Task failed.";

  // Prefer AgentSession error activity over issue comment (avoids duplication)
  if (sessionId) {
    endAgentSession(sessionId, body, "error").catch((err) => {
      console.error(`[Linear Outbound] Failed to end AgentSession for task ${taskId}:`, err);
    });
    taskSessionMap.delete(taskId);
    console.log(`[Linear Outbound] Posted failure error to AgentSession for task ${taskId}`);
  } else {
    // No session — fall back to issue comment
    try {
      await ensureToken("linear");
      resetLinearClient(); // Clear cached client so it picks up refreshed token
      const client = getLinearClient();
      if (!client) {
        console.log("[Linear Outbound] No Linear client available, skipping sync for", taskId);
        return;
      }
      const comment = failureReason
        ? `Task failed.\n\n+++ Error Details\n${failureReason.slice(0, 2000)}\n+++`
        : "Task failed.";
      await client.createComment({ issueId: sync.externalId, body: comment });
      console.log(`[Linear Outbound] Posted failure comment for task ${taskId}`);
    } catch (error) {
      console.error(
        `[Linear Outbound] Failed to sync task failure for ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  updateTrackerSync(sync.id, {
    lastSyncOrigin: "swarm",
    lastSyncedAt: new Date().toISOString(),
  });
}

async function handleTaskCancelled(data: unknown): Promise<void> {
  const { taskId } = data as { taskId: string };
  if (!taskId) return;

  const { sessionId, sync, isRoot } = resolveLinearContext(taskId);

  // Child task cancelled — post a thought activity so the session stays active
  if (!isRoot) {
    if (sessionId) {
      postAgentSessionThought(sessionId, `Sub-task cancelled: ${taskId}`).catch((err) => {
        console.error(
          `[Linear Outbound] Failed to post sub-task cancelled thought for ${taskId}:`,
          err,
        );
      });
    }
    return;
  }

  // Root task cancelled
  if (!sync) return;
  if (shouldSkipForLoopPrevention(sync)) return;

  const body = "Task cancelled.";

  if (sessionId) {
    endAgentSession(sessionId, body, "error").catch((err) => {
      console.error(
        `[Linear Outbound] Failed to end AgentSession for cancelled task ${taskId}:`,
        err,
      );
    });
    taskSessionMap.delete(taskId);
    console.log(`[Linear Outbound] Posted cancellation to AgentSession for task ${taskId}`);
  } else {
    try {
      await ensureToken("linear");
      resetLinearClient(); // Clear cached client so it picks up refreshed token
      const client = getLinearClient();
      if (!client) {
        console.log("[Linear Outbound] No Linear client available, skipping sync for", taskId);
        return;
      }
      await client.createComment({ issueId: sync.externalId, body: "Task cancelled by swarm." });
      console.log(`[Linear Outbound] Posted cancellation comment for task ${taskId}`);
    } catch (error) {
      console.error(
        `[Linear Outbound] Failed to sync task cancellation for ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  updateTrackerSync(sync.id, {
    lastSyncOrigin: "swarm",
    lastSyncedAt: new Date().toISOString(),
  });
}

function shouldSkipForLoopPrevention(sync: {
  lastSyncOrigin: string | null;
  lastSyncedAt: string;
}): boolean {
  if (sync.lastSyncOrigin !== "external") return false;
  const lastSyncTime = new Date(sync.lastSyncedAt).getTime();
  if (Number.isNaN(lastSyncTime)) return false;
  return Date.now() - lastSyncTime < LOOP_PREVENTION_WINDOW_MS;
}
