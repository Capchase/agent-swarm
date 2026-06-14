import { fileContainsOnWorker } from "../src/judge/deterministic.ts";
import type { CheckResult, DeterministicCheck, Scenario } from "../src/types.ts";

/**
 * memory-coordination (v8.0 round-11, Memory-as-shared-substrate, 3 workers)
 * -------------------------------------------------------------------------
 * Calibrated spread: TODO(calibration) — fill frontierAvg / budgetAvg / gap from
 * the round-11 sweep (anchors: claude-opus-4.8, codex-5.5 vs pi-deepseek-flash,
 * claude-haiku). Ship gate: frontierAvg − budgetAvg ≥ 0.2. Target ~0.3 → 0.85.
 *
 * A SWARM-MECHANICS scenario where the bottleneck is shared memory, NOT model
 * capability: each sub-task is individually trivial for any decent model, but the
 * SYSTEM only succeeds if the team uses swarm memory as shared infrastructure to
 * transfer knowledge between filesystem-isolated workers.
 *
 * Worker 0 (the INVESTIGATOR) is seeded — on its sandbox ONLY, via `seed.exec`
 * (which the runner runs in worker 0's sandbox alone) — with an incident dossier
 * (`/workspace/dossier/incident-INC-4417.md`). It must extract EIGHT structured
 * findings — six HEADLINE facts (incident id, root-cause commit SHA, the service
 * that failed, the rollback target tag, the on-call engineer, the customer-impact
 * minutes) PLUS two SECONDARY facts buried later in the same dossier sections as a
 * headline (the merge PR number buried in Root cause, the failure deploy cell/region
 * buried in Summary, the error-rate peak buried in Impact) — and PUBLISH each to
 * SWARM memory (scope swarm, via its memory tools) under a shared channel tag, plus
 * write its own findings file.
 *
 * HARDENING (round 11, post-saturation sweep): opus-4.8, pi-deepseek-flash AND
 * claude-haiku all scored 1.00 on BOTH correctness and the coordination judge — the
 * substrate was too easy because every headline fact sits as the first salient token
 * in its own dossier section and surfaces on a single shallow lookup. To make graded
 * correctness DISCRIMINATE again WITHOUT restructuring the dimensions, the answer key
 * is deepened from 6 distinct values to TWELVE downstream sub-facts using four
 * proven techniques: (a) MORE extracted facts (buried secondaries the investigator
 * must publish too); (b) BURIED facts tucked late in the same section as a headline,
 * so grabbing the first salient token per section misses them; (c) tightened
 * NEAR-MISS distractors in the dossier AND two red-herring swarm memories that sit
 * one token off the truth, so shallow retrieval lands on the wrong value and the
 * anchored checks reject it; (d) a CROSS-REFERENCE fact (a deploy-freeze ref) that
 * is stated atomically in NO single memory — the synthesizer must combine the
 * incident id from one memory with the rollback tag from another to construct it, so
 * a worker that stops after the first hit gets it wrong. A budget model that does
 * shallow/lazy retrieval now recalls the obvious headlines but misses the buried
 * secondaries, mis-grabs a near-miss distractor, and fails to assemble the
 * cross-reference; a frontier model that reads the whole dossier and all the
 * memories end-to-end keeps them.
 *
 * Workers 1 and 2 (the SYNTHESIZERS) have NO copy of the dossier — their sandboxes
 * are fresh (seed.exec never touches them), so the ONLY path to the findings is
 * RETRIEVING worker 0's swarm memory. Each writes a deliverable that must COMBINE
 * MULTIPLE of worker 0's stored facts:
 *   - Worker 1 writes a remediation ticket combining the incident id + the
 *     root-cause SHA + the rollback target tag + the failed service + the buried
 *     merge PR number + a CROSS-REFERENCE deploy-freeze ref it must assemble from
 *     the incident id and the rollback tag (two separately-stored memories).
 *   - Worker 2 writes a status-page postmortem combining the incident id + the
 *     on-call engineer + the customer-impact minutes + the failed service + the
 *     buried failure deploy cell/region + the buried error-rate peak.
 * Neither deliverable's facts can be produced without first reading worker 0's
 * memory: a swarm that does not use memory as shared infra simply CANNOT transfer
 * the knowledge (workers 1/2 have no local source).
 *
 * Reuses the cross-worker `workers: 3` + `seed.exec` (writable scratch dir on
 * worker 0) + `dependsOn` fan-out machinery from `cross-worker-invent`, and the
 * per-fact graded-recall pattern from `memory-distractor` (here applied to a
 * cross-worker memory handoff), plus the full-roster agentic judge (v8.0 §4 —
 * reads ANY worker's sandbox + session logs) for the provenance grade.
 *
 * Requires an embedding key in evals/.env (EMBEDDING_API_KEY or OPENAI_API_KEY)
 * for the swarm memory store/search the worker-0→workers-1/2 handoff relies on —
 * same as cross-worker-invent / distributed-audit.
 *
 * Grading:
 *   - `correctness` (weight 3): a single inline graded check (factsRecalled-style,
 *       `score = matched / total`) over BOTH downstream deliverables. Each of
 *       worker 1's six required facts and worker 2's six required facts is a
 *       distinctive regex anchored on the dossier-derived VALUE (which appears in
 *       NO prompt). TWELVE sub-facts total → fine-grained partial credit so a team
 *       that transferred half the facts ranks below one that transferred them all
 *       and above one that transferred none. A worker that never read memory writes
 *       a deliverable missing every value-bearing fact and scores 0 on its half.
 *       The buried secondaries (PR number, deploy cell, error-rate peak) and the
 *       cross-reference deploy-freeze ref discriminate a thorough transfer from a
 *       shallow one: a budget model that grabs the headline value per section and
 *       stops misses ~half and scores ≈0.5; a frontier model that reads the whole
 *       dossier + all memories keeps ≈0.9+.
 *   - `memory-coordination` (weight 1, custom, agentic — depends on Phase 4): a
 *       judge reads worker 0's sandbox + session logs to confirm it WROTE structured
 *       memory (the facts derived from the dossier), then reads workers 1/2 sandboxes
 *       to confirm THEIR values MATCH worker 0's stored facts AND were
 *       RETRIEVED-not-guessed: the values are absent from workers 1/2 prompts, present
 *       in memory, and the transcript shows a memory search before the deliverable was
 *       written. It grades the COORDINATION (did the value propagate via memory), not
 *       exact fact correctness (the deterministic check does that).
 *
 * Anti-gaming (checklist applied to THIS scenario):
 *   - The source dossier is seeded on worker 0 ONLY (seed.exec runs in worker 0's
 *     sandbox alone). Workers 1 and 2 have NO local copy — `fileAbsentOnWorker`-style
 *     isolation is structural, not just by convention — so the ONLY path to the
 *     facts is retrieving worker 0's swarm memory. A swarm that ignores memory cannot
 *     transfer the knowledge at all.
 *   - The fact VALUES (the SHA, the rollback tag, the engineer name, the impact
 *     minutes, etc.) appear in NONE of the task prompts — only in the seeded dossier
 *     on worker 0. Workers 1/2's prompts name which FIELDS to combine, never the
 *     values. Echoing the prompt or guessing scores 0 on the per-fact checks.
 *   - The dossier values are deliberately specific and non-guessable (a 40-hex SHA,
 *     a `v`-prefixed semver rollback tag, a distinctive engineer name, an odd impact
 *     figure), and the dossier embeds RED-HERRING values (a superseded commit, an
 *     earlier rollback candidate, a secondary service, a different responder) so a
 *     worker 0 that grabs the wrong field publishes a wrong fact and tanks the
 *     downstream checks — discrimination on careful extraction, not just transfer.
 *   - Each downstream deliverable requires COMBINING multiple stored facts (4 each),
 *     so a worker can't "win" by surfacing a single value — it must read several of
 *     worker 0's memories and assemble them.
 *   - The agentic memory-coordination judge cross-checks provenance across all three
 *     sandboxes + session logs, so a value that landed by coincidence (without a
 *     memory write on worker 0 or a memory read on workers 1/2) is not rewarded.
 *   - The grading rubric / per-fact patterns are NOT shown to any worker.
 *
 * Answer key (mirror of the seeded dossier below — keep them in lockstep; if the
 * dossier changes, update these patterns AND the dossier heredoc together). Six
 * HEADLINE facts + three BURIED secondaries + one CROSS-REFERENCE = the twelve
 * downstream sub-facts:
 *   incident id            = INC-4417
 *   root-cause commit SHA  = 9f3c1a7e2b4d6f8a0c2e1d3b5a7c9e1f0a2b4c6d  (NOT the
 *                            superseded 0011223344556677889900aabbccddeeff001122)
 *   failed service         = checkout-orchestrator     (NOT the secondary
 *                            "inventory-sync" mentioned as merely degraded)
 *   rollback target tag    = v2.19.4                    (NOT the earlier candidate
 *                            v2.18.0 that was rejected)
 *   on-call engineer       = Priya Natarajan            (NOT the secondary
 *                            responder "Marcus Feld" who only ack'd)
 *   customer-impact minutes = 73                        (NOT the unrelated 41-min blip)
 *   --- buried secondaries (tucked late in a section that opens with a headline) ---
 *   merge PR number        = #8842                      (buried in Root cause; NOT the
 *                            superseded suspect's PR #8830)
 *   failure deploy cell    = eu-central-1c              (buried in Summary; NOT the
 *                            decommissioned eu-central-1a, NOT inventory-sync's 1b)
 *   error-rate peak        = 18.4%                      (buried in Impact; NOT the
 *                            unrelated blip's 4.1%)
 *   --- cross-reference (atomic in NO single memory) ---
 *   deploy-freeze ref      = freeze-INC-4417-v2.19.4    (worker 1 must ASSEMBLE this
 *                            from the incident id + the rollback tag — each stored in
 *                            a separate memory; the literal string is in none, and the
 *                            near-miss freeze-INC-4417-v2.18.0 built from the rejected
 *                            tag fails the \b2\.19\.4\b anchor)
 *
 * Two RED-HERRING swarm memories (seed.memories, scope swarm — visible to ALL
 * workers) sit one token off the truth so a synthesizer that doesn't discriminate
 * on the channel tag / "of record" phrasing can land the wrong value:
 *   - a stale draft naming the superseded SHA 0011…, the rejected tag v2.18.0, and
 *     the merely-degraded inventory-sync as if confirmed;
 *   - a paging-log fragment crediting the responder Marcus Feld and citing the
 *     unrelated 41-min/4.1% blip as the customer impact.
 */

const DOSSIER_DIR = "/workspace/dossier";
const DOSSIER_FILE = `${DOSSIER_DIR}/incident-INC-4417.md`;

// Worker 0 writes its own extracted findings here; workers 1/2 write their
// memory-sourced deliverables to their own sandboxes (the only handoff is memory).
const FINDINGS_FILE = `${DOSSIER_DIR}/findings.md`;
const TICKET_FILE = "/workspace/coord/remediation-ticket.md";
const POSTMORTEM_FILE = "/workspace/coord/status-postmortem.md";

// A shared, distinctive memory channel tag the workers are told to use so the
// synthesizers can find worker 0's published findings. The tag is part of the
// protocol the prompts describe; the SECRET is the dossier-derived fact VALUES
// (in the seeded file on worker 0), never the tag.
const MEMORY_TAG = "incident-INC-4417-findings-7kx";

// ---- The seeded incident dossier (worker 0's sandbox only). Carries the six
// ground-truth facts plus red herrings (a superseded commit, an earlier rejected
// rollback candidate, a secondary degraded service, a secondary responder) so a
// careless extraction publishes a wrong fact. Heredoc'd via seed.exec — runs in
// worker 0's sandbox alone, so workers 1/2 never see it. ----
const DOSSIER_CONTENT = [
  "# Incident postmortem — INC-4417",
  "",
  "## Summary",
  "On the night of the deploy, the **checkout-orchestrator** service began",
  "returning 5xx on the payment-intent path and had to be rolled back. A",
  "secondary service, **inventory-sync** (which runs in the eu-central-1b cell),",
  "was DEGRADED (elevated latency) but did NOT fail and required no rollback — it",
  "recovered on its own once checkout-orchestrator was restored. The failing",
  "service of record for this incident is checkout-orchestrator. NOTE on placement:",
  "checkout-orchestrator used to run in the now-decommissioned eu-central-1a cell,",
  "but at the time of the incident the failing checkout-orchestrator instances were",
  "deployed in the **eu-central-1c** cell — eu-central-1c is the deploy cell of",
  "record for this failure.",
  "",
  "## Root cause",
  "The regression was introduced by commit",
  "`9f3c1a7e2b4d6f8a0c2e1d3b5a7c9e1f0a2b4c6d`, which changed the idempotency-key",
  "hashing and silently dropped retries. An EARLIER commit",
  "`0011223344556677889900aabbccddeeff001122` (which landed in pull request",
  "**#8830**) was initially suspected and investigated, but it was SUPERSEDED — it",
  "was already live for two weeks without incident and is NOT the root cause. The",
  "confirmed root-cause commit is 9f3c1a7e2b4d6f8a0c2e1d3b5a7c9e1f0a2b4c6d, which",
  "merged via pull request **#8842**. The merge PR of record for the root cause is",
  "#8842 (the superseded suspect's #8830 is a red herring).",
  "",
  "## Remediation / rollback",
  "Rolling back to tag `v2.18.0` was considered first but REJECTED — it predates a",
  "required schema migration and would have broken the orders table. The deploy was",
  "instead rolled back to the last-known-good release tag **v2.19.4**, which",
  "restored service. The rollback target of record is v2.19.4. Per the change-",
  "management runbook, any incident that triggers a production rollback opens a",
  "deploy-freeze ticket whose reference is formed as",
  "`freeze-<incident-id>-<rollback-tag>` — the incident id joined to the rollback",
  "target tag with hyphens.",
  "",
  "## Response",
  "The page fired at 02:14. **Marcus Feld** acknowledged the page but handed off",
  "immediately; he did not drive the response. The on-call engineer who actually",
  "owned and resolved the incident was **Priya Natarajan**, who performed the",
  "rollback and wrote this postmortem. On-call engineer of record: Priya Natarajan.",
  "",
  "## Impact",
  "Customer-visible impact (elevated error rate on checkout) lasted 73 minutes,",
  "from 02:14 to 03:27. (An internal alerting blip 41 minutes earlier, which briefly",
  "showed a 4.1% error rate on an unrelated canary, was unrelated and had no",
  "customer impact.) Customer-impact duration of record: 73 minutes. During the",
  "incident window the checkout error rate PEAKED at **18.4%** before the rollback;",
  "18.4% is the peak error rate of record (the unrelated 4.1% blip is not it).",
].join("\n");

// ---- Per-fact answer key, graded individually over each downstream deliverable
// (partial credit). Each pattern is anchored on the distinctive dossier-derived
// VALUE so a red-herring value (the superseded SHA, the rejected v2.18.0 tag, the
// inventory-sync service, the Marcus Feld responder) never matches, and the
// values appear in NO prompt. ----
interface DownstreamFact {
  label: string;
  pattern: RegExp;
}

// Worker 1's remediation ticket must combine SIX facts: the incident id, the
// confirmed root-cause SHA, the rollback target tag, the failed service, the BURIED
// merge PR number, and the CROSS-REFERENCE deploy-freeze ref it must assemble from
// the incident id + the rollback tag (stored in separate memories; atomic in none).
const TICKET_FACTS: DownstreamFact[] = [
  { label: "incident-id=INC-4417", pattern: /INC-4417/i },
  // The CONFIRMED root-cause SHA (anchored full 40-hex so the superseded
  // 0011… SHA fails). Case-insensitive hex.
  { label: "root-cause-sha", pattern: /9f3c1a7e2b4d6f8a0c2e1d3b5a7c9e1f0a2b4c6d/i },
  // The rollback target tag v2.19.4 (anchored \b so the rejected v2.18.0 fails).
  { label: "rollback-tag=v2.19.4", pattern: /\bv?2\.19\.4\b/i },
  // The failed service (anchored so the secondary "inventory-sync" doesn't match).
  { label: "failed-service=checkout-orchestrator", pattern: /checkout-orchestrator/i },
  // BURIED: the merge PR of record (#8842), tucked late in the Root cause section
  // after the headline SHA. Anchored so the superseded suspect's #8830 fails — a
  // shallow read that grabs the first PR token in the section lands on #8830.
  { label: "merge-pr=#8842", pattern: /#?\b8842\b/ },
  // CROSS-REFERENCE: the deploy-freeze ticket ref, stated atomically in NO single
  // memory. The runbook gives the template `freeze-<incident-id>-<rollback-tag>`;
  // worker 1 must assemble it from the incident id (INC-4417) and the rollback tag
  // (v2.19.4) — each retrieved from a SEPARATE memory. Anchored so the near-miss
  // freeze-INC-4417-v2.18.0 (built from the rejected tag) fails the version anchor.
  {
    label: "deploy-freeze-ref=freeze-INC-4417-v2.19.4",
    pattern: /freeze-INC-4417-v?2\.19\.4\b/i,
  },
];

// Worker 2's status-page postmortem must combine SIX facts: the incident id, the
// on-call engineer, the customer-impact minutes, the failed service, the BURIED
// failure deploy cell, and the BURIED error-rate peak.
const POSTMORTEM_FACTS: DownstreamFact[] = [
  { label: "incident-id=INC-4417", pattern: /INC-4417/i },
  // The on-call engineer who OWNED the incident (not the secondary responder
  // "Marcus Feld"). Tolerant of casing; both name tokens required nearby.
  {
    label: "oncall=priya-natarajan",
    pattern: /priya[\s\S]{0,20}?natarajan|natarajan[\s\S]{0,20}?priya/i,
  },
  // Customer-impact minutes = 73, proximity-anchored to a minutes/impact word so a
  // stray 73 elsewhere (or the unrelated "41 minutes earlier") doesn't satisfy it.
  {
    label: "impact-minutes=73",
    pattern: /\b73\b[^\n]{0,30}(min|impact|duration)|(min|impact|duration)[^\n]{0,30}\b73\b/i,
  },
  // The failed service (shared with the ticket — both deliverables must name it,
  // proving each independently retrieved that fact from memory).
  { label: "failed-service=checkout-orchestrator", pattern: /checkout-orchestrator/i },
  // BURIED: the failure deploy cell (eu-central-1c), tucked late in the Summary
  // after the headline service. Anchored so the decommissioned eu-central-1a and
  // inventory-sync's eu-central-1b (both named earlier in the section) fail — a
  // shallow read that grabs the first region token lands on the wrong cell.
  { label: "deploy-cell=eu-central-1c", pattern: /eu-central-1c\b/i },
  // BURIED: the peak error rate during the incident (18.4%), tucked at the END of
  // the Impact section. Anchored so the unrelated blip's 4.1% (named earlier in the
  // same section) fails — a shallow read that stops at the first percentage misses it.
  { label: "error-peak=18.4%", pattern: /\b18\.4\s*%/ },
];

/** One downstream deliverable graded over its worker's sandbox: a worker + path + facts. */
interface DownstreamDeliverable {
  label: string;
  worker: number;
  path: string;
  facts: DownstreamFact[];
}

const DELIVERABLES: DownstreamDeliverable[] = [
  { label: "ticket", worker: 1, path: TICKET_FILE, facts: TICKET_FACTS },
  { label: "postmortem", worker: 2, path: POSTMORTEM_FILE, facts: POSTMORTEM_FACTS },
];

// ---- RED-HERRING swarm memories (scope swarm — seeded BEFORE tasks, visible to
// ALL workers including the synthesizers). They look on-topic for the same incident
// but carry the SUPERSEDED / near-miss values, and crucially they do NOT carry the
// investigator's channel tag (MEMORY_TAG). A synthesizer that searches broadly and
// grabs the first plausible hit — instead of discriminating on the channel tag and
// the "of record"/confirmed phrasing — pulls a wrong value and the anchored checks
// reject it. The investigator's own authoritative memories (written at runtime, tag-
// stamped) are the only correct source. None of these values appear in any prompt. ----
const DISTRACTOR_MEMORIES: string[] = [
  // Stale triage draft: names the SUPERSEDED SHA, the REJECTED tag, the merely-
  // degraded inventory-sync, and the suspect PR #8830 as if they were confirmed.
  "INC-4417 early triage draft (NOT final — superseded): initial suspicion fell on commit 0011223344556677889900aabbccddeeff001122, merged in pull request #8830, and the team first proposed rolling back to tag v2.18.0. The inventory-sync service in eu-central-1b looked like the failing component at first glance. This draft predates the confirmed root-cause analysis and should not be cited as the findings of record.",
  // Paging-log fragment: credits the secondary responder Marcus Feld and cites the
  // unrelated 41-min / 4.1% blip as if it were the customer impact.
  "INC-4417 paging log excerpt: 02:14 page acknowledged by Marcus Feld. An alerting blip 41 minutes earlier showed a 4.1% error rate on a canary. (This excerpt is raw pager data, not the validated postmortem; impact figures here are NOT the customer-impact of record.)",
];

/**
 * Inline graded correctness check (factsRecalled-style, defined here per the
 * round-11 inline-checks rule). Reads BOTH downstream deliverables (worker 1's
 * ticket, worker 2's postmortem) and scores the FRACTION of the twelve
 * dossier-derived sub-facts present across them — `score = matched / total`.
 * Partial credit so a team that transferred half the facts ranks between a full
 * transfer and none. The values live ONLY in worker 0's seeded dossier (and the
 * swarm memory it must publish), never in any prompt, so a deliverable written
 * without reading memory scores 0 on its facts. A missing deliverable file
 * contributes 0 for all of its facts (it can never match).
 */
const downstreamFactsCombined: DeterministicCheck = {
  name: "downstream-facts-combined",
  fn: async (ctx): Promise<CheckResult> => {
    const total = DELIVERABLES.reduce((s, d) => s + d.facts.length, 0);
    if (total === 0) return { pass: true, score: 1, detail: "no facts" };
    let matched = 0;
    const missed: string[] = [];
    for (const d of DELIVERABLES) {
      const w = ctx.workers[d.worker];
      const content = w ? await w.readFile(d.path) : null;
      for (const f of d.facts) {
        if (content !== null && f.pattern.test(content)) {
          matched++;
        } else {
          missed.push(`${d.label}/${f.label}`);
        }
      }
    }
    const score = matched / total;
    return {
      pass: matched === total,
      score,
      detail:
        matched === total
          ? `all ${total} combined downstream facts present`
          : `${matched}/${total} combined downstream facts present (missing: ${missed.join(", ")})`,
    };
  },
};

export const memoryCoordination: Scenario = {
  id: "memory-coordination",
  name: "Memory coordination",
  description: [
    "Memory-as-shared-substrate, three workers. Worker 0 is seeded (on its sandbox ONLY) with an",
    "incident dossier and must extract eight structured findings (six headlines plus buried",
    "secondaries the dossier tucks late in a section) and PUBLISH each into swarm memory under a",
    "shared channel tag, discriminating them from two seeded red-herring memories that carry stale",
    "near-miss values. Workers 1 and 2 have NO copy of the dossier — their only path to the facts is",
    "RETRIEVING worker 0's swarm memory — and each writes a deliverable (a remediation ticket and a",
    "status-page postmortem) that must COMBINE six of worker 0's stored facts, including a",
    "cross-reference (a deploy-freeze ref) assembled from two separately-stored memories. A swarm that",
    "does not use memory as shared infrastructure cannot transfer the knowledge at all. Graded on",
    "combined downstream per-fact correctness (3×, twelve value-bearing facts derived from the dossier",
    "and absent from every prompt) and an agentic memory-coordination judge (1×) that confirms worker 0",
    "wrote the memory and workers 1/2 retrieved-not-guessed it.",
  ].join(" "),
  workers: 3,
  seed: {
    // seed.exec runs on worker 0 only. Plant the dossier on worker 0's sandbox so
    // it has source material; workers 1 and 2 never see it (separate sandboxes),
    // which is exactly the isolation the scenario relies on. The heredoc avoids
    // any quoting hazards by piping a base64 of the content into the file.
    exec: [
      `mkdir -p ${DOSSIER_DIR} && chmod -R a+rwX ${DOSSIER_DIR}`,
      `printf '%s' '${Buffer.from(DOSSIER_CONTENT).toString("base64")}' | base64 -d > ${DOSSIER_FILE}`,
    ],
    // RED-HERRING swarm memories indexed (scope swarm) BEFORE tasks — visible to all
    // workers. They carry the superseded/near-miss values and lack the channel tag,
    // so a synthesizer that does shallow retrieval and grabs the first on-topic hit
    // pulls a wrong value; only the investigator's tag-stamped runtime memories are
    // authoritative. None of these values appear in any prompt.
    memories: DISTRACTOR_MEMORIES,
  },
  tasks: [
    {
      title: "Investigate the incident dossier and publish findings to swarm memory",
      worker: 0,
      description: [
        "You are the INVESTIGATOR. An incident postmortem dossier has been placed on your sandbox at",
        `\`${DOSSIER_FILE}\`. Read the WHOLE dossier carefully, every section end-to-end — it contains`,
        "misleading/superseded details (an earlier suspected commit and its pull request, a rejected",
        "rollback candidate, a secondary degraded service in a different cell, a responder who only",
        "acknowledged the page, an unrelated earlier alerting blip). Several sections OPEN with a",
        "headline value and then BURY a second, equally-required value later in the same section — do not",
        "stop at the first value you see. Determine the CONFIRMED value (the dossier's stated 'of record'",
        "/ confirmed value, never a red herring) for EACH of these EIGHT findings:",
        "",
        "  1. The incident id.",
        "  2. The confirmed ROOT-CAUSE commit SHA (the one of record, not the superseded suspect).",
        "  3. The service that actually FAILED and was rolled back (not the merely-degraded one).",
        "  4. The rollback TARGET release tag (the one service was restored to, not the rejected one).",
        "  5. The ON-CALL engineer who owned and resolved the incident (not the responder who only ack'd).",
        "  6. The customer-impact duration in minutes (the customer-visible one, not the unrelated blip).",
        "  7. The merge PULL-REQUEST number of the confirmed root cause (buried later in the Root cause",
        "     section — NOT the suspect commit's PR).",
        "  8. The deploy CELL/region the failing service ran in at incident time (buried later in the",
        "     Summary — NOT the decommissioned cell, NOT the degraded service's cell), AND the PEAK error",
        "     rate during the incident window (buried at the end of Impact — NOT the unrelated blip's rate).",
        "",
        "Two other agents will build deliverables from your findings, and they CANNOT see your files —",
        "swarm memory is the ONLY way to hand the findings off. NOTE: some on-topic-looking memories about",
        "this incident were seeded earlier that carry STALE/superseded values and do NOT use the channel",
        "tag below; do not let those pollute your published findings — publish only the confirmed values",
        "you derived from the dossier, tagged. So you MUST:",
        "  - Index the findings into SWARM memory (scope swarm) using your memory tools — store every",
        `    finding (you may use one memory per finding or group them) AND include the exact channel`,
        `    tag \`${MEMORY_TAG}\` in the memory content so the other agents can search for it. Store the`,
        "    incident id and the rollback target tag clearly (a downstream agent must combine them).",
        `  - Also write all the findings to \`${FINDINGS_FILE}\` on your own sandbox (one labeled line`,
        "    each) as your local record.",
        "",
        "Do not invent values — every finding must come from the dossier. Then report completion via",
        "store-progress.",
      ].join("\n"),
    },
    {
      title: "Write the remediation ticket (combine the rollback facts)",
      worker: 1,
      dependsOn: [0],
      description: [
        "You are a SYNTHESIZER. Another agent (the investigator) studied an incident and published its",
        `findings into SWARM memory under the channel tag \`${MEMORY_TAG}\`. You do NOT have the source`,
        "dossier and CANNOT see the investigator's files — searching swarm memory is the ONLY way to get",
        "the facts. Do NOT guess or invent values.",
        "",
        `Search your memory for the channel tag \`${MEMORY_TAG}\` and retrieve the investigator's`,
        "findings. WARNING: some other on-topic-looking memories about this incident were seeded that",
        "carry STALE/superseded values and do NOT use that channel tag — trust only the investigator's",
        "tag-stamped findings of record. Read enough of the tagged findings to recover EACH field below;",
        "do not stop at the first hit. Then create the directory `/workspace/coord/` and write a",
        `remediation ticket to \`${TICKET_FILE}\` (markdown) that COMBINES the following SIX retrieved`,
        "facts:",
        "",
        "  - The incident id.",
        "  - The confirmed root-cause commit SHA.",
        "  - The rollback target release tag.",
        "  - The service that failed and was rolled back.",
        "  - The merge pull-request number of the confirmed root cause.",
        "  - The deploy-freeze ticket reference. This is NOT stored as a ready-made string — you must",
        "    CONSTRUCT it from two separately-stored findings, joined as `freeze-<incident-id>-<rollback-",
        "    tag>` (the incident id and the rollback target tag, hyphen-joined, exactly as the runbook",
        "    rule the investigator stored prescribes).",
        "",
        "State all six clearly in the ticket (e.g. a 'Root cause' line with the SHA, a 'Rollback to' line",
        "with the tag, a 'Merge PR' line, a 'Deploy-freeze' line, etc.). Use exactly the values you",
        "retrieved from memory — they are not in this prompt. Then report completion via store-progress.",
      ].join("\n"),
    },
    {
      title: "Write the status-page postmortem (combine the impact facts)",
      worker: 2,
      dependsOn: [0],
      description: [
        "You are a SYNTHESIZER. Another agent (the investigator) studied an incident and published its",
        `findings into SWARM memory under the channel tag \`${MEMORY_TAG}\`. You do NOT have the source`,
        "dossier and CANNOT see the investigator's files — searching swarm memory is the ONLY way to get",
        "the facts. Do NOT guess or invent values.",
        "",
        `Search your memory for the channel tag \`${MEMORY_TAG}\` and retrieve the investigator's`,
        "findings. WARNING: some other on-topic-looking memories about this incident were seeded that",
        "carry STALE/superseded values and do NOT use that channel tag — trust only the investigator's",
        "tag-stamped findings of record. Read enough of the tagged findings to recover EACH field below;",
        "do not stop at the first hit. Then create the directory `/workspace/coord/` and write a public",
        `status-page postmortem to \`${POSTMORTEM_FILE}\` (markdown) that COMBINES the following SIX`,
        "retrieved facts:",
        "",
        "  - The incident id.",
        "  - The on-call engineer who owned and resolved the incident.",
        "  - The customer-impact duration in minutes.",
        "  - The service that failed.",
        "  - The deploy cell/region the failing service ran in at incident time.",
        "  - The peak error rate during the incident window.",
        "",
        "State all six clearly (e.g. an 'Impact: <N> minutes' line, an 'Owner: <name>' line, a 'Cell:' line,",
        "a 'Peak error rate:' line, etc.). Use exactly the values you retrieved from memory — they are not",
        "in this prompt. Then report completion via store-progress.",
      ].join("\n"),
    },
  ],
  outcome: {
    // Gates (binary must-pass): BOTH downstream deliverables must EXIST on their
    // workers' sandboxes (the required output surfaces — the synthesizers actually
    // produced something). The synthetic tasks-completed gate is prepended by the
    // runner. Per-fact correctness + coordination provenance are GRADED (not gated)
    // so partial credit discriminates a full transfer from a partial/no transfer.
    gates: [
      fileContainsOnWorker(1, TICKET_FILE, /\S/),
      fileContainsOnWorker(2, POSTMORTEM_FILE, /\S/),
    ],
    dimensions: [
      {
        name: "correctness",
        weight: 3,
        // The combined downstream answer key graded over BOTH deliverables
        // (partial credit over the twelve value-bearing facts). The values live
        // only in worker 0's seeded dossier + the memory it must publish.
        checks: [downstreamFactsCombined],
      },
      {
        name: "memory-coordination",
        weight: 1,
        // Custom dimension (allowed by design). Agentic so the judge can read
        // worker 0's sandbox + session logs (did it WRITE structured memory) and
        // workers 1/2's sandboxes (do their values MATCH worker 0's stored facts,
        // and were they RETRIEVED not guessed) — Phase 4 full-roster tools.
        judge: {
          rubric: [
            "Score 0-1 on whether the incident findings PROPAGATED THROUGH SWARM MEMORY from the",
            "investigator (worker 0) to the two synthesizers (workers 1 and 2). Worker 0 was the only",
            `worker with the source dossier (at ${DOSSIER_FILE} on worker 0's sandbox); workers 1 and 2`,
            "had NO copy and could only obtain the findings by searching swarm memory under the channel",
            `tag \`${MEMORY_TAG}\`. Two RED-HERRING memories about the same incident were also seeded`,
            "(scope swarm) that carry STALE/superseded near-miss values and do NOT use that channel tag —",
            "the authoritative source is worker 0's tag-stamped findings of record, not those distractors.",
            "",
            "Use the tools to verify, in order:",
            `  1. Worker 0 WROTE the findings to swarm memory. Read worker 0's findings file at`,
            `     ${FINDINGS_FILE} (read_file, worker 0) and inspect worker 0's session logs / transcript`,
            "     (api_get on /api/tasks/<id>/session-logs, or the transcript excerpt) for an",
            "     index-memory / store-memory call carrying the findings and the channel tag. Worker 0",
            "     must have derived the findings from the dossier (the confirmed values, not the red",
            "     herrings) and published them — not just written a local file.",
            `  2. Workers 1 and 2 RETRIEVED those facts from memory, not guessed them. Read worker 1's`,
            `     ticket at ${TICKET_FILE} (read_file, worker 1) and worker 2's postmortem at`,
            `     ${POSTMORTEM_FILE} (read_file, worker 2). Their values must MATCH the facts worker 0`,
            "     stored, and the workers' transcripts should show a memory SEARCH before each",
            "     deliverable was written. The fact values appear in NO task prompt, so a matching value",
            "     is strong evidence it came from memory.",
            "",
            "Score HIGH (≈1) when worker 0 published structured findings to memory AND both downstream",
            "deliverables carry matching values with visible memory-retrieval behavior. Score LOW (≈0)",
            "when worker 0 never wrote memory, when a downstream deliverable's values do NOT match worker",
            "0's stored facts (an invention/guess), when a deliverable is missing, or when there is no",
            "sign the values were retrieved from memory. Do NOT re-grade exact per-fact correctness here",
            "(a separate deterministic check does that) — grade only whether the knowledge was",
            "COORDINATED THROUGH MEMORY rather than guessed or never transferred. Do not reward length.",
          ].join(" "),
          agentic: true,
          maxSteps: 12,
        },
      },
    ],
  },
  // A three-worker memory-as-substrate scenario: worker 0 must derive + publish eight
  // findings (six headlines + buried secondaries), discriminating them from two seeded
  // red-herring memories, then two synthesizers fan out (both depend on worker 0) and
  // each must search memory and assemble six facts — one of them a cross-reference built
  // from two separate memories. Weaker configs burn turns getting the memory
  // publish/search right, stop at the first hit and miss the buried secondaries, grab a
  // near-miss red-herring value, fail to assemble the cross-reference, or never use
  // memory at all (and then have no source). Budgeted at 14 minutes.
  timeoutMs: 14 * 60_000,
};
