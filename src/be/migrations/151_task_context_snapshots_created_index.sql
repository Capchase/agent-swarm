-- task_context_snapshots has no incoming foreign keys and grows without
-- bound (670,381 rows reaching back five months on a live instance) while
-- db-retention's sweep never touches it. This index gives the retention
-- DELETE an indexed path over createdAt, matching the naming convention
-- idx_<table>_createdAt used by the other retention-covered tables, so its
-- sweep does not table-scan the backlog.
CREATE INDEX IF NOT EXISTS idx_task_context_snapshots_createdAt ON task_context_snapshots(createdAt);
