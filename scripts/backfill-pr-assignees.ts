#!/usr/bin/env bun
/**
 * Backfill PR assignees for capchase-bot-authored PRs that have no assignee.
 *
 * Queries the swarm API for tasks completed in the last N days whose output
 * contains a GitHub PR URL. For each unassigned PR authored by capchase-bot,
 * assigns it to the task's requestedByUserId's GitHub account.
 *
 * Config (env vars):
 *   BACKFILL_LOOKBACK_DAYS  — days to look back (default: 7)
 *   BACKFILL_DRY_RUN        — if "true", log actions but don't call gh pr edit (default: false)
 *   MCP_BASE_URL            — swarm API base URL (default: http://localhost:3013)
 *   AGENT_SWARM_API_KEY / API_KEY — swarm API key
 *   BOT_GITHUB_LOGIN        — GitHub login of the bot account to match (default: capchase-bot)
 */

import { getApiKey } from "../src/utils/api-key";

const API_URL = process.env.MCP_BASE_URL || "http://localhost:3013";
const API_KEY = getApiKey();
const LOOKBACK_DAYS = Number(process.env.BACKFILL_LOOKBACK_DAYS ?? "7");
const DRY_RUN = process.env.BACKFILL_DRY_RUN === "true";
const BOT_LOGIN = process.env.BOT_GITHUB_LOGIN || "capchase-bot";

// Matches GitHub PR URLs: https://github.com/<owner>/<repo>/pull/<number>
const GH_PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g;

const headers: Record<string, string> = {
  "Content-Type": "application/json",
};
if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${API_URL}${path}`, { headers });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

async function getGithubUsername(userId: string): Promise<string | null> {
  const user = await apiGet<{ identities?: Array<{ kind: string; externalId: string }> }>(
    `/api/users/${userId}`,
  );
  return user?.identities?.find((i) => i.kind === "github")?.externalId ?? null;
}

type Task = {
  id: string;
  status: string;
  output?: string;
  requestedByUserId?: string;
  finishedAt?: string;
};

async function main() {
  console.log(
    `[backfill] Starting PR assignee backfill (lookback=${LOOKBACK_DAYS}d, dry_run=${DRY_RUN})`,
  );

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const tasks = await apiGet<{ tasks: Task[] }>(
    `/api/tasks?status=completed&since=${encodeURIComponent(since)}&limit=500`,
  );

  if (!tasks?.tasks) {
    console.error("[backfill] Failed to fetch tasks from API");
    process.exit(1);
  }

  // Collect tasks that have PR URLs in their output
  const candidates: Array<{ url: string; task: Task }> = [];
  for (const task of tasks.tasks) {
    if (!task.output) continue;
    const matches = task.output.match(GH_PR_URL_RE);
    if (!matches) continue;
    for (const url of [...new Set(matches)]) {
      candidates.push({ url, task });
    }
  }

  console.log(`[backfill] Found ${candidates.length} PR URL(s) across ${tasks.tasks.length} completed tasks`);

  let assigned = 0;
  let skippedNoUser = 0;
  let skippedAlreadyAssigned = 0;
  let skippedWrongAuthor = 0;
  let errors = 0;

  for (const { url, task } of candidates) {
    try {
      // Check PR state via gh CLI
      const viewProc = Bun.spawnSync(["gh", "pr", "view", url, "--json", "author,assignees"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      if (viewProc.exitCode !== 0) {
        console.log(`[backfill] SKIP ${url}: gh pr view failed — ${viewProc.stderr?.toString().trim()}`);
        errors++;
        continue;
      }

      const prData = JSON.parse(viewProc.stdout.toString()) as {
        author: { login: string };
        assignees: Array<{ login: string }>;
      };

      if (prData.author.login !== BOT_LOGIN) {
        skippedWrongAuthor++;
        continue;
      }

      if (prData.assignees.length > 0) {
        skippedAlreadyAssigned++;
        continue;
      }

      if (!task.requestedByUserId) {
        console.log(`[backfill] SKIP ${url}: task ${task.id.slice(0, 8)} has no requestedByUserId`);
        skippedNoUser++;
        continue;
      }

      const githubUsername = await getGithubUsername(task.requestedByUserId);
      if (!githubUsername) {
        console.log(`[backfill] SKIP ${url}: user ${task.requestedByUserId} has no github identity`);
        skippedNoUser++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`[backfill] DRY_RUN: would assign ${url} to ${githubUsername}`);
        assigned++;
        continue;
      }

      const editProc = Bun.spawnSync(
        ["gh", "pr", "edit", url, "--add-assignee", githubUsername],
        { stdout: "pipe", stderr: "pipe" },
      );

      if (editProc.exitCode !== 0) {
        console.log(`[backfill] ERROR assigning ${url}: ${editProc.stderr?.toString().trim()}`);
        errors++;
      } else {
        console.log(`[backfill] Assigned ${url} → @${githubUsername}`);
        assigned++;
      }
    } catch (err) {
      console.log(`[backfill] ERROR processing ${url}: ${(err as Error).message}`);
      errors++;
    }
  }

  console.log(
    `[backfill] Done. assigned=${assigned} skipped_no_user=${skippedNoUser} ` +
      `skipped_already_assigned=${skippedAlreadyAssigned} skipped_wrong_author=${skippedWrongAuthor} errors=${errors}`,
  );
}

await main();
