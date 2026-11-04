import { describe, expect, test } from "bun:test";
import { createLogScrubber, describeLogContent } from "../utils/log-redaction";
import {
  CREDENTIAL_CASES,
  PEM,
  PEM_BODY,
  PEM_SEGMENTS,
  PEM_TAIL,
  PROMPT_CASES,
  PROMPT_SENTINEL,
} from "./fixtures/log-redaction-cases";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

describe("log redaction", () => {
  for (const fixture of CREDENTIAL_CASES) {
    test(`masks ${fixture.name}`, () => {
      const output = createLogScrubber()(fixture.wrap(fixture.secret));
      expect(output).not.toContain(fixture.secret);
      expect(output).toContain("[REDACTED]");
    });
  }

  test("cold PEM and short tails from round-3 evidence never reach logs", () => {
    for (const prefix of ["", "[Bootstrap] init\n"]) {
      const scrub = createLogScrubber();
      const output = scrub(`${prefix}${PEM}\n[worker] next`);
      expect(output).not.toContain(PEM_BODY);
      expect(output).not.toContain(PEM_TAIL);
      expect(output).not.toContain("-----");
      expect(output).toContain("[REDACTED]");
      expect(output).toContain("[worker] next");
    }
  });

  test("PEM state survives round-3 flush boundaries and every body line", () => {
    for (const parts of [PEM_SEGMENTS, PEM.split("\n")]) {
      const scrub = createLogScrubber();
      const output = parts.map((part) => scrub(`${part}\n`)).join("");
      expect(output).not.toContain(PEM_BODY);
      expect(output).not.toContain(PEM_TAIL);
      expect(output).not.toContain("-----");
      expect(scrub("[worker] next")).toBe("[worker] next");
    }
  });

  test("multiple PEM types, escaped newlines and unterminated PEM fail closed", () => {
    for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "CERTIFICATE"]) {
      const scrub = createLogScrubber();
      const escaped = PEM.replaceAll("PRIVATE KEY", label).replaceAll("\n", "\\n");
      expect(scrub(`${escaped} ${escaped}`)).toBe("[REDACTED] [REDACTED]");
      expect(scrub(`-----BEGIN ${label}-----\n${PEM_TAIL}`)).toBe("[REDACTED]");
      expect(scrub(`${PEM_TAIL}\n`)).toBe("");
    }
  });

  test("content metadata uses an unrelated identifier and length", () => {
    const summary = describeLogContent(PROMPT_SENTINEL);
    expect(summary).not.toContain(PROMPT_SENTINEL);
    expect(summary).toMatch(/^id=[0-9a-f-]{36} chars=\d+$/);
    expect(describeLogContent(PROMPT_SENTINEL, "session-id")).toBe(
      `id=session-id chars=${PROMPT_SENTINEL.length}`,
    );
  });

  test("quoted multiline assignments hide every continuation until the closing quote", () => {
    for (const quote of ['"', "'"]) {
      const scrub = createLogScrubber();
      const output = [
        scrub(`password=${quote}first\n`),
        scrub(`${PEM_TAIL}\n`),
        scrub(`last${quote} normal diagnostic survives`),
      ].join("");
      expect(output).not.toContain("first");
      expect(output).not.toContain(PEM_TAIL);
      expect(output).not.toContain("last");
      expect(output).toContain("[REDACTED]");
      expect(output).toContain("normal diagnostic survives");
    }
  });

  test("round-3 multiline prompt and output fixtures expose metadata only", () => {
    for (const text of PROMPT_CASES) {
      const output = describeLogContent(text);
      expect(output).not.toContain("SECRET");
      expect(output).toContain(`chars=${text.length}`);
    }
  });

  test(
    "real Bun console and raw streams redact split PEM and credentials before writing",
    async () => {
      const result = expectChildOk(
        await runChild([process.execPath, "src/tests/fixtures/log-redaction-child.ts"]),
        "log redaction child",
      );
      for (const output of [result.stdout, result.stderr]) {
        expect(output).not.toContain(PEM_BODY);
        expect(output).not.toContain(PEM_TAIL);
        for (const fixture of CREDENTIAL_CASES) expect(output).not.toContain(fixture.secret);
        expect(output).not.toContain(PROMPT_SENTINEL);
        expect(output).not.toContain("SECRET");
        expect(output).toContain("[REDACTED]");
        expect(output).toContain("normal diagnostic survives");
        expect(output).toContain("write callbacks completed");
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
