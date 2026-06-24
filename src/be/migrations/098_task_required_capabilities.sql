-- Add requiredCapabilities to agent_tasks.
--
-- When set (non-null, non-empty JSON array), the pool auto-claim path in
-- /api/poll only lets an agent claim this task if the agent's own capabilities
-- array contains ALL entries listed here.  NULL / '[]' = no requirement
-- (claimable by anyone — fail-open, backward-compatible default).
--
-- Set by workflow agent-task nodes via the `requiredCapabilities` node config
-- field so plan tasks fan to researchers and implement tasks fan to coders
-- without hardcoding individual agent IDs.

ALTER TABLE agent_tasks ADD COLUMN requiredCapabilities TEXT DEFAULT NULL;
