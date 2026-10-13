import { afterEach, describe, expect, test } from "bun:test";
import {
  approvalDefaultSlackTarget,
  approvalRequestAutoCancellationDays,
  approvalRequestDefaultTimeoutSeconds,
} from "../be/approval-sweeps";
import { validateConfigValue } from "../be/swarm-config-guard";

const KEY = "APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("approvalRequestAutoCancellationDays", () => {
  test("defaults to 7 when unset", () => {
    delete process.env[KEY];
    expect(approvalRequestAutoCancellationDays()).toBe(7);
  });

  test("reads a positive integer", () => {
    process.env[KEY] = "3";
    expect(approvalRequestAutoCancellationDays()).toBe(3);
  });

  test("reads 0 as disabled", () => {
    process.env[KEY] = "0";
    expect(approvalRequestAutoCancellationDays()).toBe(0);
  });

  test("falls back to 7 for invalid values", () => {
    process.env[KEY] = "abc";
    expect(approvalRequestAutoCancellationDays()).toBe(7);
    process.env[KEY] = "-1";
    expect(approvalRequestAutoCancellationDays()).toBe(7);
  });
});

describe("APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS validator", () => {
  test("accepts a non-negative integer", () => {
    expect(validateConfigValue(KEY, "7")).toBeNull();
    expect(validateConfigValue(KEY, "0")).toBeNull();
  });

  test("rejects negative and non-numeric values", () => {
    expect(typeof validateConfigValue(KEY, "-1")).toBe("string");
    expect(typeof validateConfigValue(KEY, "x")).toBe("string");
  });
});

const TIMEOUT_KEY = "APPROVAL_REQUEST_DEFAULT_TIMEOUT_SECONDS";
const TARGET_KEY = "APPROVAL_DEFAULT_SLACK_TARGET";
const originalTimeout = process.env[TIMEOUT_KEY];
const originalTarget = process.env[TARGET_KEY];
afterEach(() => {
  if (originalTimeout === undefined) delete process.env[TIMEOUT_KEY];
  else process.env[TIMEOUT_KEY] = originalTimeout;
  if (originalTarget === undefined) delete process.env[TARGET_KEY];
  else process.env[TARGET_KEY] = originalTarget;
});

describe("standalone approval defaults", () => {
  test("timeout defaults to 86400 when unset", () => {
    delete process.env[TIMEOUT_KEY];
    expect(approvalRequestDefaultTimeoutSeconds()).toBe(86400);
  });
  test("timeout reads overrides dynamically, including disabled", () => {
    for (const seconds of [30, 0]) {
      process.env[TIMEOUT_KEY] = String(seconds);
      expect(approvalRequestDefaultTimeoutSeconds()).toBe(seconds);
      expect(validateConfigValue(TIMEOUT_KEY, String(seconds))).toBeNull();
    }
  });
  test("invalid timeout falls back and is rejected by config writes", () => {
    for (const value of ["bad", "-1", "1.5"]) {
      process.env[TIMEOUT_KEY] = value;
      expect(approvalRequestDefaultTimeoutSeconds()).toBe(86400);
      expect(validateConfigValue(TIMEOUT_KEY, value)).toBeString();
    }
  });
  test("notice target defaults to none", () => {
    delete process.env[TARGET_KEY];
    expect(approvalDefaultSlackTarget()).toBeUndefined();
    expect(validateConfigValue(TARGET_KEY, "")).toBeNull();
  });
  test("notice target reads valid Slack ids dynamically", () => {
    for (const value of ["C123", "D123", "G123", "U123"]) {
      process.env[TARGET_KEY] = value;
      expect(approvalDefaultSlackTarget()).toBe(value);
      expect(validateConfigValue(TARGET_KEY, value)).toBeNull();
    }
  });
  test("invalid notice target falls back to none and is rejected", () => {
    for (const value of ["#ops", "person@example.com", "C_bad"]) {
      process.env[TARGET_KEY] = value;
      expect(approvalDefaultSlackTarget()).toBeUndefined();
      expect(validateConfigValue(TARGET_KEY, value)).toBeString();
    }
  });
});
