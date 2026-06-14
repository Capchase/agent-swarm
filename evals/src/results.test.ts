import { describe, expect, test } from "bun:test";
import { summarizeRun } from "./results.ts";
import type { AttemptRow, EvalRunRow } from "./types.ts";

function run(partial: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: "run-1",
    name: null,
    status: "done",
    scenarioIds: ["s1"],
    configIds: ["c1"],
    attemptsPerCell: 3,
    concurrency: 2,
    judgeModel: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    finishedAt: null,
    ...partial,
  };
}

function attempt(partial: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: crypto.randomUUID(),
    runId: "run-1",
    scenarioId: "s1",
    configId: "c1",
    attemptIndex: 0,
    status: "passed",
    retries: 0,
    sandboxId: null,
    apiUrl: null,
    taskIds: [],
    score: null,
    passed: null,
    error: null,
    costUsd: null,
    costSource: null,
    judgeCostUsd: null,
    tokens: null,
    sandbox: null,
    timings: null,
    durationMs: null,
    startedAt: null,
    finishedAt: null,
    ...partial,
  };
}

describe("summarizeRun — v7 §2.1 cell additions", () => {
  test("passed count, pricedAttempts and avgCostUsd aggregate across N attempts", () => {
    const attempts = [
      attempt({ attemptIndex: 0, status: "passed", costUsd: 0.5, score: 0.9 }),
      attempt({ attemptIndex: 1, status: "failed", costUsd: 0.25, score: 0.3 }),
      attempt({ attemptIndex: 2, status: "passed", costUsd: null, score: 0.8 }),
    ];
    const cell = summarizeRun(run(), attempts).cells[0]!;
    expect(cell.attempts).toBe(3);
    expect(cell.passed).toBe(2);
    expect(cell.passedAny).toBe(true);
    expect(cell.pricedAttempts).toBe(2);
    expect(cell.totalCostUsd).toBeCloseTo(0.75);
    expect(cell.avgCostUsd).toBeCloseTo(0.375); // ÷ priced attempts, not all 3
    expect(cell.bestScore).toBeCloseTo(0.9);
  });

  test("unpriced cell: pricedAttempts 0, avgCostUsd null (never NaN)", () => {
    const attempts = [attempt({ status: "failed" }), attempt({ attemptIndex: 1, status: "error" })];
    const cell = summarizeRun(run(), attempts).cells[0]!;
    expect(cell.passed).toBe(0);
    expect(cell.pricedAttempts).toBe(0);
    expect(cell.totalCostUsd).toBeNull();
    expect(cell.avgCostUsd).toBeNull();
  });

  test("$0 harness cost counts as priced", () => {
    const cell = summarizeRun(run(), [attempt({ costUsd: 0 })]).cells[0]!;
    expect(cell.pricedAttempts).toBe(1);
    expect(cell.totalCostUsd).toBe(0);
    expect(cell.avgCostUsd).toBe(0);
  });

  test("empty cell (no attempts yet): zeroed counts, null aggregates", () => {
    const cell = summarizeRun(run(), []).cells[0]!;
    expect(cell.attempts).toBe(0);
    expect(cell.passed).toBe(0);
    expect(cell.pricedAttempts).toBe(0);
    expect(cell.avgCostUsd).toBeNull();
    // Hard rule: nothing in the summary may be NaN/Infinity.
    const flat = JSON.parse(
      JSON.stringify(summarizeRun(run(), []), (_k, v) => {
        if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number");
        return v;
      }),
    );
    expect(flat).toBeDefined();
  });
});
