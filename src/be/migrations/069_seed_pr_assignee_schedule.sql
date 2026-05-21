-- Seed nightly schedule to backfill PR assignees for capchase-bot-authored PRs.
-- INSERT OR IGNORE so re-running on an existing DB is a no-op.
INSERT OR IGNORE INTO scheduled_tasks (
  id,
  name,
  description,
  cronExpression,
  taskTemplate,
  taskType,
  tags,
  priority,
  enabled,
  timezone,
  scheduleType,
  createdAt,
  lastUpdatedAt
) VALUES (
  'backfill-pr-assignees-schedule',
  'backfill-pr-assignees',
  'Daily job: assign unassigned capchase-bot PRs to the human who triggered each swarm task. Runs scripts/backfill-pr-assignees.ts.',
  '0 2 * * *',
  'Run the PR-assignee backfill script to assign any unassigned capchase-bot GitHub PRs from the last 7 days to their human requester.

Execute this exact command and report the output:
```
bun scripts/backfill-pr-assignees.ts
```

Working directory: /workspace/repos/agent-swarm

Report the final summary line (assigned=N skipped_no_user=M ...) as your task output.',
  'maintenance',
  '["infra","pr-assignee"]',
  30,
  1,
  'UTC',
  'recurring',
  datetime('now'),
  datetime('now')
);
