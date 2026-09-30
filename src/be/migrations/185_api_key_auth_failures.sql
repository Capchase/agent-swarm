-- Consecutive auth failures per key, for the Codex pool auth bench.
ALTER TABLE api_key_status ADD COLUMN consecutiveAuthFailures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_key_status ADD COLUMN lastAuthFailureAt TEXT;
