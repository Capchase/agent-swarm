import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createTaskExtended, getDb, initDb, startTask } from "../be/db";
import {
  isClaimAllowed,
  REQUIRES_HARNESS_TAG_PREFIX,
  REQUIRES_ROLE_TAG_PREFIX,
} from "../tasks/role-routing-policy";
import { createResumeFollowUp } from "../tasks/worker-follow-up";

const TEST_DB_PATH = "./test-crash-recovery-role-tagging.sqlite";

async function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
}

// createResumeFollowUp needs a lead agent to exist (it assigns the *lead*
// follow-up notification path elsewhere; the resume task itself routes by role).
function seedLead() {
  return createAgent({ id: "lead-rt", name: "Lead", isLead: true, status: "idle" });
}

describe("crash-recovery resume — role/harness tagging", () => {
  beforeAll(async () => {
    await cleanup();
    initDb(TEST_DB_PATH);
    seedLead();
  });

  afterAll(async () => {
    closeDb();
    await cleanup();
  });

  test("a coder/claude parent produces a resume tagged requires-role:coder + requires-harness:claude", () => {
    const coder = createAgent({
      id: "coder-rt",
      name: "Coder RT",
      isLead: false,
      status: "offline", // force the unassigned-pool path
      roleClass: "coder",
      harnessProvider: "claude",
    });
    const parent = createTaskExtended("Implement the thing", {
      agentId: coder.id,
      taskType: "chore",
    });
    startTask(parent.id);

    const result = createResumeFollowUp({ parentId: parent.id, reason: "crash_recovery" });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;

    const tags = result.task.tags;
    expect(tags).toContain(`${REQUIRES_ROLE_TAG_PREFIX}coder`);
    expect(tags).toContain(`${REQUIRES_HARNESS_TAG_PREFIX}claude`);

    // A reviewer/pm cannot claim it; a Claude coder can.
    expect(
      isClaimAllowed({ roleClass: "reviewer", harnessProvider: "codex" }, result.task).allowed,
    ).toBe(false);
    expect(
      isClaimAllowed({ roleClass: "pm", harnessProvider: "claude" }, result.task).allowed,
    ).toBe(false);
    expect(
      isClaimAllowed({ roleClass: "coder", harnessProvider: "claude" }, result.task).allowed,
    ).toBe(true);
    // A Codex coder is blocked too — session resume is harness-bound.
    expect(
      isClaimAllowed({ roleClass: "coder", harnessProvider: "codex" }, result.task).allowed,
    ).toBe(false);
  });

  test("a parent with no role signal produces an untagged resume (fail open)", () => {
    const mystery = createAgent({
      id: "mystery-rt",
      name: "Mystery RT",
      isLead: false,
      status: "offline",
      // no roleClass, no harnessProvider
    });
    const parent = createTaskExtended("Do something unclassified", {
      agentId: mystery.id,
      taskType: "chore",
    });
    startTask(parent.id);

    const result = createResumeFollowUp({ parentId: parent.id, reason: "crash_recovery" });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;

    expect(result.task.tags.some((t) => t.startsWith(REQUIRES_ROLE_TAG_PREFIX))).toBe(false);
    expect(result.task.tags.some((t) => t.startsWith(REQUIRES_HARNESS_TAG_PREFIX))).toBe(false);

    // With no requires-role tag, taskType:"resume" is unmapped → fail open:
    // any agent may claim it (avoids a wedged pool).
    expect(
      isClaimAllowed({ roleClass: "reviewer", harnessProvider: "codex" }, result.task).allowed,
    ).toBe(true);
  });

  test("an unknown-roleClass parent also stays untagged (fail open)", () => {
    const unknown = createAgent({
      id: "unknown-rt",
      name: "Unknown RT",
      isLead: false,
      status: "offline",
      roleClass: "unknown",
      harnessProvider: "claude",
    });
    const parent = createTaskExtended("Unknown class work", {
      agentId: unknown.id,
      taskType: "bug",
    });
    startTask(parent.id);

    const result = createResumeFollowUp({ parentId: parent.id, reason: "crash_recovery" });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;

    expect(result.task.tags.some((t) => t.startsWith(REQUIRES_ROLE_TAG_PREFIX))).toBe(false);
  });
});

describe("getById round-trips roleClass", () => {
  test("createAgent persists roleClass and rowToAgent reads it back", () => {
    const a = createAgent({
      id: "rc-roundtrip",
      name: "RC Roundtrip",
      isLead: false,
      status: "idle",
      roleClass: "reviewer",
    });
    expect(a.roleClass).toBe("reviewer");
    const row = getDb()
      .query<{ role_class: string | null }, [string]>("SELECT role_class FROM agents WHERE id = ?")
      .get("rc-roundtrip");
    expect(row?.role_class).toBe("reviewer");
  });
});
