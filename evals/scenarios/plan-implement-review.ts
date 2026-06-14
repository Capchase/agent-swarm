import type { TestGroup } from "../src/judge/deterministic.ts";
import { citationsResolve, testGroupsGreen } from "../src/judge/deterministic.ts";
import type { CheckResult, DeterministicCheck, Scenario } from "../src/types.ts";

/**
 * plan-implement-review (v8.0 round-11, Multi-worker + Code, lead + 2 workers)
 * ---------------------------------------------------------------------------
 * Calibrated spread: TODO(calibration) — fill frontierAvg / budgetAvg / gap from
 * the round-11 sweep (anchors: claude-opus-4.8, codex-5.5 vs pi-deepseek-flash,
 * claude-haiku). Ship gate: frontierAvg − budgetAvg ≥ 0.2. Target ~0.3 → 0.8.
 *
 * A LEAD decomposes a three-stage chain — PLAN → IMPLEMENT → REVIEW-with-citations
 * — over a small but non-trivial code task (a token-bucket rate limiter). This is
 * the deepest scenario in the round and the second exerciser (after sql-audit) of
 * the head+tail-transcript communication judge, which is REQUIRED here so the
 * final review text reaches the judge (v8.0 §4 — `plan-implement-review` is the
 * named dependency of that transcript fix).
 *
 * Stage chain (a strict dependency chain — the lead owns stage 1, worker 0 owns
 * stages 2 and 3 on ONE sandbox so the review can cite the very file it built):
 *   1. PLAN (lead, judge-ctx member index 2): the lead reads the written spec
 *      from swarm memory (the spec is seeded into memory so the lead — whose
 *      sandbox is isolated from worker 0's seeded files — can retrieve it),
 *      decomposes it into a design plan, writes ${PLAN_FILE} on its OWN sandbox,
 *      AND publishes the key design decisions back into swarm memory under
 *      ${PLAN_TAG} so worker 0 can consume them. The lead does NOT count toward
 *      the 3-worker cap.
 *   2. IMPLEMENT (worker 0, dependsOn 1): retrieves the lead's plan from memory,
 *      implements ${SRC} so the seeded hidden test suite (ten graded groups)
 *      passes. The seeded stub + tests live on worker 0's sandbox (seed.exec runs
 *      there). Worker 1 is booted as a second hand the lead can delegate to, but
 *      the graded implementation + review are anchored to worker 0's single
 *      sandbox so the citation check resolves against the file actually built.
 *   3. REVIEW (worker 0, dependsOn 2): writes ${REVIEW_FILE} — a code review of
 *      its OWN ${SRC} that MUST cite real `${SRC_BASE}:<line>` locations. The
 *      citations are graded deterministically (do the cited lines exist in the
 *      built file?) AND the communication judge grades whether the review is
 *      SPECIFIC and grounded — citing real code, not vague platitudes.
 *
 * Reuses the lead + WorkerSpec[] + multi-task-chain machinery from the old
 * `roster-demo` scenario (lead boot/routing, `worker: "lead"` agentId-less task
 * creation), generalized to a real lead-driven plan→implement→review chain; and
 * the `seed.exec` heredoc test-suite + graded `testGroupsGreen` machinery from
 * `bug-ladder` for the implementation's correctness.
 *
 * Requires an embedding key in evals/.env (EMBEDDING_API_KEY or OPENAI_API_KEY)
 * for the swarm memory store/search the lead↔worker handoff relies on.
 *
 * Grading:
 *   - `correctness` (weight 3): the FRACTION of the TEN hidden seeded test
 *       groups that pass — graded via `testGroupsGreen` on worker 0 (partial
 *       credit, so a config that implements 7 of 10 behaviors ranks above one that
 *       implements 3). The first five groups pin the headline behaviors (starts
 *       full, remove guard, refill rate, fractional refill, capacity cap); the next
 *       FIVE are the round-11 discriminators — classic token-bucket pitfalls a budget
 *       model routinely gets wrong even when the happy path is green: a non-monotonic
 *       (backwards) clock must NOT refill negatively, `available()` must be a pure
 *       observation that does not consume tokens, `tryRemove(0)` / over-capacity
 *       requests are handled correctly, the fractional remainder is preserved across
 *       interleaved calls (no premature `Math.floor`), and a long interleaved
 *       refill/remove sequence pins the running balance (catches impls that recompute
 *       from `startMs` each call instead of tracking the last-refill timestamp). The
 *       worker never sees the tests; it sees the natural-language spec the lead
 *       planned from, and the spec deliberately UNDER-specifies these edges so the
 *       headline path is achievable but the edges separate frontier from budget.
 *   - `citation-validity` (weight 1, deterministic): NOT merely "any 3 in-range
 *       line numbers". The review's `${SRC_BASE}:<line>` citations must (a) resolve
 *       to REAL in-range lines in the built file (≥3 distinct) AND (b) actually land
 *       on the SPECIFIC lines that implement the limiter's three load-bearing
 *       behaviors — the elapsed→refill arithmetic, the capacity clamp, and the
 *       insufficient-tokens guard — located deterministically by scanning the built
 *       source on the sandbox. A review that cites three convenient one-liners (the
 *       class header, a blank line, the constructor) resolves but lands on none of
 *       the three behavior anchors and is penalized; a review grounded in the real
 *       logic cites them. A hallucinated `ratelimit.ts:999` scores 0 on (a)
 *       regardless. This is the deterministic anti-gaming half — independent of the
 *       judge's prose grading.
 *   - `communication` (weight 1, JUDGE-ONLY): the agentic communication judge
 *       grades the written review's SPECIFICITY — does it cite concrete locations
 *       in the real implementation and call out real strengths/risks, rather than
 *       generic boilerplate? The judge reads ${REVIEW_FILE} AND ${SRC} on worker 0
 *       to verify the cited lines actually contain what the review claims (requires
 *       the v8.0 §4 head+tail transcript + full-roster judge tools). A dimension is
 *       fed by deterministic checks XOR a judge — never both — so the citation
 *       check and the specificity judge live in SEPARATE dimensions (round 11);
 *       the two together carry the old combined communication weight of 2.
 *   - `instruction-following` (weight 1): a deterministic check that the worker
 *       left the seeded hidden test suite BYTE-FOR-BYTE UNMODIFIED — it was told to
 *       implement the source, never to touch the tests — so a config can't "win"
 *       correctness by weakening or deleting the seeded tests.
 *
 * Anti-gaming (checklist applied to THIS scenario):
 *   - The review MUST cite real `${SRC_BASE}:<line>` locations AND those citations
 *     must land on the lines that actually implement the limiter's load-bearing
 *     behaviors (refill arithmetic, capacity clamp, insufficient-tokens guard),
 *     located deterministically by scanning the built file. A hallucinated
 *     `ratelimit.ts:999` is rejected as out-of-range; three convenient citations on
 *     the class header / a blank line / the constructor resolve but hit NO behavior
 *     anchor and are penalized. The file is produced by the worker at runtime, so
 *     its exact line count AND the line each behavior lands on are NOT promptable —
 *     a review can only cite the right lines by actually reading what it built. The
 *     agentic judge independently re-reads the cited lines on worker 0's sandbox to
 *     confirm the review's claims about them are true.
 *   - The correct IMPLEMENTATION is NOT derivable from the prompt: the spec states
 *     the desired BEHAVIORS (refill rate, burst capacity, fractional-token refill,
 *     monotonic clock) but the hidden seeded tests — including the five edge-case
 *     groups (backward clock, pure-observation `available`, zero/over-capacity
 *     removal, fractional-remainder preservation, interleaved-sequence balance) —
 *     are the only ground truth, and they are never shown to the worker. The prompt
 *     names no method body and no expected return value token.
 *   - Correctness is graded by TEST EXECUTION (exit code) on the real sandbox, not
 *     self-report — a worker can't claim green.
 *   - The tests-UNMODIFIED instruction-following check is the primary guard against
 *     gaming correctness by editing/deleting the seeded tests.
 *   - The grading rubric / per-group thresholds / citation criteria are NOT shown
 *     to the workers; the prompts state WHAT to build and that the review must cite
 *     real lines, but not how either is scored.
 */

const PROJECT = "/workspace/pir";
const SRC = `${PROJECT}/src/ratelimit.ts`;
const SRC_BASE = "ratelimit.ts";
const REVIEW_FILE = `${PROJECT}/REVIEW.md`;
// The lead writes its plan onto its OWN sandbox (member index 2).
const PLAN_FILE = "/workspace/pir-lead/PLAN.md";

// Distinctive shared memory tags. The SPEC tag carries the written spec the lead
// reads (the lead's sandbox is isolated from worker 0's seeded files); the PLAN
// tag carries the lead's design decisions for worker 0 to consume. The tags are
// part of the protocol the prompts describe; no answer/ground-truth lives in any
// tag — the ground truth is the hidden seeded test suite.
const SPEC_TAG = "pir-spec-channel-b7q";
const PLAN_TAG = "pir-plan-channel-b7q";

// ---- The seeded stub the worker must complete. A deliberately incomplete
// token-bucket rate limiter: the public surface is fixed (so the hidden tests
// compile and import), but every method body is a stub the worker must implement
// per the spec. The CORRECT bodies are NOT here and NOT in any prompt — only the
// hidden seeded tests pin them down. ----
const STUB_SRC = `// ratelimit — a token-bucket rate limiter. The method bodies below are STUBS.
// Implement them so the project's test suite (under ./test) passes. The public
// surface (constructor signature + method names) is fixed; do NOT change it, and
// do NOT modify anything under test/.
//
// Behavior to implement (the tests pin the exact semantics):
//   - A bucket holds up to \`capacity\` tokens and starts FULL.
//   - \`refillPerSec\` tokens are added per second, accruing fractionally over
//     time (so 0.5s at 2 tokens/sec adds 1 token), capped at \`capacity\`.
//   - \`tryRemove(n, nowMs)\` first refills based on elapsed time since the last
//     call, then removes \`n\` tokens if at least \`n\` are available (returning
//     true) or removes nothing and returns false. \`nowMs\` is a monotonic clock
//     in milliseconds supplied by the caller.
//   - \`available(nowMs)\` refills then returns the current (possibly fractional)
//     token count.

export class RateLimiter {
  // Implementation state is up to you; keep the public surface below intact.

  constructor(
    public readonly capacity: number,
    public readonly refillPerSec: number,
    startMs: number,
  ) {
    // TODO: initialize the bucket (starts FULL) and remember startMs.
    void startMs;
  }

  // Refill based on elapsed time, then return the current token count.
  available(nowMs: number): number {
    // TODO: implement.
    void nowMs;
    return 0;
  }

  // Refill, then remove n tokens if at least n are available. Returns whether the
  // removal succeeded.
  tryRemove(n: number, nowMs: number): boolean {
    // TODO: implement.
    void n;
    void nowMs;
    return false;
  }
}
`;

// ---- Five hidden seeded test groups, each its own file, pinning the exact
// rate-limiter semantics. These are the ONLY ground truth and are checked
// byte-for-byte unmodified by the instruction-following dimension. The worker
// never sees them — it implements from the lead's plan + the spec. ----
const TEST_BUCKET_STARTS_FULL = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("bucket starts full to capacity", () => {
  const rl = new RateLimiter(5, 1, 0);
  expect(rl.available(0)).toBeCloseTo(5, 6);
});

test("a fresh bucket grants a full burst", () => {
  const rl = new RateLimiter(3, 1, 0);
  expect(rl.tryRemove(3, 0)).toBe(true);
  expect(rl.available(0)).toBeCloseTo(0, 6);
});
`;

const TEST_REMOVE_GUARD = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("tryRemove fails when not enough tokens and removes nothing", () => {
  const rl = new RateLimiter(2, 1, 0);
  expect(rl.tryRemove(2, 0)).toBe(true);
  // Only ~0 tokens left immediately; removing 1 must fail and leave the bucket as-is.
  expect(rl.tryRemove(1, 0)).toBe(false);
  expect(rl.available(0)).toBeCloseTo(0, 6);
});
`;

const TEST_REFILL_RATE = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("refills at refillPerSec over elapsed time", () => {
  const rl = new RateLimiter(10, 2, 0);
  expect(rl.tryRemove(10, 0)).toBe(true); // drain
  // 2 tokens/sec for 1000ms -> 2 tokens back.
  expect(rl.available(1000)).toBeCloseTo(2, 6);
});
`;

const TEST_FRACTIONAL_REFILL = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("refill accrues fractionally over sub-second elapsed time", () => {
  const rl = new RateLimiter(10, 2, 0);
  expect(rl.tryRemove(10, 0)).toBe(true); // drain
  // 2 tokens/sec for 500ms -> exactly 1 token.
  expect(rl.available(500)).toBeCloseTo(1, 6);
});
`;

const TEST_CAPACITY_CAP = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("refill never exceeds capacity", () => {
  const rl = new RateLimiter(4, 5, 0);
  expect(rl.tryRemove(4, 0)).toBe(true); // drain
  // 5 tokens/sec for 10s would be 50 tokens, but the cap is 4.
  expect(rl.available(10_000)).toBeCloseTo(4, 6);
});
`;

// ---- Round-11 DISCRIMINATOR test groups. These pin the SUBTLE edges of the
// token-bucket spec that a budget model routinely gets wrong even when the happy
// path is green. The natural-language spec under-specifies them on purpose, so a
// weaker config implements the headline behaviors but trips one or more of these.
// The correct reference (tokens=balance, last=last-refill ts; refill clamps
// elapsed at 0 and balance at capacity; available refills then returns; tryRemove
// refills then removes iff balance≥n) passes ALL of them. ----

// A non-monotonic (backwards) clock must NOT mint negative tokens / drain the
// bucket: elapsed time is clamped at 0, so a call with an earlier nowMs leaves the
// balance untouched, and a subsequent forward call still refills from the LATER of
// the two clocks. Budget impls that compute `(nowMs - last) * rate` without a
// max(0, …) clamp add a negative refill here and fail.
const TEST_BACKWARD_CLOCK = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("a backwards clock never removes tokens or refills negatively", () => {
  const rl = new RateLimiter(10, 2, 1000);
  expect(rl.tryRemove(10, 1000)).toBe(true); // drain at t=1000
  // Clock jumps BACKWARDS: elapsed must clamp at 0, balance stays 0 (not negative).
  expect(rl.available(0)).toBeCloseTo(0, 6);
  // A full bucket must not be drained by a backwards observation either.
  const full = new RateLimiter(5, 1, 5000);
  expect(full.available(0)).toBeCloseTo(5, 6);
  expect(full.tryRemove(5, 0)).toBe(true);
});
`;

// available() is a PURE OBSERVATION: it may refill, but it must not consume tokens.
// Calling it (repeatedly) must leave exactly as many tokens for a later tryRemove
// as if it had never been called. Budget impls that decrement on observe, or that
// advance internal state so a same-clock second call reads differently, fail.
const TEST_AVAILABLE_PURE = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("available() observes without consuming tokens", () => {
  const rl = new RateLimiter(4, 1, 0);
  // Observing many times at the same clock is idempotent and consumes nothing.
  expect(rl.available(0)).toBeCloseTo(4, 6);
  expect(rl.available(0)).toBeCloseTo(4, 6);
  expect(rl.available(0)).toBeCloseTo(4, 6);
  // All 4 tokens must still be removable — observation did not spend any.
  expect(rl.tryRemove(4, 0)).toBe(true);
  expect(rl.available(0)).toBeCloseTo(0, 6);
});
`;

// Boundary removals: removing 0 always succeeds and changes nothing; a removal
// larger than the whole capacity can never succeed (even on a brimming bucket) and
// must remove nothing. Budget impls that use `>` instead of `>=`, or that mutate
// before the availability check, fail one of these.
const TEST_ZERO_AND_OVER = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("removing zero is a no-op success; over-capacity removal always fails", () => {
  const rl = new RateLimiter(3, 1, 0);
  expect(rl.tryRemove(0, 0)).toBe(true); // zero removal succeeds...
  expect(rl.available(0)).toBeCloseTo(3, 6); // ...and changes nothing.
  // Asking for more than the bucket can ever hold fails and removes nothing.
  expect(rl.tryRemove(4, 0)).toBe(false);
  expect(rl.available(0)).toBeCloseTo(3, 6);
  // Exactly-capacity removal still works after the failed over-ask.
  expect(rl.tryRemove(3, 0)).toBe(true);
});
`;

// The fractional remainder must be PRESERVED across calls — never floored away.
// After draining, refilling 0.5 of a token (sub-token accrual) and then refilling
// another 0.5 must yield exactly 1 token. An impl that floors the balance to an
// integer on each refill silently drops the 0.5 each step and never accrues.
const TEST_FRACTIONAL_REMAINDER = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("sub-token fractional accrual is preserved, not floored, across calls", () => {
  const rl = new RateLimiter(10, 1, 0);
  expect(rl.tryRemove(10, 0)).toBe(true); // drain
  // 1 token/sec for 500ms -> 0.5 token; flooring would make this 0.
  expect(rl.available(500)).toBeCloseTo(0.5, 6);
  // Another 500ms -> the two halves accrue to exactly 1 (not 0).
  expect(rl.available(1000)).toBeCloseTo(1, 6);
  // And that whole token is removable.
  expect(rl.tryRemove(1, 1000)).toBe(true);
  expect(rl.available(1000)).toBeCloseTo(0, 6);
});
`;

// A long INTERLEAVED refill/remove sequence pins the running balance. This catches
// the classic bug of recomputing the balance from startMs on every call (which
// ignores tokens already spent) instead of tracking a moving last-refill timestamp
// and a running balance. The expected values below are computed against the
// reference semantics step by step.
const TEST_INTERLEAVED_SEQUENCE = `import { expect, test } from "bun:test";
import { RateLimiter } from "../src/ratelimit.ts";

test("running balance is tracked across an interleaved refill/remove sequence", () => {
  const rl = new RateLimiter(10, 4, 0); // 4 tokens/sec, starts full at 10
  // t=0: full=10. Remove 6 -> 4 left.
  expect(rl.tryRemove(6, 0)).toBe(true);
  // t=500ms: +2 tokens (4/sec * 0.5s) -> 6. Remove 5 -> 1 left.
  expect(rl.tryRemove(5, 500)).toBe(true);
  expect(rl.available(500)).toBeCloseTo(1, 6);
  // t=1000ms: +2 -> 3. Asking for 4 must FAIL (only 3) and remove nothing.
  expect(rl.tryRemove(4, 1000)).toBe(false);
  expect(rl.available(1000)).toBeCloseTo(3, 6);
  // t=2000ms: +4 -> 7 (NOT 10: a from-startMs recompute would wrongly read full).
  expect(rl.available(2000)).toBeCloseTo(7, 6);
  expect(rl.tryRemove(7, 2000)).toBe(true);
  expect(rl.available(2000)).toBeCloseTo(0, 6);
});
`;

// Seeded test files keyed by their on-disk path. The instruction-following check
// re-reads each and asserts it is BYTE-FOR-BYTE the seeded content (tamper guard).
const SEEDED_TESTS: { path: string; content: string }[] = [
  // Headline behaviors (a budget model usually clears these).
  { path: `${PROJECT}/test/starts-full.test.ts`, content: TEST_BUCKET_STARTS_FULL },
  { path: `${PROJECT}/test/remove-guard.test.ts`, content: TEST_REMOVE_GUARD },
  { path: `${PROJECT}/test/refill-rate.test.ts`, content: TEST_REFILL_RATE },
  { path: `${PROJECT}/test/fractional-refill.test.ts`, content: TEST_FRACTIONAL_REFILL },
  { path: `${PROJECT}/test/capacity-cap.test.ts`, content: TEST_CAPACITY_CAP },
  // Round-11 discriminator edges (a budget model routinely trips one or more).
  { path: `${PROJECT}/test/backward-clock.test.ts`, content: TEST_BACKWARD_CLOCK },
  { path: `${PROJECT}/test/available-pure.test.ts`, content: TEST_AVAILABLE_PURE },
  { path: `${PROJECT}/test/zero-and-over.test.ts`, content: TEST_ZERO_AND_OVER },
  { path: `${PROJECT}/test/fractional-remainder.test.ts`, content: TEST_FRACTIONAL_REMAINDER },
  { path: `${PROJECT}/test/interleaved-sequence.test.ts`, content: TEST_INTERLEAVED_SEQUENCE },
];

// ---- Correctness: TEN independent graded test groups (the five headline
// behaviors + five round-11 discriminator edges). The fraction that pass is the
// dimension sub-score (partial credit) — a config that nails the happy path but
// trips three edges scores ~0.7, not 1.0. Each group runs exactly one seeded test
// file in worker 0's sandbox. NOTE: several groups carry multiple `test()` blocks,
// so the ten FILES exercise more than ten assertions. ----
const TEST_GROUPS: TestGroup[] = [
  { name: "starts-full", cmd: "bun test test/starts-full.test.ts" },
  { name: "remove-guard", cmd: "bun test test/remove-guard.test.ts" },
  { name: "refill-rate", cmd: "bun test test/refill-rate.test.ts" },
  { name: "fractional-refill", cmd: "bun test test/fractional-refill.test.ts" },
  { name: "capacity-cap", cmd: "bun test test/capacity-cap.test.ts" },
  { name: "backward-clock", cmd: "bun test test/backward-clock.test.ts" },
  { name: "available-pure", cmd: "bun test test/available-pure.test.ts" },
  { name: "zero-and-over", cmd: "bun test test/zero-and-over.test.ts" },
  { name: "fractional-remainder", cmd: "bun test test/fractional-remainder.test.ts" },
  { name: "interleaved-sequence", cmd: "bun test test/interleaved-sequence.test.ts" },
];

const correctnessChecks: DeterministicCheck = testGroupsGreen(TEST_GROUPS, 0, PROJECT);

// ---- instruction-following: the seeded hidden test files must be byte-for-byte
// UNMODIFIED (graded fraction; pass only when all ten are pristine). A config
// that edits/weakens/deletes a test to make `bun test` exit 0 scores 0 here — and
// gains nothing on correctness, which re-runs each ORIGINAL seeded group. ----
const testsUnmodified: DeterministicCheck = {
  name: "tests-unmodified",
  fn: async (ctx): Promise<CheckResult> => {
    const total = SEEDED_TESTS.length;
    const tampered: string[] = [];
    for (const t of SEEDED_TESTS) {
      const onDisk = await ctx.readFile(t.path); // ctx.readFile aliases worker 0
      if (onDisk === null || onDisk !== t.content) {
        tampered.push(t.path.replace(`${PROJECT}/`, ""));
      }
    }
    const pristine = total - tampered.length;
    return {
      pass: tampered.length === 0,
      score: pristine / total,
      detail:
        tampered.length === 0
          ? `all ${total} seeded test files unmodified`
          : `${pristine}/${total} test files pristine (tampered: ${tampered.join(", ")})`,
    };
  },
};

// ---- citation-validity (deterministic): TIGHTENED past "any 3 in-range lines".
// The base `citationsResolve` factory grades the resolvable-fraction half (the
// citations must point at REAL in-range lines in the built file, ≥3 distinct, and a
// hallucinated `ratelimit.ts:999` scores 0). On top of that, this check applies a
// BEHAVIOR-ANCHOR multiplier: a grounded review must cite the lines that actually
// implement the limiter's three load-bearing behaviors — the elapsed→refill
// arithmetic, the capacity clamp, and the insufficient-tokens guard — not three
// convenient throwaway lines (the class header, a blank line, the constructor).
// The anchor lines are located DETERMINISTICALLY by scanning the built source on
// the sandbox (the worker only knows them by reading what it built — they are not
// promptable), so a review that cites real-but-irrelevant lines resolves on the
// base check yet earns a reduced anchor factor. The name stays
// `citations-resolve[w0]:ratelimit.ts` so the dimension reads as the citation
// check. ----

// Regex banks that locate each behavior anchor in an arbitrary correct token-bucket
// implementation. Each anchor offers SEVERAL alternative spellings so a faithful
// implementation lands on it regardless of variable naming or formatting; an anchor
// that no line matches in THIS particular source is simply dropped from the
// denominator (we never penalize a review for failing to cite a line the impl never
// wrote). A cited line "covers" an anchor when it is within ±CITE_WINDOW of an
// anchor line — reviewers commonly cite the statement, the line above (a comment),
// or the line below.
const CITE_WINDOW = 2;
const ANCHOR_PATTERNS: { label: string; patterns: RegExp[] }[] = [
  {
    // The elapsed→refill arithmetic: elapsed time (now - last), per-second rate,
    // and an accumulation into the running balance.
    label: "refill-arithmetic",
    patterns: [
      /refillPerSec/,
      /\/\s*1000/, // ms → seconds
      /(now|nowMs|ms|time|t)\s*-\s*(this\.)?(last|prev|previous|lastRefill|lastMs)/i,
      /elapsed/i,
    ],
  },
  {
    // The capacity clamp: the balance must never exceed `capacity`.
    label: "capacity-clamp",
    patterns: [
      /Math\.min\s*\([^)]*capacity/i,
      /Math\.min\s*\(\s*(this\.)?capacity/i,
      />\s*(this\.)?capacity/i, // `if (tokens > capacity) tokens = capacity`
      /(this\.)?capacity\s*[<>]=?\s*/i,
    ],
  },
  {
    // The insufficient-tokens guard: tryRemove removes iff balance ≥ n.
    label: "remove-guard",
    patterns: [
      />=?\s*n\b/, // `tokens >= n`
      /\bn\s*<=?\s*/, // `n <= tokens`
      /\bif\b[^\n]*\bn\b[^\n]*(return|tokens|balance|count)/i,
      /return\s+false/i,
    ],
  },
];

const baseCitations: DeterministicCheck = citationsResolve({
  worker: 0,
  reviewPath: REVIEW_FILE,
  sourcePath: SRC,
  minCitations: 3,
});

const reviewCitations: DeterministicCheck = {
  // Keep the factory's name so the dimension reads identically (and the structural
  // test's expected check name stays valid).
  name: baseCitations.name,
  fn: async (ctx): Promise<CheckResult> => {
    // 1) Base resolvable-fraction grade (real in-range citations, ≥3 distinct).
    const base = await baseCitations.fn(ctx);
    const baseScore = base.score ?? (base.pass ? 1 : 0);
    if (baseScore <= 0) return base; // no real citations → nothing to anchor-grade.

    // 2) Anchor multiplier: do the cited lines land on the behaviors that matter?
    const w = ctx.workers[0];
    if (!w) return base; // defensive — base already handled the missing-worker case.
    const review = await w.readFile(REVIEW_FILE);
    const source = await w.readFile(SRC);
    if (review === null || source === null) return base;

    const lines = source.split("\n");
    // Cited 1-based line numbers in `ratelimit.ts:<line>` form.
    const citeRe = /ratelimit\.ts:(\d+)(?::\d+)?/gi;
    const cited = new Set<number>();
    for (const m of review.matchAll(citeRe)) {
      const n = Number.parseInt(m[1] as string, 10);
      if (Number.isInteger(n) && n >= 1 && n <= lines.length) cited.add(n);
    }

    // Locate each anchor's line(s) in THIS source. An anchor counts as "present"
    // when ≥1 source line matches any of its alternative patterns.
    let anchorsFound = 0;
    let anchorsCited = 0;
    const missed: string[] = [];
    for (const anchor of ANCHOR_PATTERNS) {
      const anchorLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i] ?? "";
        if (anchor.patterns.some((p) => p.test(ln))) anchorLines.push(i + 1);
      }
      if (anchorLines.length === 0) continue; // impl didn't write this shape — skip.
      anchorsFound++;
      const covered = anchorLines.some((al) =>
        [...cited].some((c) => Math.abs(c - al) <= CITE_WINDOW),
      );
      if (covered) anchorsCited++;
      else missed.push(anchor.label);
    }

    // If we could not locate ANY anchor (an unusual impl), fall back to the base
    // grade unchanged — never punish a review for an anchor the source never wrote.
    if (anchorsFound === 0) return base;

    // Anchor factor in [0.4, 1]: a review that cites NONE of the located behavior
    // anchors keeps 0.4 of its base score (it still cited real lines); citing all
    // of them keeps the full base score. This is the discriminator — a budget review
    // that cites the header/blank/constructor resolves on the base check but covers
    // no anchor (factor 0.4); a grounded review covers them (factor → 1).
    const anchorFactor = 0.4 + 0.6 * (anchorsCited / anchorsFound);
    const score = baseScore * anchorFactor;
    return {
      // `pass` still requires the base must-pass (≥3 real, no dangling) AND all
      // located anchors cited — so a fully grounded review reads as pass.
      pass: base.pass === true && anchorsCited === anchorsFound,
      score,
      detail:
        anchorsCited === anchorsFound
          ? `${base.detail}; cited all ${anchorsFound} behavior anchors`
          : `${base.detail}; cited ${anchorsCited}/${anchorsFound} behavior anchors (missed: ${missed.join(", ")})`,
    };
  },
};

// ---- Gate: the implemented source module must still exist on worker 0 (required
// output surface — a worker that deleted the stub rather than implementing it
// fails the gate). The synthetic tasks-completed gate is prepended by the runner. ----
const srcExists: DeterministicCheck = {
  name: "src-exists",
  fn: async (ctx): Promise<CheckResult> => {
    const content = await ctx.readFile(SRC); // worker 0
    if (content === null) return { pass: false, detail: `${SRC} not found` };
    return { pass: true, detail: `${SRC} (${content.length} bytes)` };
  },
};

// ---- Gate: the review file must exist on worker 0 (required output surface for
// the communication dimension). ----
const reviewExists: DeterministicCheck = {
  name: "review-exists",
  fn: async (ctx): Promise<CheckResult> => {
    const content = await ctx.readFile(REVIEW_FILE); // worker 0
    if (content === null) return { pass: false, detail: `${REVIEW_FILE} not found` };
    return { pass: true, detail: `${REVIEW_FILE} (${content.length} bytes)` };
  },
};

export const planImplementReview: Scenario = {
  id: "plan-implement-review",
  name: "Plan, implement, review",
  description: [
    "A lead decomposes a three-stage chain — plan, implement, review-with-citations — over a small",
    "code task (a token-bucket rate limiter). The lead reads a written spec from swarm memory, writes",
    "a design plan, and publishes its design decisions for worker 0; worker 0 implements the seeded",
    "stub so a hidden ten-group test suite passes, then writes a code review of its own implementation",
    "that must cite real source line numbers. Graded on the fraction of test groups green (correctness,",
    "3x), the validity of the review's source-line citations (citation-validity, deterministic, 1x), the",
    "review's specificity grounded in the real code (communication judge, 1x), and the seeded tests",
    "staying unmodified (instruction-following, 1x).",
  ].join(" "),
  // Two workers (under the 3-worker cap) + a lead (outside the cap). Worker 0 owns
  // the graded implement + review (one sandbox so citations resolve); worker 1 is
  // a second hand the lead can coordinate. The lead orchestrates the chain.
  workers: [
    { name: "builder", template: "coder" },
    { name: "reviewer", template: "coder" },
  ],
  lead: { name: "Lead", template: "lead" },
  seed: {
    // seed.exec runs on worker 0 only — plant the stub module + the ten hidden
    // test files there. The lead retrieves the spec from memory (its sandbox is
    // isolated), so we ALSO publish the written spec into swarm memory.
    exec: [
      [
        `mkdir -p ${PROJECT}/src ${PROJECT}/test`,
        `cat > ${SRC} <<'STUB_EOF'`,
        STUB_SRC.trimEnd(),
        "STUB_EOF",
      ].join("\n"),
      ...SEEDED_TESTS.map((t) =>
        [`cat > ${t.path} <<'TEST_EOF'`, t.content.trimEnd(), "TEST_EOF"].join("\n"),
      ),
      `chmod -R a+rwX ${PROJECT}`,
    ],
    // The written spec lives in swarm memory so the LEAD (isolated sandbox) can
    // retrieve it to plan from. It states the BEHAVIORS, never the implementation
    // or any test — the hidden tests remain the only ground truth.
    memories: [
      [
        `Project spec [${SPEC_TAG}]: implement a token-bucket RateLimiter in TypeScript.`,
        "Public surface (fixed): `new RateLimiter(capacity, refillPerSec, startMs)`,",
        "`available(nowMs): number`, `tryRemove(n, nowMs): boolean`.",
        "Required behaviors:",
        "- The bucket holds up to `capacity` tokens and STARTS FULL.",
        "- Tokens refill at `refillPerSec` per second, accruing FRACTIONALLY over elapsed",
        "  time (e.g. 0.5s at 2 tokens/sec adds exactly 1 token), and NEVER exceed `capacity`.",
        "- `tryRemove(n, nowMs)` refills based on elapsed time since the last call, then removes",
        "  `n` tokens iff at least `n` are available (returns true); otherwise removes nothing and",
        "  returns false. `nowMs` is a caller-supplied monotonic clock in milliseconds.",
        "- `available(nowMs)` refills then returns the current (possibly fractional) token count.",
        "The implementation file is src/ratelimit.ts; a hidden test suite verifies these behaviors.",
      ].join("\n"),
    ],
  },
  tasks: [
    {
      title: "Plan the rate limiter (lead)",
      worker: "lead",
      description: [
        `You are the LEAD. A written project spec was published into swarm memory under the channel`,
        `tag \`${SPEC_TAG}\`. Search your memory for that tag and retrieve the FULL spec (do not invent`,
        "requirements — use exactly what was published).",
        "",
        "Produce a concise DESIGN PLAN for implementing it and decompose the work for the builder:",
        `  1. Write the plan to \`${PLAN_FILE}\` on your sandbox (create the directory). The plan should`,
        "     name the internal state the limiter needs (e.g. current token count + last-refill",
        "     timestamp), the refill formula (elapsed-seconds x refillPerSec, capped at capacity), and",
        "     the order of operations inside tryRemove/available (refill THEN act).",
        `  2. PUBLISH your design decisions for the builder: index a swarm memory whose content`,
        `     includes your plan AND the exact channel tag \`${PLAN_TAG}\` (the builder searches that`,
        "     tag), and include the plan in your completion report.",
        "",
        "Do NOT write any implementation code yourself — you are planning and delegating. Report",
        "completion via store-progress.",
      ].join("\n"),
    },
    {
      title: "Implement the rate limiter (builder)",
      worker: 0,
      dependsOn: [0],
      description: [
        `The lead published a design plan into swarm memory under the channel tag \`${PLAN_TAG}\`.`,
        "Search your memory for that tag and retrieve the plan.",
        "",
        `A bun project lives at \`${PROJECT}\`. Its source stub is \`src/ratelimit.ts\` (a token-bucket`,
        "`RateLimiter` class with unimplemented method bodies and a doc comment stating the required",
        "behaviors). There is a hidden test suite under `test/` that verifies the behavior.",
        "",
        "Implement the method bodies in `src/ratelimit.ts` per the spec/plan so the project's tests",
        "pass. You can run the suite to check your work:",
        "",
        `  cd ${PROJECT} && bun test`,
        "",
        "Constraints (these matter):",
        "  - Modify ONLY `src/ratelimit.ts`. Do NOT edit, delete, rename, add `.skip`/`.only` to, or",
        "    otherwise weaken ANY file under `test/`. The tests are the spec.",
        "  - Keep the public surface (constructor signature + method names) intact.",
        "  - Do NOT add new dependencies or scaffold a new project — implement the existing module.",
        "",
        "Partial progress counts — implement as many behaviors correctly as you can. When done, report",
        "the final pass/fail of the suite via store-progress.",
      ].join("\n"),
    },
    {
      title: "Review the implementation with citations (builder)",
      worker: 0,
      dependsOn: [1],
      description: [
        `Now write a focused CODE REVIEW of the implementation you produced in \`${SRC}\`.`,
        "",
        `Write the review to \`${REVIEW_FILE}\` (markdown). The review MUST:`,
        `  - Cite SPECIFIC locations in the source using the form \`${SRC_BASE}:<line>\` (for example`,
        `    \`${SRC_BASE}:42\`) — every claim about the code should point at the exact line(s) it`,
        "    refers to. Cite at least three distinct real lines.",
        "  - Assess correctness against the spec (does the refill math accrue fractionally and cap at",
        "    capacity? does tryRemove refill before acting and remove nothing on failure?).",
        "  - Call out at least one genuine strength and one genuine risk or edge case (e.g. clock",
        "    monotonicity assumptions, fractional-token accumulation, integer vs float handling),",
        "    each tied to a cited line.",
        "",
        "Be concrete and grounded in the actual code — do not pad with generic advice. Then report",
        "completion via store-progress.",
      ].join("\n"),
    },
  ],
  outcome: {
    // Gates (binary must-pass): the implemented source AND the review file must
    // exist on worker 0 (the required output surfaces). The synthetic
    // tasks-completed gate is prepended by the runner. Correctness,
    // citation-validity, communication, and instruction-following are GRADED (not
    // gated) so they discriminate.
    gates: [srcExists, reviewExists],
    // Dimension weights: correctness 3, citation-validity 1, communication 1,
    // instruction-following 1 (total 6). The communication concern keeps its old
    // combined weight of 2, now split across a deterministic citation-validity
    // dimension and a judge-only communication dimension — a dimension is fed by
    // checks XOR a judge, never both (round 11).
    dimensions: [
      {
        name: "correctness",
        weight: 3,
        // Fraction of the ten hidden test groups that pass (partial credit).
        checks: [correctnessChecks],
      },
      {
        name: "citation-validity",
        weight: 1,
        // Deterministic half of the communication concern (custom dimension name,
        // allowed by design): the review's `ratelimit.ts:<line>` citations must
        // (a) point at REAL in-range lines in the built file (≥3 distinct) AND
        // (b) land on the lines that actually implement the limiter's three
        // load-bearing behaviors (refill arithmetic, capacity clamp, remove guard),
        // located deterministically by scanning the built source — a review that
        // cites three convenient throwaway lines resolves on (a) but keeps only 0.4
        // of its score on (b). This is the anti-gaming guard a hallucinated line
        // number can't pass; it carries partial credit independent of the judge's
        // prose grading.
        checks: [reviewCitations],
      },
      {
        name: "communication",
        weight: 1,
        // JUDGE-ONLY (round 11 checks-XOR-judge contract): the agentic communication
        // judge grades whether the review is SPECIFIC and grounded in the real code.
        // It re-reads the cited lines on worker 0's sandbox (v8.0 §4 full-roster
        // tools) and uses the head+tail transcript so the final review text reaches
        // it. Citation *validity* is graded deterministically by the separate
        // citation-validity dimension above.
        judge: {
          rubric: [
            `Grade ONLY the written code review at ${REVIEW_FILE} (read it via read_file on worker 0).`,
            "Score 0-1 on whether the review is SPECIFIC and GROUNDED IN THE REAL CODE — not on whether",
            "the implementation is correct (a separate deterministic check grades correctness). A strong",
            `review: cites concrete \`${SRC_BASE}:<line>\` locations and the claims at those lines are`,
            `TRUE (use read_file to open ${SRC} on worker 0 and verify the cited lines actually contain`,
            "what the review says); assesses the refill/cap/guard behavior against the spec; names at",
            "least one real strength and one real risk tied to specific lines. A weak review: cites no",
            "lines or fabricated lines, makes vague/generic claims ('looks good', 'could be cleaner')",
            "with no grounding, or describes code that is not actually present. Penalize citations that",
            "do not match the real code at that line. Do not reward length. If the review file is",
            "missing or empty, score 0.",
          ].join(" "),
          agentic: true,
          maxSteps: 12,
        },
      },
      {
        name: "instruction-following",
        weight: 1,
        // The seeded hidden test files must stay byte-for-byte unmodified (anti-
        // gaming: a config can't pass correctness by editing or deleting tests).
        checks: [testsUnmodified],
      },
    ],
  },
  // The deepest scenario in the round: a lead-driven plan → implement → review
  // chain over a real code task, with a memory handoff at each lead↔worker hop and
  // a token-bucket implementation weaker configs iterate on. Raised to 20 minutes.
  timeoutMs: 20 * 60_000,
};
