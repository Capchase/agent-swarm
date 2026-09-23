import { describe, expect, test } from "bun:test";
import { allTasksTerminal, TERMINAL_STATUSES, taskIsRunning } from "./task-activity";

describe("TERMINAL_STATUSES", () => {
  // ReviewAck (review-ack.tsx) and useSession's poll gate (use-sessions.ts)
  // both branch on this set directly — pin its membership so a change here
  // is a deliberate, visible diff rather than a silent behavior shift.
  test("covers exactly the finished statuses", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ["cancelled", "completed", "failed", "superseded"].sort(),
    );
  });

  test("excludes in_progress — a running review must not read as terminal", () => {
    expect(TERMINAL_STATUSES.has("in_progress")).toBe(false);
  });
});

describe("taskIsRunning", () => {
  test("classifies superseded tasks as finished", () => {
    expect(taskIsRunning("superseded")).toBe(false);
  });

  test("preserves active and indeterminate states", () => {
    expect(taskIsRunning("in_progress")).toBe(true);
    expect(taskIsRunning("pending")).toBeUndefined();
  });
});

describe("allTasksTerminal", () => {
  test("false while a delegated worker is still in_progress", () => {
    // Mirrors the real session chain: a completed root ui-turn dispatching a
    // still-running worker task. The session view must keep polling here.
    expect(allTasksTerminal([{ status: "completed" }, { status: "in_progress" }])).toBe(false);
  });

  test("false while the Lead follow-up that carries the answer is still pending", () => {
    expect(
      allTasksTerminal([{ status: "completed" }, { status: "completed" }, { status: "pending" }]),
    ).toBe(false);
  });

  test("true once every task in the chain has reached a terminal status", () => {
    expect(
      allTasksTerminal([{ status: "completed" }, { status: "completed" }, { status: "failed" }]),
    ).toBe(true);
  });
});
