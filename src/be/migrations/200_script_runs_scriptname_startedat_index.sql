-- SAV-6951 finding 2: the script detail page filters by scriptName and sorts by startedAt.
CREATE INDEX IF NOT EXISTS idx_script_runs_scriptName_startedAt
  ON script_runs(scriptName, startedAt DESC);
