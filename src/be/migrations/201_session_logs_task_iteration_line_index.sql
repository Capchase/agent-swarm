-- SAV-6951 finding 1: remove the temp B-tree sort for reads by task in log order.
CREATE INDEX IF NOT EXISTS idx_session_logs_taskId_iteration_lineNumber
  ON session_logs(taskId, iteration, lineNumber);
