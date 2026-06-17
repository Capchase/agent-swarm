-- Belt-and-suspenders CHECK constraint on role_class.
-- Migration 097 added the column as unconstrained TEXT. A typo like
-- 'reviever' would pass through rowToAgent's blind cast as a non-null,
-- non-unknown value, causing the claim gate to treat it as a hard
-- mismatch instead of failing open. rowToAgent now validates via
-- RoleClassSchema.safeParse (runtime guard), and this migration adds the
-- DB-level constraint so the storage layer itself rejects bad writes.
-- Forward-only: do NOT edit 097 (already applied in production).
--
-- SQLite cannot add a CHECK constraint to an existing column via ALTER TABLE,
-- so we rebuild the table following the established pattern (migration 053):
-- create agents_new, copy, DROP agents, rename agents_new → agents. This
-- avoids the "rename parent table → child FK clauses get rewritten to the
-- tmp name → DROP tmp → dangling FK" trap that the reverse pattern (rename
-- agents → tmp) falls into with modern SQLite (legacy_alter_table=OFF).
-- Column list derived from: 001 + 027 + 048 + 053 + 054 + 055 + 082 + 097.

-- 1. Create new table with the role_class CHECK constraint.
CREATE TABLE agents_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    isLead INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL
        CHECK(status IN ('idle', 'busy', 'offline', 'waiting_for_credentials')),
    description TEXT,
    role TEXT,
    role_class TEXT CHECK (role_class IS NULL OR role_class IN (
        'coder', 'reviewer', 'researcher', 'pm', 'ops', 'content', 'qa', 'ux', 'lead', 'unknown'
    )),
    capabilities TEXT DEFAULT '[]',
    maxTasks INTEGER DEFAULT 1,
    emptyPollCount INTEGER DEFAULT 0,
    claudeMd TEXT,
    soulMd TEXT,
    identityMd TEXT,
    setupScript TEXT,
    toolsMd TEXT,
    lastActivityAt TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    heartbeatMd TEXT DEFAULT NULL,
    provider TEXT,
    credentialMissing TEXT,
    harness_provider TEXT NULL,
    cred_status TEXT,
    created_by TEXT REFERENCES users(id),
    updated_by TEXT REFERENCES users(id)
);

-- 2. Copy existing data.
INSERT INTO agents_new (
    id, name, isLead, status, description, role, role_class, capabilities,
    maxTasks, emptyPollCount, claudeMd, soulMd, identityMd, setupScript, toolsMd,
    lastActivityAt, createdAt, lastUpdatedAt, heartbeatMd, provider,
    credentialMissing, harness_provider, cred_status, created_by, updated_by
)
SELECT
    id, name, isLead, status, description, role, role_class, capabilities,
    maxTasks, emptyPollCount, claudeMd, soulMd, identityMd, setupScript, toolsMd,
    lastActivityAt, createdAt, lastUpdatedAt, heartbeatMd, provider,
    credentialMissing, harness_provider, cred_status, created_by, updated_by
FROM agents;

-- 3. Drop old table + rename. Foreign keys referencing agents.id in child
--    tables (agent_skills, mcp_servers, etc.) survive the rename because
--    agents_new has no children — no FK clause rewriting occurs.
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
