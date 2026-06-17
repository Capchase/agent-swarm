import { describe, expect, test } from "bun:test";
import {
  isClaimAllowed,
  REQUIRES_HARNESS_TAG_PREFIX,
  REQUIRES_ROLE_TAG_PREFIX,
  requiredHarnessForTask,
  requiredRoleClassForTask,
  roleClassFromTags,
} from "../tasks/role-routing-policy";

// Minimal task shape — isClaimAllowed only reads taskType + tags.
function task(taskType: string | undefined, tags: string[] = []) {
  return { taskType, tags };
}

describe("requiredRoleClassForTask", () => {
  test("coding task types require a coder", () => {
    for (const t of ["feature", "bug", "fix", "chore", "refactor", "implement"]) {
      expect(requiredRoleClassForTask(task(t))).toBe("coder");
    }
  });

  test("review task type requires a reviewer", () => {
    expect(requiredRoleClassForTask(task("review"))).toBe("reviewer");
  });

  test("taskType is case-insensitive", () => {
    expect(requiredRoleClassForTask(task("Feature"))).toBe("coder");
    expect(requiredRoleClassForTask(task("REVIEW"))).toBe("reviewer");
  });

  test("an explicit requires-role tag overrides the taskType mapping", () => {
    // resume tasks carry taskType:"resume" (unmapped) but pin the parent's class
    expect(requiredRoleClassForTask(task("resume", [`${REQUIRES_ROLE_TAG_PREFIX}coder`]))).toBe(
      "coder",
    );
    expect(requiredRoleClassForTask(task("resume", [`${REQUIRES_ROLE_TAG_PREFIX}reviewer`]))).toBe(
      "reviewer",
    );
  });

  test("unmapped task types have no requirement (fail open)", () => {
    expect(requiredRoleClassForTask(task("research"))).toBeNull();
    expect(requiredRoleClassForTask(task("resume"))).toBeNull();
    expect(requiredRoleClassForTask(task(undefined))).toBeNull();
    expect(requiredRoleClassForTask(task("some-random-type"))).toBeNull();
  });

  test("an invalid requires-role tag is ignored (falls back to taskType)", () => {
    expect(requiredRoleClassForTask(task("review", [`${REQUIRES_ROLE_TAG_PREFIX}wizard`]))).toBe(
      "reviewer",
    );
  });
});

describe("tag parsing helpers", () => {
  test("roleClassFromTags reads a valid class only", () => {
    expect(roleClassFromTags([`${REQUIRES_ROLE_TAG_PREFIX}coder`])).toBe("coder");
    expect(roleClassFromTags([`${REQUIRES_ROLE_TAG_PREFIX}nonsense`])).toBeNull();
    expect(roleClassFromTags(["auto-resume"])).toBeNull();
    expect(roleClassFromTags(undefined)).toBeNull();
  });

  test("requiredHarnessForTask reads the harness pin", () => {
    expect(requiredHarnessForTask([`${REQUIRES_HARNESS_TAG_PREFIX}claude`])).toBe("claude");
    expect(requiredHarnessForTask([`${REQUIRES_HARNESS_TAG_PREFIX}codex`])).toBe("codex");
    expect(requiredHarnessForTask(["auto-resume"])).toBeNull();
  });
});

describe("isClaimAllowed — role gating", () => {
  test("reviewer CANNOT claim a coding task", () => {
    const r = isClaimAllowed({ roleClass: "reviewer", harnessProvider: "codex" }, task("feature"));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("coder");
  });

  test("coder CANNOT claim a review task", () => {
    const r = isClaimAllowed({ roleClass: "coder", harnessProvider: "claude" }, task("review"));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("reviewer");
  });

  test("coder CAN claim a coding task", () => {
    expect(
      isClaimAllowed({ roleClass: "coder", harnessProvider: "claude" }, task("chore")).allowed,
    ).toBe(true);
  });

  test("reviewer CAN claim a review task", () => {
    expect(
      isClaimAllowed({ roleClass: "reviewer", harnessProvider: "codex" }, task("review")).allowed,
    ).toBe(true);
  });
});

describe("isClaimAllowed — FAIL OPEN safety invariant", () => {
  test("unknown agent roleClass fails open", () => {
    expect(
      isClaimAllowed({ roleClass: "unknown", harnessProvider: "claude" }, task("feature")).allowed,
    ).toBe(true);
  });

  test("null/undefined agent roleClass fails open", () => {
    expect(
      isClaimAllowed({ roleClass: null, harnessProvider: "claude" }, task("feature")).allowed,
    ).toBe(true);
    expect(
      isClaimAllowed({ roleClass: undefined, harnessProvider: null }, task("review")).allowed,
    ).toBe(true);
  });

  test("unmapped taskType fails open even for a known agent class", () => {
    expect(
      isClaimAllowed({ roleClass: "reviewer", harnessProvider: "codex" }, task("research")).allowed,
    ).toBe(true);
  });
});

describe("isClaimAllowed — harness gate (resume tasks)", () => {
  test("matching role but wrong harness is denied (session is harness-bound)", () => {
    const t = task("resume", [
      `${REQUIRES_ROLE_TAG_PREFIX}coder`,
      `${REQUIRES_HARNESS_TAG_PREFIX}claude`,
    ]);
    const r = isClaimAllowed({ roleClass: "coder", harnessProvider: "codex" }, t);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("harness");
  });

  test("matching role AND matching harness is allowed", () => {
    const t = task("resume", [
      `${REQUIRES_ROLE_TAG_PREFIX}coder`,
      `${REQUIRES_HARNESS_TAG_PREFIX}claude`,
    ]);
    expect(isClaimAllowed({ roleClass: "coder", harnessProvider: "claude" }, t).allowed).toBe(true);
  });

  test("harness gate fails open when the agent harness is unknown", () => {
    const t = task("resume", [
      `${REQUIRES_ROLE_TAG_PREFIX}coder`,
      `${REQUIRES_HARNESS_TAG_PREFIX}claude`,
    ]);
    expect(isClaimAllowed({ roleClass: "coder", harnessProvider: null }, t).allowed).toBe(true);
  });

  test("a wrong-role resume is denied regardless of harness", () => {
    const t = task("resume", [
      `${REQUIRES_ROLE_TAG_PREFIX}coder`,
      `${REQUIRES_HARNESS_TAG_PREFIX}claude`,
    ]);
    // reviewer/pm trying to grab a coder resume — the exact PR #29249 misroute
    expect(isClaimAllowed({ roleClass: "reviewer", harnessProvider: "codex" }, t).allowed).toBe(
      false,
    );
    expect(isClaimAllowed({ roleClass: "pm", harnessProvider: "claude" }, t).allowed).toBe(false);
  });
});
