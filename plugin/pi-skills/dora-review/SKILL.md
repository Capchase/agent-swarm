---
name: dora-review
description: Run Dora's corpus-grounded code review pass on a Capchase/client-monorepo PR and emit a structured findings block to fold into your single consolidated review verdict. Use when reviewing a client-monorepo PR before posting your gh pr review.
---

# Dora Review — corpus-grounded analysis for client-monorepo PRs

## Overview

This skill runs the Dora export→review→import flow on a `Capchase/client-monorepo` PR. It uses Dora's framework, rule system, and corpus as the basis for analysis and emits a structured findings block for you to fold into your **single consolidated `gh pr review`** verdict.

**This is NOT a "Dora bot."** This skill does not post a separate review or standalone inline comments. It is a mandatory analysis step that runs before you post, and its findings are weighed into your own judgment. You remain the judge — you can dismiss false positives.

## Arguments

- `pr-number`: The PR number to review (e.g. `29017`).

## Prerequisites

- `gh` authenticated against the Capchase org (`gh auth status`)
- `jq` installed
- `node` installed (any version ≥18)
- A `Capchase/client-monorepo` checkout (see Step 1 — the skill obtains it)

## Workflow

### Step 1 — Obtain/confirm the client-monorepo checkout

The Dora corpus pass requires a local checkout of `Capchase/client-monorepo` **on `origin/master`** — the persona, corpus, and scope-matcher always come from the local working tree, even in `--pr` mode. A PR branch cut before Dora merged (2026-06-08, commit `6c4fb2c9b3d`) will NOT have the scripts.

```bash
MONOREPO_DIR=/workspace/personal/repos/client-monorepo

# Clone if absent
if [ ! -d "$MONOREPO_DIR/.git" ]; then
  gh repo clone Capchase/client-monorepo "$MONOREPO_DIR"
fi

cd "$MONOREPO_DIR"
git fetch origin master --quiet
git checkout master --quiet
git pull origin master --quiet 2>&1 | tail -3

# Verify Dora is present
if [ ! -f "scripts/ai-review.sh" ]; then
  echo "ERROR: scripts/ai-review.sh not found on master — aborting corpus pass."
  echo "Falling back to your own analysis (corpus findings unavailable)."
  exit 1
fi
echo "✅ client-monorepo on master with Dora scripts confirmed"
```

If the checkout fails or `scripts/ai-review.sh` is absent, **skip the corpus pass** and fall back to your own analysis. Never post a review claiming corpus grounding when the pass did not run.

### Step 2 — Export the prepared inputs (no LLM call)

```bash
PR_NUMBER=<N>
EXPORT_DIR=/tmp/dora-export-pr${PR_NUMBER}
mkdir -p "$EXPORT_DIR"

cd "$MONOREPO_DIR"
AI_REVIEW_PROVIDER=export AI_REVIEW_EXPORT_DIR="$EXPORT_DIR" \
  bash scripts/ai-review.sh --pr "$PR_NUMBER" --agent rule --dry-run
```

This writes four files into `$EXPORT_DIR/` (no LLM call, no Anthropic creds needed):
- `system.md` — full system prompt: persona body + the corpus subset scoped to the changed files
- `prompt.md` — user prompt with the diff payload, `addedLines`, `allowedScopes`, and `instructions.maxComments`
- `review-input.json` — the same data in structured JSON
- `expected-schema.json` — JSON Schema your result must conform to

If the export emits `"Prepared: 0 file(s)"` (all files ignored by `applies_to` globs), skip to Step 5 and note "corpus pass: no applicable files."

### Step 3 — Produce the result.json using YOUR OWN reasoning

You are the model. Read `$EXPORT_DIR/system.md` as your system context and `$EXPORT_DIR/prompt.md` as your user message, then produce a JSON object that conforms to `$EXPORT_DIR/expected-schema.json`.

**Hard rules (from Dora's own prompt — do not violate):**
1. Return ONLY a single JSON object — no prose, no markdown fences.
2. Use ONLY paths present in `files[].path` from the payload.
3. Use ONLY line numbers present in `files[i].addedLines`. Never invent.
4. Scope discipline: a finding's cited rule scope MUST appear in that file's `allowedScopes`. `core` applies to every file. Do not cross domain boundaries.
5. Confidence thresholds: CRITICAL ≥0.60, HIGH ≥0.75, MEDIUM ≥0.80, LOW ≥0.95.
6. Do not repeat findings already covered in `existingAiComments`.
7. Prefer fewer high-confidence comments. If unsure, skip.
8. Hard ceiling: `instructions.maxComments`. Not a target.

**Result schema:**
```json
{
  "summary": "one short sentence",
  "humanReviewRecommended": { "value": false, "reason": "" },
  "comments": [
    {
      "path": "exact path from input.files",
      "line": 42,
      "severity": "CRITICAL | HIGH | MEDIUM | LOW",
      "title": "short title (<= 60 chars)",
      "confidence": 0.92,
      "message": "what's wrong (1-2 sentences, <= 120 words)",
      "suggestion": "one concrete fix"
    }
  ],
  "resolvedComments": []
}
```

Write the JSON **exactly** to `$EXPORT_DIR/result.json` (plain JSON, no markdown fences).

### Step 4 — Import and validate

```bash
cd "$MONOREPO_DIR"
bash scripts/ai-review.sh \
  --pr "$PR_NUMBER" \
  --import-result "$EXPORT_DIR/result.json" \
  --agent rule \
  --dry-run
```

This validates every finding against the diff's added lines, drops any comment whose `line` is not in `addedLines`, and prints the surviving findings. The `--dry-run` flag ensures **nothing is posted to GitHub** — consolidation into your review is your job, not this step's.

Note the output — it will show how many findings survived validation.

### Step 5 — Emit the corpus-findings block

Format the surviving validated findings as a structured block for your review body. Group by severity:

```
## Corpus findings (Dora rule pass)

### CRITICAL
- **[path:line]** title — message. Suggestion: suggestion.

### HIGH
- **[path:line]** title — message. Suggestion: suggestion.

### MEDIUM
- **[path:line]** title — message. (skipped: reason if applicable)

### LOW
(none / omitted if empty)

_Corpus summary: <summary from result.json>_
_Pass: <N> file(s) reviewed, <M> finding(s) validated_
```

If the export produced no applicable files, write: `_Corpus pass: no files matched Dora's applicable-paths filter — no findings._`

If the pass was skipped due to a checkout failure, write: `_Corpus pass: checkout unavailable — findings not available for this review._`

## How to use these findings in your review

This findings block is structured input to your own single verdict. You are the judge:

- **HIGH/CRITICAL findings you agree with** → include in your `gh pr review --request-changes` body and/or as inline comments.
- **Findings you judge as false positives** → dismiss them; don't let a false positive drive a request-changes.
- **MEDIUM/LOW findings** → cite as improvement suggestions in a `--comment` or append to the review body; they should not independently drive `--request-changes`.
- **Empty findings** → note "corpus pass: clean" in your review. Do not use an empty corpus pass to downgrade your own verdict if you found issues independently.

Your single `gh pr review` post (approve / request-changes / comment) is the only GitHub action. Do not call `--post` in Step 4 and do not post a separate Dora-attributed review.

## Cleanup (optional)

```bash
rm -rf "$EXPORT_DIR"
```

## Notes

- This skill must be invoked BEFORE you run `gh pr review`. It is a mandatory analysis step inside `/review-pr` for `Capchase/client-monorepo` PRs.
- The corpus lives in `.reviewers/rule/corpus/` on master. Rule changes in the monorepo are picked up automatically — no skill update needed.
- Dora is not in CI today. This skill is the swarm's advisory corpus pass. CI / Cursor-replacement is separate and out of scope.
- If `ai-review.sh` changes its invocation contract, check `.agents/skills/dora-review/SKILL.md` in the monorepo for the updated recipe.
