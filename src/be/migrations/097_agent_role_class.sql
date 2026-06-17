-- Structured agent role-class for role-class-aware task routing.
-- Keeps reviewer agents off coding tasks and coders off review tasks.
-- NULL = "no signal" → claim gate fails open (a wedged pool is worse than a
-- misroute). Settable via join-swarm / update-profile going forward.
ALTER TABLE agents ADD COLUMN role_class TEXT;

-- Backfill existing rows by deriving from the known agent roster. Anything
-- unmatched stays NULL (treated as `unknown` / fail-open by the policy).
UPDATE agents SET role_class = 'reviewer'
  WHERE name IN ('reviewer-0', 'reviewer-1', 'reviewer-2');

UPDATE agents SET role_class = 'coder'
  WHERE name IN ('Picateclas', 'Techie II', 'Sully', 'Otto');

UPDATE agents SET role_class = 'researcher'
  WHERE name IN ('Principal Researcher', 'Problemillo', 'researcher-1', 'researcher-2', 'researcher-3');

UPDATE agents SET role_class = 'pm'
  WHERE name IN ('Product Manager', 'pm-1', 'pm-2', 'pm-3');

UPDATE agents SET role_class = 'ops' WHERE name = 'Forge';
UPDATE agents SET role_class = 'content' WHERE name = 'Content Reviewer';
UPDATE agents SET role_class = 'qa' WHERE name = 'qa-0';
UPDATE agents SET role_class = 'ux' WHERE name = 'ux-principles-0';

-- Lead is authoritative by flag, not name.
UPDATE agents SET role_class = 'lead' WHERE isLead = 1;
