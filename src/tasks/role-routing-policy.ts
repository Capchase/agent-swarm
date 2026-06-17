import type { AgentTask, RoleClass } from "../types";

/**
 * Role-class-aware task routing policy.
 *
 * Keeps reviewer agents off coding tasks and coders off review tasks by mapping
 * a task to the role-class allowed to claim it, then gating pool-claim and
 * crash-recovery-resume routing against the claiming agent's `roleClass`.
 *
 * SAFETY INVARIANT — FAIL OPEN. A wedged/deadlocked pool (nothing claimable) is
 * far worse than an occasional misroute, so the gate ALLOWS whenever it lacks a
 * clear signal: unmapped taskType, a task with no required class, or an agent
 * whose roleClass is null/`unknown`. Only an unambiguous mismatch denies.
 *
 * This module is pure (types-only import) so it is safe to use from both the
 * API server (poll/claim/send-task) and the resume-routing layer.
 */

/** Tag prefix carrying the role-class a (resume) task must be claimed by. */
export const REQUIRES_ROLE_TAG_PREFIX = "requires-role:";
/** Tag prefix pinning the harness a (resume) task must run on (session-bound). */
export const REQUIRES_HARNESS_TAG_PREFIX = "requires-harness:";

/** Task types that are coding work — only `coder` agents may claim from pool. */
const CODING_TASK_TYPES = new Set([
  "feature",
  "bug",
  "fix",
  "chore",
  "refactor",
  "implement",
]);

/** Task types that are review work — only `reviewer` agents may claim from pool. */
const REVIEW_TASK_TYPES = new Set(["review"]);

const VALID_ROLE_CLASSES = new Set<RoleClass>([
  "coder",
  "reviewer",
  "researcher",
  "pm",
  "ops",
  "content",
  "qa",
  "ux",
  "lead",
  "unknown",
]);

function isRoleClass(value: string): value is RoleClass {
  return VALID_ROLE_CLASSES.has(value as RoleClass);
}

type TaskLike = Pick<AgentTask, "taskType" | "tags">;

/** The role-class pinned by a `requires-role:` tag, if any (and valid). */
export function roleClassFromTags(tags: string[] | undefined): RoleClass | null {
  const tag = tags?.find((t) => t.startsWith(REQUIRES_ROLE_TAG_PREFIX));
  if (!tag) return null;
  const value = tag.slice(REQUIRES_ROLE_TAG_PREFIX.length).trim();
  return isRoleClass(value) ? value : null;
}

/** The harness pinned by a `requires-harness:` tag, if any. */
export function requiredHarnessForTask(tags: string[] | undefined): string | null {
  const tag = tags?.find((t) => t.startsWith(REQUIRES_HARNESS_TAG_PREFIX));
  if (!tag) return null;
  const value = tag.slice(REQUIRES_HARNESS_TAG_PREFIX.length).trim();
  return value.length > 0 ? value : null;
}

/**
 * The role-class a task must be claimed by, or `null` when there is no
 * requirement (→ fail open). An explicit `requires-role:` tag wins (set by
 * crash-recovery resume routing so a resume inherits its parent's class);
 * otherwise it is derived from `taskType`. Unmapped task types → `null`.
 */
export function requiredRoleClassForTask(task: TaskLike): RoleClass | null {
  const tagged = roleClassFromTags(task.tags);
  if (tagged) return tagged;

  const taskType = (task.taskType ?? "").toLowerCase();
  if (REVIEW_TASK_TYPES.has(taskType)) return "reviewer";
  if (CODING_TASK_TYPES.has(taskType)) return "coder";
  return null;
}

export interface ClaimGateAgent {
  roleClass: RoleClass | null | undefined;
  harnessProvider: string | null | undefined;
}

export interface ClaimGateResult {
  allowed: boolean;
  /** Human-readable reason when `allowed` is false. */
  reason?: string;
}

/**
 * Whether `agent` may claim `task` under the role-class policy. Used by the
 * pool auto-claim (poll) and the manual `claim` action. FAILS OPEN on any
 * ambiguity (see module doc). Direct assigns (`send-task`) do NOT call this —
 * they are an intentional Lead override and only log a warning.
 */
export function isClaimAllowed(agent: ClaimGateAgent, task: TaskLike): ClaimGateResult {
  const requiredClass = requiredRoleClassForTask(task);
  // No requirement (unmapped taskType, no tag) → fail open.
  if (!requiredClass) return { allowed: true };

  const agentClass = agent.roleClass ?? null;
  // No signal on the agent → fail open.
  if (!agentClass || agentClass === "unknown") return { allowed: true };

  if (agentClass !== requiredClass) {
    return {
      allowed: false,
      reason: `Task requires roleClass '${requiredClass}' but agent is '${agentClass}'.`,
    };
  }

  // Harness gate — only meaningful for resume tasks that pinned a harness
  // (session resume is harness-bound). Fail open if either side is unknown.
  const requiredHarness = requiredHarnessForTask(task.tags);
  if (requiredHarness && agent.harnessProvider && agent.harnessProvider !== requiredHarness) {
    return {
      allowed: false,
      reason: `Task requires harness '${requiredHarness}' but agent runs '${agent.harnessProvider}'.`,
    };
  }

  return { allowed: true };
}
