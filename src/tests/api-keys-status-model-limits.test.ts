import { describe, expect, test } from "bun:test";
import { computeModelLimits } from "../http/api-keys";

/**
 * T7 acceptance: for Aslo's row (task fe35598c-8973-4728-a691-6d039d983101 /
 * FIXTURE_FABLE_REJECTED) before 2026-09-27T00:00:00Z, modelLimits[0] is
 * active. After that time it's inactive. Verified with a mocked clock on
 * both sides of resetsAt=1790467200 (2026-09-27T00:00:00Z).
 */
describe("computeModelLimits", () => {
  const windows = {
    five_hour: { status: "allowed", utilization: 0.05, resetsAt: 1790217000 },
    seven_day: { status: "allowed", utilization: 0.77, resetsAt: 1790467200 },
    seven_day_overage_included: { status: "rejected", resetsAt: 1790467200 },
  };

  test("before resetsAt: active Fable entry", () => {
    const beforeMs = new Date("2026-09-24T02:05:41.040Z").getTime();
    const limits = computeModelLimits(windows, beforeMs);
    expect(limits).toEqual([
      {
        model: "fable",
        window: "seven_day_overage_included",
        resetsAt: 1790467200,
        resetsAtIso: "2026-09-27T00:00:00.000Z",
        active: true,
      },
    ]);
  });

  test("after resetsAt: inactive Fable entry", () => {
    const afterMs = new Date("2026-09-28T00:00:00.000Z").getTime();
    const limits = computeModelLimits(windows, afterMs);
    expect(limits).toEqual([
      {
        model: "fable",
        window: "seven_day_overage_included",
        resetsAt: 1790467200,
        resetsAtIso: "2026-09-27T00:00:00.000Z",
        active: false,
      },
    ]);
  });

  test("no rejected model-scoped window: empty array", () => {
    expect(
      computeModelLimits({ five_hour: { status: "allowed", resetsAt: 1790217000 } }, Date.now()),
    ).toEqual([]);
  });

  test("allowed_warning status on a model window is not a limit", () => {
    expect(
      computeModelLimits(
        { seven_day_opus: { status: "allowed_warning", resetsAt: 1790467200 } },
        Date.now(),
      ),
    ).toEqual([]);
  });

  test("multiple rejected model-scoped windows all appear", () => {
    const nowMs = new Date("2026-09-24T00:00:00.000Z").getTime();
    const limits = computeModelLimits(
      {
        seven_day_overage_included: { status: "rejected", resetsAt: 1790467200 },
        seven_day_opus: { status: "rejected", resetsAt: 1790000000 },
      },
      nowMs,
    );
    expect(limits.map((l) => l.model).sort()).toEqual(["fable", "opus"]);
  });
});
