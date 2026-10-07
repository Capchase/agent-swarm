import { describe, expect, test } from "bun:test";
import { LogLevel } from "@slack/bolt";
import { resolveSlackLogLevel } from "./log-level";

describe("resolveSlackLogLevel", () => {
  test("defaults to INFO when unset", () => {
    expect(resolveSlackLogLevel({})).toBe(LogLevel.INFO);
  });

  test("ignores NODE_ENV=development", () => {
    expect(resolveSlackLogLevel({ NODE_ENV: "development" })).toBe(LogLevel.INFO);
  });

  test("honours SLACK_LOG_LEVEL case-insensitively", () => {
    expect(resolveSlackLogLevel({ SLACK_LOG_LEVEL: "DEBUG" })).toBe(LogLevel.DEBUG);
    expect(resolveSlackLogLevel({ SLACK_LOG_LEVEL: "warn" })).toBe(LogLevel.WARN);
    expect(resolveSlackLogLevel({ SLACK_LOG_LEVEL: "error" })).toBe(LogLevel.ERROR);
  });

  test("falls back to INFO for an unknown value", () => {
    expect(resolveSlackLogLevel({ SLACK_LOG_LEVEL: "verbose" })).toBe(LogLevel.INFO);
  });
});
