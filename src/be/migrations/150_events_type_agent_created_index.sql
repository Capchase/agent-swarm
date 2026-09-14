-- getEventsFiltered (src/be/events.ts) builds a dynamic WHERE clause; the
-- GET /api/events?event=&agentId=&dataField= combination produces
-- "WHERE event = ? AND agentId = ? AND json_extract(data, '$.field') = ?
-- ORDER BY createdAt DESC LIMIT ?" against events, a table with only
-- single-column indexes. SQLite seeks the single-column agentId index, runs
-- json_extract on every matching row, then sorts the whole result set in a
-- temp B-tree before applying LIMIT. Composite index leads with the equality
-- columns and trails with the sort column, so the seek is selective and
-- ORDER BY is satisfied directly from the index.
CREATE INDEX IF NOT EXISTS idx_events_event_agent_created ON events(event, agentId, createdAt DESC);
