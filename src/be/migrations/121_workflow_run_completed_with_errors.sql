-- Add 'completed_with_errors' as a valid status for workflow runs.
-- Lets a "continue"-mode run that walked through a node failure report
-- itself accurately instead of claiming "completed" (see
-- src/workflows/resume.ts finalizeOrWait / checkpointStepContinuedAfterFailure).
-- SQLite does not support ALTER CHECK constraints, so we recreate the table
-- (mirrors 025_workflow_run_cancelled_status.sql's recipe, updated for the
-- created_by/updated_by columns added by 082_user_audit_fields.sql).

-- 1. Create the new table with the widened CHECK constraint
CREATE TABLE workflow_runs_new (
  id TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled', 'completed_with_errors')),
  triggerData TEXT,
  context TEXT,
  error TEXT,
  startedAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  finishedAt TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

-- 2. Copy existing data
INSERT INTO workflow_runs_new SELECT * FROM workflow_runs;

-- 3. Drop old table and rename
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;

-- 4. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflowId ON workflow_runs(workflowId);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
