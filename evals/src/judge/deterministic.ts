import type { CheckResult, DeterministicCheck, JudgeContext } from "../types.ts";
import type { JudgeLiveHandle } from "./live-registry.ts";
import { finishJudgeTrace, newJudgeTrace } from "./llm.ts";

export interface CheckRunResult extends CheckResult {
  name: string;
  /** Per-check elapsed wall clock. */
  durationMs: number;
}

/**
 * Run all deterministic checks; a thrown check counts as a failure, not a
 * crash. Each check is timed and pushed into the live trace as it completes.
 */
export async function runChecks(
  checks: DeterministicCheck[],
  ctx: JudgeContext,
  live?: JudgeLiveHandle,
): Promise<CheckRunResult[]> {
  const trace = newJudgeTrace("deterministic", null);
  live?.attach(trace);
  const results: CheckRunResult[] = [];
  for (const check of checks) {
    const t0 = Date.now();
    let res: CheckResult;
    try {
      res = await check.fn(ctx);
    } catch (err) {
      res = {
        pass: false,
        detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const durationMs = Date.now() - t0;
    results.push({ name: check.name, ...res, durationMs });
    trace.steps.push({
      index: trace.steps.length,
      kind: "check",
      text: res.detail ?? null,
      tool: check.name,
      args: null,
      output: null,
      pass: res.pass,
      startedAt: new Date(t0).toISOString(),
      durationMs,
      tokens: null,
      costUsd: null,
    });
  }
  finishJudgeTrace(trace); // costUsd/tokens stay null — no LLM involved
  return results;
}

/** Common check: every scenario task reached a terminal-success status. */
export function allTasksCompleted(): DeterministicCheck {
  return {
    name: "all-tasks-completed",
    fn: async (ctx) => {
      const bad = ctx.tasks.filter((t) => !["done", "completed"].includes(t.status));
      return bad.length === 0
        ? { pass: true }
        : {
            pass: false,
            detail: `tasks not done: ${bad.map((t) => `${t.title}=${t.status}`).join(", ")}`,
          };
    },
  };
}

/** Common check: a file exists in the sandbox and (optionally) matches a pattern. */
export function fileContains(path: string, pattern?: RegExp): DeterministicCheck {
  return {
    name: `file-contains:${path}`,
    fn: async (ctx) => {
      const content = await ctx.readFile(path);
      if (content === null) return { pass: false, detail: `${path} not found` };
      if (pattern && !pattern.test(content)) {
        return { pass: false, detail: `${path} does not match ${pattern}` };
      }
      return { pass: true, detail: `${path} (${content.length} bytes)` };
    },
  };
}

/** Like {@link fileContains}, but against ctx.workers[worker] (multi-worker v1, v6 §0.9). */
export function fileContainsOnWorker(
  worker: number,
  path: string,
  pattern: RegExp,
): DeterministicCheck {
  return {
    name: `file-contains[w${worker}]:${path}`,
    fn: async (ctx) => {
      const w = ctx.workers[worker];
      if (!w) return { pass: false, detail: `worker ${worker} not booted` };
      const content = await w.readFile(path);
      if (content === null) return { pass: false, detail: `${path} not found` };
      if (!pattern.test(content)) {
        return { pass: false, detail: `${path} does not match ${pattern}` };
      }
      return { pass: true, detail: `${path} (${content.length} bytes)` };
    },
  };
}

/** Passes when the file does NOT exist on that worker (isolation proof, v6 §0.9). */
export function fileAbsentOnWorker(worker: number, path: string): DeterministicCheck {
  return {
    name: `file-absent[w${worker}]:${path}`,
    fn: async (ctx) => {
      const w = ctx.workers[worker];
      if (!w) return { pass: false, detail: `worker ${worker} not booted` };
      const content = await w.readFile(path);
      return content === null
        ? { pass: true, detail: `${path} absent` }
        : { pass: false, detail: `${path} exists (${content.length} bytes)` };
    },
  };
}

/** One named test group: a shell command (typically `bun test <file>`) that exits 0 when green. */
export interface TestGroup {
  /** Short label for the group (surfaced in the check detail). */
  name: string;
  /** Command run inside the target worker's sandbox; exit 0 == green. */
  cmd: string;
}

/**
 * Graded code-correctness check (v8.0 §6): runs N independent test groups on a
 * worker and scores the FRACTION that pass — `score = green / total`. Unlike
 * {@link fileContains} (binary), this yields partial credit so a config that
 * fixes 3 of 5 graded bugs ranks above one that fixes 1. `pass` mirrors
 * all-green (score === 1); the dimension aggregation in the runner consumes the
 * `score`, while gate usage falls back to `pass`. A group whose command throws
 * counts as red (it does not abort the remaining groups).
 *
 * Reuses the `seed.exec` heredoc test-suite machinery from the old
 * `build-verify-fix` scenario, generalized to multiple gradeable groups for
 * `bug-ladder`.
 */
export function testGroupsGreen(
  groups: TestGroup[],
  worker = 0,
  cwd = "/workspace",
): DeterministicCheck {
  return {
    name: `test-groups-green[w${worker}]`,
    fn: async (ctx) => {
      const w = ctx.workers[worker];
      if (!w) return { pass: false, score: 0, detail: `worker ${worker} not booted` };
      const total = groups.length;
      if (total === 0) return { pass: true, score: 1, detail: "no test groups" };
      const outcomes: { name: string; green: boolean; note?: string }[] = [];
      for (const g of groups) {
        try {
          const res = await w.exec(`cd ${cwd} && ${g.cmd}`);
          outcomes.push({
            name: g.name,
            green: res.exitCode === 0,
            note: res.exitCode === 0 ? undefined : (res.stderr || res.stdout).slice(0, 200),
          });
        } catch (err) {
          outcomes.push({
            name: g.name,
            green: false,
            note: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const green = outcomes.filter((o) => o.green).length;
      const score = green / total;
      const failed = outcomes.filter((o) => !o.green).map((o) => o.name);
      return {
        pass: green === total,
        score,
        detail:
          green === total
            ? `${green}/${total} test groups green`
            : `${green}/${total} test groups green (red: ${failed.join(", ")})`,
      };
    },
  };
}

/** One ground-truth fact to grade: a regex the recall file must satisfy, with a label. */
export interface GradedFact {
  /** Short label for the fact (surfaced in the check detail). */
  label: string;
  /** Pattern the file content must match for this fact to count as recalled. */
  pattern: RegExp;
}

/**
 * Graded recall check (v8.0 §6): reads one file and scores the FRACTION of
 * ground-truth facts present — `score = matched / total`. Partial credit so a
 * config that recalls 2 of 3 seeded facts ranks above one that recalls 0. `pass`
 * mirrors all-matched (score === 1). A missing file scores 0.
 *
 * Reuses the `seed.memories` + `fileContains` per-fact pattern from the old
 * `memory-seeded-recall` scenario, generalized to a graded multi-fact answer
 * key for `memory-distractor`.
 */
export function factsRecalled(path: string, facts: GradedFact[], worker = 0): DeterministicCheck {
  return {
    name: `facts-recalled[w${worker}]:${path}`,
    fn: async (ctx) => {
      const w = ctx.workers[worker];
      if (!w) return { pass: false, score: 0, detail: `worker ${worker} not booted` };
      const total = facts.length;
      if (total === 0) return { pass: true, score: 1, detail: "no facts" };
      const content = await w.readFile(path);
      if (content === null) return { pass: false, score: 0, detail: `${path} not found` };
      const missing = facts.filter((f) => !f.pattern.test(content)).map((f) => f.label);
      const matched = total - missing.length;
      const score = matched / total;
      return {
        pass: matched === total,
        score,
        detail:
          matched === total
            ? `${matched}/${total} facts recalled`
            : `${matched}/${total} facts recalled (missing: ${missing.join(", ")})`,
      };
    },
  };
}

/** Canonical UUIDv4 (or any 8-4-4-4-12 hex) token — the per-attempt invented secret. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** One downstream hop to verify a propagated value reached: a worker index + its receipt file. */
export interface PropagationHop {
  /** Short label for the hop (surfaced in the check detail). */
  label: string;
  /** Worker index whose sandbox holds the receipt file. */
  worker: number;
  /** Absolute path of the receipt file written by that worker. */
  path: string;
}

/**
 * Graded cross-worker propagation check (v8.0 §6, cross-worker-invent). Worker A
 * invents a RANDOM value at runtime (no seed can pin it — it differs per attempt)
 * and writes it to its own origin file; downstream workers must OBTAIN that exact
 * value via communication (swarm memory / messaging) — they have no filesystem
 * access to A's sandbox — and write it to their own receipt file. The ground
 * truth is therefore read from A's origin file at grade time (NOT a fixed
 * pattern), and each hop is scored on whether it carries the SAME value.
 *
 * `score = hops carrying the exact origin value / total hops` — partial credit so
 * a chain that propagated to B but not C ranks above one that propagated to
 * neither. A hop that contains a DIFFERENT uuid-shaped token (a guess/invention)
 * scores 0 for that hop: guessing a 122-bit random uuid is astronomically
 * unlikely, so only genuine communication carries the value through.
 *
 * Reuses the `workers` + `dependsOn` + per-worker-file machinery from the old
 * `relay-handoff` scenario, generalized to a graded multi-hop chain.
 */
export function uuidPropagatedToWorkers(
  origin: { worker: number; path: string },
  hops: PropagationHop[],
): DeterministicCheck {
  return {
    name: `uuid-propagated:w${origin.worker}→[${hops.map((h) => `w${h.worker}`).join(",")}]`,
    fn: async (ctx) => {
      const total = hops.length;
      if (total === 0) return { pass: true, score: 1, detail: "no hops" };
      const originWorker = ctx.workers[origin.worker];
      if (!originWorker) {
        return { pass: false, score: 0, detail: `origin worker ${origin.worker} not booted` };
      }
      const originContent = await originWorker.readFile(origin.path);
      if (originContent === null) {
        return { pass: false, score: 0, detail: `origin file ${origin.path} not found` };
      }
      const originMatch = originContent.match(UUID_RE);
      if (!originMatch) {
        // Worker A never wrote a uuid-shaped value — nothing to propagate, so no
        // hop can carry it; the whole chain scores 0 (origin failure).
        return { pass: false, score: 0, detail: `origin file holds no uuid: ${origin.path}` };
      }
      const truth = originMatch[0].toLowerCase();
      const reached: string[] = [];
      const missed: string[] = [];
      for (const hop of hops) {
        const w = ctx.workers[hop.worker];
        if (!w) {
          missed.push(`${hop.label}(w${hop.worker} not booted)`);
          continue;
        }
        const content = await w.readFile(hop.path);
        // Exact-value match (not just uuid-shaped): a downstream worker that wrote
        // its OWN invented uuid carries a different value and does not count.
        if (content?.toLowerCase().includes(truth)) {
          reached.push(hop.label);
        } else {
          missed.push(hop.label);
        }
      }
      const score = reached.length / total;
      return {
        pass: reached.length === total,
        score,
        detail:
          reached.length === total
            ? `uuid ${truth.slice(0, 8)}… reached all ${total} hops`
            : `uuid ${truth.slice(0, 8)}… reached ${reached.length}/${total} hops (missed: ${missed.join(", ")})`,
      };
    },
  };
}

/** Normalize text for stage comparison: trim, drop blank lines, collapse trailing whitespace. */
function normalizeLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);
}

/**
 * One stage of a chained transform pipeline (v8.0 §6, relay-pipeline). Each stage
 * is owned by one worker, reads its predecessor's output (handed off via swarm
 * memory), applies a pure transform, and writes the result to its own receipt
 * file. The expected output is RECOMPUTED from the per-attempt seeded source at
 * grade time (`transform` is applied to the previous stage's expected output),
 * so the ground truth is never a constant in the scenario file or the prompt.
 */
export interface PipelineStage {
  /** Short label for the stage (surfaced in the check detail). */
  label: string;
  /** Worker index that owns this stage (reads predecessor, writes its receipt). */
  worker: number;
  /** Absolute path of the receipt file this stage's worker writes. */
  path: string;
  /**
   * Pure transform from the PREVIOUS stage's expected line array to this stage's
   * expected line array. For stage 0, `prev` is the seeded source lines.
   */
  transform: (prev: string[]) => string[];
}

/**
 * Graded chained-pipeline correctness check (v8.0 §6, relay-pipeline). A random
 * per-attempt source payload is seeded on the origin worker's sandbox; each stage
 * applies a deterministic transform whose CORRECT output is recomputed here (by
 * folding the stage transforms over the seeded source) and compared, line-for-
 * line, against that stage's receipt file. The receipts live on separate worker
 * sandboxes, so each downstream worker can only obtain its input via the memory
 * handoff — there is no shared disk.
 *
 * `score = stages whose receipt matches the recomputed expected output / total`
 * — partial credit, and because the stages are dependency-chained a corruption at
 * stage k naturally tanks stages k+1… (a config that nails stage 1 but botches
 * stage 2 still ranks above one that botched stage 1). Each stage's fidelity is
 * scored INDEPENDENTLY against the recomputed truth (not against the worker's own
 * upstream receipt), so a downstream worker that faithfully transforms a WRONG
 * input still scores 0 on its own stage — the expected output is anchored to the
 * seed, not to whatever the previous worker actually produced.
 *
 * The source payload is read from the origin worker at grade time (it is random
 * per attempt and appears in NO prompt), so the expected outputs cannot be
 * pre-derived from the task text. Reuses the cross-worker `workers` + `dependsOn`
 * + per-worker-file machinery from the old `relay-handoff` scenario, generalized
 * to a graded multi-stage transform chain.
 */
export function pipelineStagesCorrect(
  source: { worker: number; path: string },
  stages: PipelineStage[],
): DeterministicCheck {
  return {
    name: `pipeline-stages:w${source.worker}→[${stages.map((s) => `w${s.worker}`).join(",")}]`,
    fn: async (ctx) => {
      const total = stages.length;
      if (total === 0) return { pass: true, score: 1, detail: "no stages" };
      const originWorker = ctx.workers[source.worker];
      if (!originWorker) {
        return { pass: false, score: 0, detail: `source worker ${source.worker} not booted` };
      }
      const sourceContent = await originWorker.readFile(source.path);
      if (sourceContent === null) {
        return { pass: false, score: 0, detail: `source file ${source.path} not found` };
      }
      // Fold the stage transforms over the seeded source to recompute each
      // stage's EXPECTED output. Each stage is anchored to the seed, not to the
      // previous worker's actual (possibly wrong) receipt.
      let expected = normalizeLines(sourceContent);
      const correct: string[] = [];
      const wrong: string[] = [];
      for (const stage of stages) {
        expected = stage.transform(expected);
        const w = ctx.workers[stage.worker];
        if (!w) {
          wrong.push(`${stage.label}(w${stage.worker} not booted)`);
          continue;
        }
        const actual = await w.readFile(stage.path);
        if (actual === null) {
          wrong.push(`${stage.label}(missing)`);
          continue;
        }
        const actualLines = normalizeLines(actual);
        const ok =
          actualLines.length === expected.length && actualLines.every((l, i) => l === expected[i]);
        if (ok) correct.push(stage.label);
        else wrong.push(stage.label);
      }
      const score = correct.length / total;
      return {
        pass: correct.length === total,
        score,
        detail:
          correct.length === total
            ? `all ${total} pipeline stages correct`
            : `${correct.length}/${total} pipeline stages correct (wrong: ${wrong.join(", ")})`,
      };
    },
  };
}

/**
 * Graded review-citation check (v8.0 §6, plan-implement-review). A reviewer writes
 * a review file that must cite REAL locations in an implemented source file in the
 * form `<basename>:<line>` (e.g. `solver.ts:42`). This check reads the review,
 * extracts every `<basename>:<line>` citation pointing at the implemented file,
 * and verifies each cited line NUMBER actually exists (1 ≤ line ≤ file line count)
 * in the on-disk source on the worker's sandbox.
 *
 * `score = resolvable citations / (resolvable + dangling)` over the citations that
 * reference the implemented file's basename — partial credit so a review with some
 * real and some hallucinated line refs ranks between an all-real and an all-fake
 * one. To stop a config from "winning" with a single trivial citation, a minimum
 * of {@link minCitations} resolvable citations is required to reach a full 1.0:
 * the raw fraction is multiplied by `min(1, resolvable / minCitations)`. A review
 * file that is missing, or that cites the file but resolves NONE of its lines
 * (every line out of range — i.e. fabricated), scores 0.
 *
 * Anti-gaming: a worker cannot satisfy this by pasting the prompt (which contains
 * no line numbers) or by inventing plausible-looking `file:line` tokens — the line
 * must land inside the REAL implemented file on the sandbox, whose length/content
 * the worker only knows by actually reading what it built. The implemented file is
 * produced by the worker at runtime, so its exact line count is not promptable.
 */
export function citationsResolve(opts: {
  /** Worker index whose sandbox holds BOTH the review file and the implemented source. */
  worker: number;
  /** Absolute path of the review file to read citations from. */
  reviewPath: string;
  /** Absolute path of the implemented source file the citations must point at. */
  sourcePath: string;
  /** Minimum resolvable citations to reach a full score (scaled below it). Default 3. */
  minCitations?: number;
}): DeterministicCheck {
  const minCitations = opts.minCitations ?? 3;
  const base = opts.sourcePath.split("/").pop() ?? opts.sourcePath;
  // Escape the basename for use inside a RegExp (the dot in "solver.ts").
  const baseRe = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Cite form `<basename>:<line>` (optionally `:<col>`), e.g. `solver.ts:42` or
  // `solver.ts:42:7`. We only consume the LINE number.
  const citeRe = new RegExp(`${baseRe}:(\\d+)(?::\\d+)?`, "g");
  return {
    name: `citations-resolve[w${opts.worker}]:${base}`,
    fn: async (ctx) => {
      const w = ctx.workers[opts.worker];
      if (!w) return { pass: false, score: 0, detail: `worker ${opts.worker} not booted` };
      const review = await w.readFile(opts.reviewPath);
      if (review === null) {
        return { pass: false, score: 0, detail: `review file ${opts.reviewPath} not found` };
      }
      const source = await w.readFile(opts.sourcePath);
      if (source === null) {
        return { pass: false, score: 0, detail: `source file ${opts.sourcePath} not found` };
      }
      const lineCount = source.split("\n").length;
      const cited = new Set<number>();
      for (const m of review.matchAll(citeRe)) {
        const n = Number.parseInt(m[1] as string, 10);
        if (Number.isInteger(n)) cited.add(n);
      }
      const total = cited.size;
      if (total === 0) {
        return {
          pass: false,
          score: 0,
          detail: `review cites no \`${base}:<line>\` locations`,
        };
      }
      let resolvable = 0;
      const dangling: number[] = [];
      for (const n of cited) {
        if (n >= 1 && n <= lineCount) resolvable++;
        else dangling.push(n);
      }
      const fraction = resolvable / total;
      // Scale by coverage so a single real citation can't score 1.0.
      const coverage = Math.min(1, resolvable / minCitations);
      const score = fraction * coverage;
      return {
        pass: resolvable >= minCitations && dangling.length === 0,
        score,
        detail:
          dangling.length === 0
            ? `${resolvable}/${total} citations resolve in ${base} (${lineCount} lines)`
            : `${resolvable}/${total} citations resolve (dangling lines: ${dangling.join(", ")}; ${base} has ${lineCount} lines)`,
      };
    },
  };
}
