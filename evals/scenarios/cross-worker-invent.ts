import { fileAbsentOnWorker } from "../src/judge/deterministic.ts";
import type { CheckResult, DeterministicCheck, JudgeContext, Scenario } from "../src/types.ts";

/**
 * cross-worker-invent (v8.0 round-11, Multi-worker, 3 workers)
 * -----------------------------------------------------------
 * Calibrated spread: TODO(calibration) — fill frontierAvg / budgetAvg / gap from
 * the round-11 sweep (anchors: claude-opus-4.8, codex-5.5 vs pi-deepseek-flash,
 * claude-haiku). Ship gate: frontierAvg − budgetAvg ≥ 0.2. Target ~0.3 → 0.85.
 *
 * Round-11 hardening (post-saturation): single-hop propagation saturated — budget
 * models tied opus at 1.00 because "search memory, copy a string" is trivial. The
 * relay is now a per-hop TRANSFORM CHAIN: worker A (worker 0) still INVENTS a fresh
 * random UUID at runtime (it appears in NO prompt and CANNOT be seeded), but each
 * downstream consumer must not merely echo it — it must DERIVE two precise,
 * deterministic values FROM the exact UUID (dash-strip + uppercase, hex-nibble
 * arithmetic, group-reversal, an XOR fold) and write all of them to its receipt
 * under labeled keys. Every derivation is recomputed from A's live origin UUID at
 * grade time and graded INDEPENDENTLY, so a config that copies the raw UUID but
 * fumbles a transform (off-by-one, leaves the dashes in, sums decimal-only, miscounts
 * 32 nibbles, reverses chars instead of groups) loses partial-credit weight that a
 * frontier model — which follows the spec exactly — keeps. The raw-UUID sub-checks
 * preserve the original communication signal (only genuine retrieval carries A's
 * exact value through), and the per-derivation sub-checks add the discrimination.
 *
 * Workers B (worker 1) and C (worker 2) have NO filesystem access to A's sandbox,
 * so the only path to A's UUID is communication (swarm memory / messaging), not
 * guessing — the derivations are computed locally from that retrieved value.
 *
 * Reuses the cross-worker `workers: 3` + `seed.exec` (writable scratch dirs) +
 * `dependsOn` + per-worker `fileAbsentOnWorker` machinery from the old
 * `relay-handoff` scenario, generalized to a graded multi-derivation propagation
 * chain (a single `uuid-propagated:` check that grades the fraction of per-hop
 * sub-checks — raw value + two derivations per hop — that match the recomputed
 * truth) plus a custom agentic `provenance` judge that cross-checks ALL three
 * workers' sandboxes (depends on Phase 4 full-roster judge tools + roster manifest).
 *
 * Requires an embedding key in evals/.env (EMBEDDING_API_KEY or OPENAI_API_KEY)
 * for the swarm memory store/search the handoff relies on — same as the old
 * relay-handoff scenario.
 *
 * Grading:
 *   - `correctness` (weight 3): a SINGLE graded `uuid-propagated:` check that scores
 *       the FRACTION of per-hop sub-checks that match the recomputed truth. Each of
 *       B and C contributes THREE sub-checks: (1) its receipt carries A's EXACT
 *       invented UUID (the original communication signal), (2) the first derived
 *       value is correct, (3) the second derived value is correct. Ground truth (the
 *       UUID and every derivation) is recomputed from A's origin file at grade time
 *       (the UUID is per-attempt random; no fixed answer exists). Partial credit so a
 *       chain that propagated the value but botched a derivation ranks above one that
 *       never retrieved the value at all.
 *   - `provenance` (weight 1, custom, agentic — depends on Phase 4): a judge reads
 *       ALL THREE workers' sandboxes (`worker: 0|1|2`) and the transcript to confirm
 *       B and C obtained the UUID by COMMUNICATION (a memory lookup / message from A),
 *       not by inventing their own value or copying a constant.
 *
 * Anti-gaming (checklist applied to THIS scenario):
 *   - The UUID is GENERATED AT RUNTIME by worker A (122 random bits) — it is NOT in
 *     any prompt, fixture, or seed, so neither it nor any value DERIVED from it is
 *     derivable from the task text. The grader recomputes every derivation from A's
 *     LIVE origin UUID, never from a hard-coded answer. The prompts state the
 *     transform SPEC (what to compute), never an expected output token.
 *   - GUESSING is astronomically unlikely (2^122 space). A downstream worker that
 *     invents its OWN uuid carries a DIFFERENT value → every sub-check that depends
 *     on the exact UUID (raw + both derivations) scores 0. Only genuine communication
 *     carries A's exact value through, and only precise spec-following lands the
 *     derivations.
 *   - The receipt files live on B's and C's sandboxes, which are filesystem-isolated
 *     from A's — `fileAbsentOnWorker` proves the chain wasn't a same-sandbox shortcut
 *     (A's origin file must NOT appear on B/C). Echoing the prompt or sharing a disk
 *     can't satisfy it.
 *   - The agentic provenance judge cross-checks every worker's sandbox so a value
 *     that landed by coincidence (or a hop that invented a matching-LOOKING token) is
 *     not rewarded — it grades whether the value was RETRIEVED via comms.
 *   - The grading rubric / per-hop sub-check thresholds / derivation formulas-as-
 *     ground-truth are NOT shown to the workers (only the transform spec is).
 */

const RELAY_DIR = "/workspace/relay";
// Worker A's origin file: holds the uuid A invented (the per-attempt ground
// truth every sub-check is recomputed from at grade time). Lives only on A's
// sandbox.
const ORIGIN_FILE = `${RELAY_DIR}/origin-uuid.txt`;
// Downstream receipt files, one per consumer worker. Each must carry the EXACT
// uuid A invented PLUS the two derived values this hop is told to compute, under
// labeled keys (see the task prompts). Obtained via communication (memory).
const HOP_B_FILE = `${RELAY_DIR}/hop-b.txt`;
const HOP_C_FILE = `${RELAY_DIR}/hop-c.txt`;

// A stable, distinctive memory tag the workers are told to use so B and C can
// find A's published uuid by searching memory. The tag is shared (it's part of
// the protocol the task describes); the SECRET is the uuid itself, which is
// invented at runtime and never appears in any prompt.
const MEMORY_TAG = "relay-invent-channel-9d2";

// Canonical UUIDv4 (or any 8-4-4-4-12 hex) token — the per-attempt invented secret.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---- Pure derivations of the origin UUID (v8.0 §6). These MUST mirror the
// natural-language transform spec in the consumer task prompts EXACTLY — the
// grader recomputes each from A's live origin UUID, so any divergence between the
// prompt wording and these functions would be a grading bug. Each takes the
// canonical lowercase UUID string and returns the lowercase-normalized expected
// receipt token (the per-hop sub-check lowercases the worker's value before
// comparing, so casing-only differences are tolerated — except where the spec
// explicitly asks for uppercasing, which is then re-lowercased identically on both
// sides, i.e. the dash-strip is the load-bearing transform there). ----

/** The 32 hex nibbles of the UUID (dashes removed), each as an integer 0..15. */
function uuidNibbles(uuid: string): number[] {
  return uuid
    .replace(/-/g, "")
    .split("")
    .map((c) => Number.parseInt(c, 16))
    .filter((n) => Number.isInteger(n));
}

/**
 * Derivation 1 (hop B): the UUID with all dashes removed, UPPERCASED — a 32-char
 * hex string. Both operations must happen (strip AND case). Compared
 * case-insensitively, so the load-bearing part a budget model fumbles is leaving
 * the dashes in (or only partially stripping them).
 */
function deriveCompact(uuid: string): string {
  return uuid.replace(/-/g, "").toUpperCase();
}

/**
 * Derivation 2 (hop B): the DECIMAL SUM of all 32 hex digits of the UUID, each
 * read as its hex value 0..15 (so `a`=10 … `f`=15), dashes excluded. A precise
 * 32-term arithmetic fold — a budget model that sums only the decimal digits, that
 * includes the dashes, or that miscounts the 32 nibbles lands a different total.
 */
function deriveNibbleSum(uuid: string): string {
  return String(uuidNibbles(uuid).reduce((s, n) => s + n, 0));
}

/**
 * Derivation 3 (hop C): the five hyphen-separated GROUPS of the UUID reordered
 * last-to-first and rejoined with single hyphens (group reversal — NOT character
 * reversal). For `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` this is
 * `eeeeeeeeeeee-dddd-cccc-bbbb-aaaaaaaa`. A budget model that reverses the whole
 * string char-by-char, or keeps group order, lands a different value.
 */
function deriveGroupsReversed(uuid: string): string {
  return uuid.split("-").reverse().join("-").toLowerCase();
}

/**
 * Derivation 4 (hop C): the XOR-FOLD of all 32 hex nibbles of the UUID
 * (nibble[0] ^ nibble[1] ^ … ^ nibble[31]), emitted as a single lowercase hex
 * digit. A 32-term running-XOR — astronomically hard to fake and easy to get
 * subtly wrong (XOR the bytes instead of nibbles, fold the wrong count, output
 * decimal). Exactly one correct answer per UUID.
 */
function deriveXorNibble(uuid: string): string {
  const x = uuidNibbles(uuid).reduce((acc, n) => acc ^ n, 0) & 0xf;
  return x.toString(16).toLowerCase();
}

/**
 * One graded sub-check of a hop's receipt: a label + the expected (recomputed)
 * token + a matcher. `kind` controls how the receipt content is searched:
 *   - "substring": the lowercased receipt must CONTAIN the lowercased expected
 *     token anywhere (used for the raw UUID and the compact/group-reversed forms,
 *     which are distinctive enough that a bare `includes` is unambiguous).
 *   - "labeled-line": a line of the form `<KEY>:<value>` (case-insensitive key,
 *     optional surrounding whitespace) whose value EXACTLY equals the expected
 *     token (lowercased) — used for the numeric/short derivations (sum, xor) where
 *     a bare substring could spuriously match an unrelated digit elsewhere.
 */
interface HopSubCheck {
  label: string;
  /** Recompute the expected token from the canonical lowercase origin UUID. */
  expected: (uuid: string) => string;
  kind: "substring" | "labeled-line";
  /** Labeled-line key (required when kind === "labeled-line"). */
  key?: string;
}

/** One downstream hop: a worker index + its receipt path + its graded sub-checks. */
interface PropagationHop {
  label: string;
  worker: number;
  path: string;
  subChecks: HopSubCheck[];
}

/** Does the receipt satisfy this sub-check against the recomputed expected token? */
function subCheckMatches(content: string, expected: string, sub: HopSubCheck): boolean {
  const hay = content.toLowerCase();
  const needle = expected.toLowerCase();
  if (sub.kind === "substring") return hay.includes(needle);
  // labeled-line: find a `<key>: <value>` line and exact-match the value.
  const key = (sub.key ?? sub.label).toLowerCase();
  for (const raw of content.split("\n")) {
    const m = raw.match(/^\s*([a-z0-9_-]+)\s*[:=]\s*(.+?)\s*$/i);
    if (!m) continue;
    if ((m[1] as string).toLowerCase() !== key) continue;
    if ((m[2] as string).trim().toLowerCase() === needle) return true;
  }
  return false;
}

/**
 * Graded cross-worker propagation+derivation check (v8.0 §6, cross-worker-invent).
 * Worker A invents a RANDOM uuid at runtime (no seed can pin it) and writes it to
 * its own origin file. Each downstream hop must OBTAIN that exact value via
 * communication (no filesystem access to A) AND compute the per-hop derivations,
 * writing them to its receipt. The ground truth — the uuid AND every derivation —
 * is recomputed from A's origin file at grade time (NOT a fixed pattern).
 *
 * `score = matched sub-checks / total sub-checks` across all hops — every sub-check
 * carries equal weight, so a hop that propagated the raw value but botched both
 * derivations scores 1/3 of its sub-checks, ranking above a hop that retrieved
 * nothing (0/3) and below a hop that nailed everything (3/3). A hop whose receipt
 * holds a DIFFERENT uuid-shaped token (a guess/invention) fails every sub-check
 * that depends on the exact value.
 *
 * Reuses the `workers` + `dependsOn` + per-worker-file machinery from the old
 * `relay-handoff` scenario, generalized to a graded multi-derivation chain.
 */
function uuidPropagatedAndDerived(
  origin: { worker: number; path: string },
  hops: PropagationHop[],
): DeterministicCheck {
  return {
    name: `uuid-propagated:w${origin.worker}→[${hops.map((h) => `w${h.worker}`).join(",")}]`,
    fn: async (ctx: JudgeContext): Promise<CheckResult> => {
      const totalSubChecks = hops.reduce((s, h) => s + h.subChecks.length, 0);
      if (totalSubChecks === 0) return { pass: true, score: 1, detail: "no sub-checks" };
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
        // Worker A never wrote a uuid-shaped value — nothing to propagate or
        // derive, so no sub-check can match; the whole chain scores 0.
        return { pass: false, score: 0, detail: `origin file holds no uuid: ${origin.path}` };
      }
      const truth = originMatch[0].toLowerCase();
      let matched = 0;
      const missed: string[] = [];
      for (const hop of hops) {
        const w = ctx.workers[hop.worker];
        const content = w ? await w.readFile(hop.path) : null;
        for (const sub of hop.subChecks) {
          const expected = sub.expected(truth);
          if (content !== null && subCheckMatches(content, expected, sub)) {
            matched++;
          } else {
            missed.push(`${hop.label}/${sub.label}`);
          }
        }
      }
      const score = matched / totalSubChecks;
      return {
        pass: matched === totalSubChecks,
        score,
        detail:
          matched === totalSubChecks
            ? `uuid ${truth.slice(0, 8)}… propagated + derived across all ${totalSubChecks} sub-checks`
            : `uuid ${truth.slice(0, 8)}… matched ${matched}/${totalSubChecks} sub-checks (missed: ${missed.join(", ")})`,
      };
    },
  };
}

// Per-hop sub-checks. Each hop re-states the raw-UUID propagation signal (the
// original communication test) PLUS two precise derivations that discriminate
// careful spec-following. The expected values are recomputed from A's live origin
// UUID at grade time — none appear in any prompt.
const HOPS: PropagationHop[] = [
  {
    label: "hop-b",
    worker: 1,
    path: HOP_B_FILE,
    subChecks: [
      // 1. raw propagation (communication signal) — substring of the exact uuid.
      { label: "uuid", expected: (u) => u, kind: "substring" },
      // 2. dash-stripped + uppercased 32-char form (distinctive → substring ok).
      { label: "compact", expected: deriveCompact, kind: "substring" },
      // 3. decimal hex-nibble sum (short/numeric → labeled-line exact match).
      { label: "nibblesum", expected: deriveNibbleSum, kind: "labeled-line", key: "NIBBLESUM" },
    ],
  },
  {
    label: "hop-c",
    worker: 2,
    path: HOP_C_FILE,
    subChecks: [
      // 1. raw propagation (communication signal).
      { label: "uuid", expected: (u) => u, kind: "substring" },
      // 2. group-reversed uuid (distinctive 8-4-4-4-12-shaped → substring ok).
      { label: "groups", expected: deriveGroupsReversed, kind: "substring" },
      // 3. xor-fold of the 32 nibbles → single hex digit (short → labeled-line).
      { label: "xor", expected: deriveXorNibble, kind: "labeled-line", key: "XORNIBBLE" },
    ],
  },
];

// ---- Gate: the relay scratch dirs must exist on every worker (required output
// surface). The synthetic tasks-completed gate is prepended by the runner. We
// additionally gate that A actually produced an origin uuid file — without it
// there is no ground truth to propagate and the attempt has no defensible
// output. ----
const originExists: DeterministicCheck = {
  name: "origin-uuid-exists",
  fn: async (ctx): Promise<CheckResult> => {
    const w = ctx.workers[0];
    if (!w) return { pass: false, detail: "worker 0 not booted" };
    const content = await w.readFile(ORIGIN_FILE);
    if (content === null) return { pass: false, detail: `${ORIGIN_FILE} not found` };
    if (!UUID_RE.test(content)) {
      return { pass: false, detail: `${ORIGIN_FILE} holds no uuid` };
    }
    return { pass: true, detail: `${ORIGIN_FILE} (${content.length} bytes)` };
  },
};

export const crossWorkerInvent: Scenario = {
  id: "cross-worker-invent",
  name: "Cross-worker invent",
  description: [
    "Three workers in a communication chain. Worker A invents a fresh random UUID at runtime (it",
    "appears in no prompt and cannot be seeded), writes it to its own origin file, and publishes it",
    "into swarm memory under a shared channel tag. Workers B and C — which have no access to A's",
    "sandbox — must retrieve that exact UUID from memory (communication, not guessing) AND derive two",
    "precise, deterministic values from it, writing the UUID and both derivations to their own receipt",
    "files. Graded on per-hop propagation+derivation correctness (3×, each derivation recomputed",
    "independently from the origin UUID) and an agentic provenance judge (1×) that cross-checks all",
    "three sandboxes to confirm the value was communicated, not invented.",
  ].join(" "),
  workers: 3,
  seed: {
    // seed.exec runs on worker 0 (A) only. Create A's relay dir so it can write
    // its origin file; B and C create their own dirs from their task prompt
    // (their sandboxes are separate, so this seed never touches them).
    exec: [`mkdir -p ${RELAY_DIR} && chmod -R a+rwX ${RELAY_DIR}`],
  },
  tasks: [
    {
      title: "Invent and publish a relay UUID",
      worker: 0,
      description: [
        "You are the ORIGIN of a relay. Invent a brand-new, random UUID (version 4 — the standard",
        "8-4-4-4-12 hex form, e.g. `3f2a9c10-7b4e-4d21-9a6c-1e2f3a4b5c6d`). Generate it freshly; do",
        "NOT reuse any example shown here.",
        "",
        `1. Write EXACTLY that UUID (and nothing else on the line) to \`${ORIGIN_FILE}\`.`,
        "2. Publish it so other agents can find it: index a swarm memory whose content includes the",
        `   UUID and the exact channel tag \`${MEMORY_TAG}\` (so downstream workers can search for it),`,
        "   and also include the UUID in your completion report.",
        "",
        "Then report completion via store-progress. The other workers will retrieve your UUID from",
        "memory — they cannot see your files, so memory is the only handoff.",
      ].join("\n"),
    },
    {
      title: "Relay and derive (hop B)",
      worker: 1,
      dependsOn: [0],
      description: [
        `Another agent published a relay UUID into swarm memory under the channel tag \`${MEMORY_TAG}\`.`,
        "Search your memory for that channel and retrieve the EXACT UUID it recorded (do NOT guess,",
        "do NOT invent your own UUID — the value is a specific one another agent chose). Call that the",
        "ORIGIN UUID.",
        "",
        `Create the directory \`${RELAY_DIR}\` and write a receipt to \`${HOP_B_FILE}\` containing,`,
        "on separate lines, the following labeled entries computed from the ORIGIN UUID:",
        "",
        "  UUID: <the exact origin UUID, unchanged>",
        "  COMPACT: <the origin UUID with ALL hyphens removed and the whole thing UPPERCASED — a",
        "    32-character hex string>",
        "  NIBBLESUM: <the DECIMAL SUM of all 32 hexadecimal digits of the origin UUID, where each hex",
        "    digit is read as its value 0..15 (a=10, b=11, c=12, d=13, e=14, f=15); ignore the hyphens;",
        "    output the sum as a plain decimal integer>",
        "",
        "Use exactly those uppercase labels followed by a colon. Then report completion via",
        "store-progress.",
      ].join("\n"),
    },
    {
      title: "Relay and derive (hop C)",
      worker: 2,
      dependsOn: [0],
      description: [
        `Another agent published a relay UUID into swarm memory under the channel tag \`${MEMORY_TAG}\`.`,
        "Search your memory for that channel and retrieve the EXACT UUID it recorded (do NOT guess,",
        "do NOT invent your own UUID — the value is a specific one another agent chose). Call that the",
        "ORIGIN UUID.",
        "",
        `Create the directory \`${RELAY_DIR}\` and write a receipt to \`${HOP_C_FILE}\` containing,`,
        "on separate lines, the following labeled entries computed from the ORIGIN UUID:",
        "",
        "  UUID: <the exact origin UUID, unchanged>",
        "  GROUPS: <the five hyphen-separated GROUPS of the origin UUID re-ordered LAST group first,",
        "    rejoined with single hyphens — reverse the ORDER OF THE GROUPS, not the characters.",
        "    Schematically, if the groups are G1-G2-G3-G4-G5 then the result is G5-G4-G3-G2-G1 (each",
        "    group's own characters stay in place; only the group order flips)>",
        "  XORNIBBLE: <a single lowercase hex digit equal to the bitwise XOR of all 32 hexadecimal",
        "    digits of the origin UUID (each digit taken as its value 0..15; ignore the hyphens; XOR",
        "    them all together; output the result as one lowercase hex character 0-9 or a-f)>",
        "",
        "Use exactly those uppercase labels followed by a colon. Then report completion via",
        "store-progress.",
      ].join("\n"),
    },
  ],
  outcome: {
    // Gates (binary must-pass): A must have produced an origin uuid (ground
    // truth), and A's origin file must NOT have leaked onto B/C (sandbox
    // isolation proof — the handoff was through memory, not a shared disk).
    // Per-hop propagation+derivation is GRADED (not gated) so partial credit
    // discriminates a chain that nailed every derivation from one that only
    // copied the raw value (or retrieved nothing).
    gates: [originExists, fileAbsentOnWorker(1, ORIGIN_FILE), fileAbsentOnWorker(2, ORIGIN_FILE)],
    dimensions: [
      {
        name: "correctness",
        weight: 3,
        // uuidPropagatedAndDerived → score = matched sub-checks / total sub-checks
        // across both hops. Ground truth (the uuid AND every derivation) is
        // recomputed from A's origin file at grade time (the value is per-attempt
        // random); a hop that wrote a different uuid or botched a derivation loses
        // that sub-check's weight.
        checks: [uuidPropagatedAndDerived({ worker: 0, path: ORIGIN_FILE }, HOPS)],
      },
      {
        name: "provenance",
        weight: 1,
        // Custom dimension (allowed by design). Agentic so the judge can read ALL
        // THREE workers' sandboxes (worker: 0|1|2) and the transcript to confirm B
        // and C obtained the uuid by communication, not invention (Phase 4 full-
        // roster tools + roster manifest).
        judge: {
          rubric: [
            "Score 0-1 on whether the relay UUID PROPAGATED BY COMMUNICATION through the worker",
            "chain. Worker 0 (the origin) invented a random UUID, wrote it to",
            `${ORIGIN_FILE} on its OWN sandbox, and published it into swarm memory under the channel`,
            `tag \`${MEMORY_TAG}\`. Workers 1 and 2 had NO filesystem access to worker 0 — they could`,
            "only obtain the UUID by searching memory (or other messaging). Use read_file with the",
            "`worker` arg to read worker 0's origin file (worker 0), worker 1's receipt at",
            `${HOP_B_FILE} (worker 1), and worker 2's receipt at ${HOP_C_FILE} (worker 2). Evidence of`,
            "genuine propagation: workers 1 and 2 each hold the EXACT same UUID worker 0 invented (on",
            "the `UUID:` line of their receipts) and the transcript shows a memory search/retrieval",
            "before each receipt was written. Score HIGH (≈1) when both downstream receipts carry",
            "worker 0's exact UUID with visible retrieval behavior. Score LOW (≈0) when a receipt's",
            "UUID is DIFFERENT (an invention/guess), when a receipt is missing/empty, or when there is",
            "no sign the value was retrieved from memory. Do NOT re-grade the exact derivations here (a",
            "separate deterministic check does that) — grade only whether the underlying UUID was",
            "COMMUNICATED rather than GUESSED. Do not reward length.",
          ].join(" "),
          agentic: true,
          maxSteps: 12,
        },
      },
    ],
  },
  // Three-worker memory handoff over a dependency fan-out (B and C both depend on
  // A): weaker configs burn turns getting the memory publish/search right, then
  // mis-apply the per-hop derivations (off-by-one nibble counts, char-vs-group
  // reversal, leaving dashes in). Raised to 12 minutes.
  timeoutMs: 12 * 60_000,
};
