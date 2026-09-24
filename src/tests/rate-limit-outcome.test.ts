import { describe, expect, test } from "bun:test";
import {
  buildFinalRateLimitWindows,
  classifyRateLimitOutcome,
} from "../commands/rate-limit-outcome";

describe("classifyRateLimitOutcome", () => {
  test("event source: modelRateLimit set gives kind 'model' with source 'event'", () => {
    const nowMs = new Date("2026-09-24T02:05:41.040Z").getTime();
    const outcome = classifyRateLimitOutcome(
      {
        modelRateLimit: {
          window: "seven_day_overage_included",
          model: "fable",
          resetAt: "2026-09-27T00:00:00.000Z",
        },
      },
      undefined,
      nowMs,
    );
    expect(outcome).toEqual({
      kind: "model",
      model: "fable",
      window: "seven_day_overage_included",
      resetsAtSec: 1790467200,
      source: "event",
    });
  });

  test("text source: seven_day.resetsAt in the future gives that value", () => {
    const nowMs = new Date("2026-09-24T02:05:41.040Z").getTime();
    const futureResetsAtSec = Math.floor(nowMs / 1000) + 2 * 24 * 60 * 60;
    const outcome = classifyRateLimitOutcome(
      {
        rateLimitWindows: {
          seven_day: { status: "allowed_warning", resetsAt: futureResetsAtSec, lastSeenAt: "x" },
        },
      },
      "You've reached your Fable limit. Switch to another model to continue.",
      nowMs,
    );
    expect(outcome).toEqual({
      kind: "model",
      model: "fable",
      window: "seven_day_overage_included",
      resetsAtSec: futureResetsAtSec,
      source: "text",
    });
  });

  test("text source: no windows gives now + 86400 seconds", () => {
    const nowMs = new Date("2026-09-24T02:05:41.040Z").getTime();
    const outcome = classifyRateLimitOutcome(
      {},
      "You've reached your Opus limit. Switch to another model to continue.",
      nowMs,
    );
    expect(outcome).toEqual({
      kind: "model",
      model: "opus",
      window: "seven_day_opus",
      resetsAtSec: Math.floor(nowMs / 1000) + 86400,
      source: "text",
    });
  });

  test("a five_hour rejected result gives kind 'key'", () => {
    const nowMs = Date.now();
    const outcome = classifyRateLimitOutcome(
      { rateLimitResetAt: new Date(nowMs + 3600_000).toISOString() },
      undefined,
      nowMs,
    );
    expect(outcome.kind).toBe("key");
  });

  test("a clean result gives kind 'none'", () => {
    const outcome = classifyRateLimitOutcome({}, undefined, Date.now());
    expect(outcome).toEqual({ kind: "none" });
  });

  test("codex credits-exhausted text uses the passed cooldown, not the default", () => {
    const nowMs = Date.now();
    const cooldownMs = 30 * 60 * 1000;
    const outcome = classifyRateLimitOutcome(
      {},
      "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
      nowMs,
      cooldownMs,
    );
    expect(outcome.kind).toBe("key");
    if (outcome.kind === "key") {
      expect(new Date(outcome.rateLimitedUntil).getTime()).toBe(nowMs + cooldownMs);
    }
  });
});

describe("classifyRateLimitOutcome — independent key-wide and model rejections", () => {
  const nowMs = new Date("2026-09-24T02:05:41.040Z").getTime();
  const inOneHourIso = new Date(nowMs + 60 * 60 * 1000).toISOString();

  test("a model event with a key-wide rejection keeps the key-wide cooldown", () => {
    const outcome = classifyRateLimitOutcome(
      {
        rateLimitResetAt: inOneHourIso,
        modelRateLimit: {
          window: "seven_day_overage_included",
          model: "fable",
          resetAt: inOneHourIso,
        },
      },
      undefined,
      nowMs,
    );
    expect(outcome).toEqual({
      kind: "model",
      model: "fable",
      window: "seven_day_overage_included",
      resetsAtSec: Math.floor((nowMs + 60 * 60 * 1000) / 1000),
      source: "event",
      keyRateLimitedUntil: inOneHourIso,
    });
  });

  test("a text-only model rejection with a key-wide rejection keeps the key-wide cooldown", () => {
    const outcome = classifyRateLimitOutcome(
      { rateLimitResetAt: inOneHourIso },
      "You've reached your Fable limit. Switch to another model to continue.",
      nowMs,
    );
    expect(outcome.kind).toBe("model");
    expect(outcome.kind === "model" ? outcome.keyRateLimitedUntil : undefined).toBe(inOneHourIso);
  });

  test("a model rejection alone carries no key-wide cooldown", () => {
    const outcome = classifyRateLimitOutcome(
      {
        modelRateLimit: {
          window: "seven_day_overage_included",
          model: "fable",
          resetAt: inOneHourIso,
        },
      },
      undefined,
      nowMs,
    );
    expect(outcome.kind === "model" ? outcome.keyRateLimitedUntil : "wrong kind").toBeUndefined();
  });
});

describe("buildFinalRateLimitWindows", () => {
  const nowMs = new Date("2026-09-24T02:05:41.040Z").getTime();
  const nowIso = new Date(nowMs).toISOString();
  const earlierIso = new Date(nowMs - 10 * 60 * 1000).toISOString();

  test("an earlier allowed snapshot + a terminal text-only rejection gives ONE rejected entry", () => {
    const sessionWindows = {
      seven_day_overage_included: {
        status: "allowed",
        utilization: 0.4,
        resetsAt: 1790467200,
        lastSeenAt: earlierIso,
      },
      five_hour: {
        status: "allowed",
        utilization: 0.1,
        resetsAt: 1790217000,
        lastSeenAt: earlierIso,
      },
    };
    const outcome = classifyRateLimitOutcome(
      { rateLimitWindows: sessionWindows },
      "You've reached your Fable limit. Switch to another model to continue.",
      nowMs,
    );
    expect(outcome.kind).toBe("model");

    const finalWindows = buildFinalRateLimitWindows(sessionWindows, outcome, nowIso);
    expect(finalWindows?.seven_day_overage_included).toEqual({
      status: "rejected",
      resetsAt: outcome.kind === "model" ? outcome.resetsAtSec : -1,
      lastSeenAt: nowIso,
    });
    // Unrelated session telemetry is still reported in the same payload.
    expect(finalWindows?.five_hour).toEqual(sessionWindows.five_hour);
  });

  test("an event-source rejection keeps the session's own rejected fields", () => {
    const sessionWindows = {
      seven_day_overage_included: {
        status: "rejected",
        utilization: 1,
        resetsAt: 1790467200,
        lastSeenAt: earlierIso,
      },
    };
    const finalWindows = buildFinalRateLimitWindows(
      sessionWindows,
      {
        kind: "model",
        model: "fable",
        window: "seven_day_overage_included",
        resetsAtSec: 1790467200,
        source: "event",
      },
      nowIso,
    );
    expect(finalWindows?.seven_day_overage_included).toEqual({
      status: "rejected",
      utilization: 1,
      resetsAt: 1790467200,
      lastSeenAt: nowIso,
    });
  });

  test("a non-model outcome reports the session telemetry unchanged", () => {
    const sessionWindows = {
      five_hour: { status: "allowed", utilization: 0.1, lastSeenAt: earlierIso },
    };
    expect(buildFinalRateLimitWindows(sessionWindows, { kind: "none" }, nowIso)).toBe(
      sessionWindows,
    );
    expect(buildFinalRateLimitWindows(undefined, { kind: "none" }, nowIso)).toBeUndefined();
  });
});
