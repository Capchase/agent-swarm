# Database retention runbook

## Permanent-loss warning

Database retention permanently deletes rows. Unsetting a retention key stops future sweeps. It cannot restore deleted rows. Activate retention only when you have verified backups for the data you need.

- `session_logs` deletion removes the line-by-line session transcript. Old task log views and resume preambles become empty.
- `agent_log` deletion removes task and agent state-transition history. Old activity timelines become empty.
- `events` deletion removes telemetry. Aggregate event counters become retention-window totals, not all-time totals. A newer event can retain a `parentEventId` for a deleted older event.

## Scope and safety boundary

The server sweeps only this closed code-reviewed list:

| Table | Retention key | Deleted data |
| --- | --- | --- |
| `session_logs` | `SESSION_LOG_RETENTION_DAYS` | Session transcripts |
| `agent_log` | `AGENT_LOG_RETENTION_DAYS` | Task and agent history |
| `events` | `EVENTS_RETENTION_DAYS` | Telemetry events |

Table and column names never come from configuration. An operator can set a retention duration only. An unset key disables that table's sweep. Values must be whole days from 1 through 1,000,000. Use at least seven days unless you have verified that a shorter window is suitable for your deployment.

To add a table, change the closed descriptor list in `src/be/db-retention.ts`, add a validator, catalog entry, metrics field, docs row, and parameterized tests in the same PR. Add a table only when it has an index on its time column, no incoming foreign keys, and readers that safely tolerate missing old rows.

## Activate retention

1. Verify that database backups include the history you need.
2. Set one retention key, for example `SESSION_LOG_RETENTION_DAYS=30`.
3. Set `DB_RETENTION_DRY_RUN=true`.
4. Wait for the hourly sweep. Inspect `[db-retention]` logs and authenticated `GET /api/metrics`. See [Read the sweep state](#read-the-sweep-state).
5. Confirm that the exact would-delete count and data-loss effect are acceptable. A table whose entry reports `status: "failed"` has no valid count yet.
6. Set `DB_RETENTION_DRY_RUN=false`.
7. Recheck the next sweep. Enable the remaining tables one at a time only after this is stable.

The sweep runs hourly. It uses at most 40 batches of 5,000 rows per enabled table and stops after 60 seconds. A later tick continues an unfinished backlog.

## Read the sweep state

Authenticated `GET /api/metrics` returns a `retention` object. Read it to confirm that the mechanism runs.

`lastTick` records the most recent tick. The server writes it on every tick, even a tick that swept no table. An absent `lastTick` is the only proof that no tick has finished since the process started.

```json
"retention": {
  "lastTick": {
    "startedAt": "2026-09-01T16:49:53.000Z",
    "finishedAt": "2026-09-01T16:50:53.104Z",
    "dryRun": true
  }
}
```

Each enabled table adds an entry under its metrics key: `sessionLogs`, `agentLog` or `events`.

| Field | Meaning |
| --- | --- |
| `status` | `ok` when the sweep finished. `failed` when it threw. |
| `complete` | `false` when the scan stopped before the end of the table. |
| `rowsDeleted` | Deleted rows, or would-delete rows during a dry run. Present only when `complete` is `true`. Read this as a final total. |
| `partialRowsMatched` | Rows an interrupted scan matched before it stopped. Never a total. Present only when the scan stopped early. |
| `error` | Failure reason when `status` is `failed`. |
| `batches`, `durationMs`, `dryRun`, `at` | Batch count, sweep duration in milliseconds, the dry-run flag, and the completion timestamp. |
| `cumulativeRowsDeleted` | Rows deleted for this table since the process started. A dry run adds nothing to it. |

A dry-run count is published only when the scan reached the end of the table. When the 60-second wall-clock budget expires first, the sweep throws, the log shows `[db-retention] <table> sweep failed: dry-run count stopped before completion`, and the entry reports `status: "failed"`, `complete: false` and `partialRowsMatched`. `rowsDeleted` is absent, so a partial figure can never be read as the number of rows the policy would delete.

```json
"sessionLogs": {
  "at": "2026-09-01T16:50:53.071Z",
  "status": "failed",
  "batches": 12,
  "durationMs": 59980,
  "dryRun": true,
  "cumulativeRowsDeleted": 0,
  "complete": false,
  "partialRowsMatched": 58000,
  "error": "dry-run count stopped before completion"
}
```

A repeated failure of this kind means the scan cannot walk the table inside its budget. Retry on a less loaded process, or shorten the backlog before you trust a dry-run total. A failure on one table never stops the other tables in the same tick.

## Disk space and SQLite vacuuming

Deleting rows frees SQLite pages for reuse. It does not normally reduce the database file size.

`PRAGMA incremental_vacuum(2000)` runs only after a non-dry-run sweep actually deletes rows. It does not run while every policy is disabled, when a sweep finds nothing to delete, or during dry run. It reclaims file space only when the database uses `auto_vacuum = INCREMENTAL`. Changing that mode requires a one-time blocking `VACUUM` operation. Schedule it in a maintenance window. Do not run `VACUUM` automatically on a production API database.

```sql
PRAGMA auto_vacuum = INCREMENTAL;
VACUUM;
```

For a smaller copy without changing the active file, plan an offline `VACUUM INTO` operation and verify the backup and cutover procedure first.

## Rollback

Unset the affected retention key. The table stops sweeping on its next hourly tick. Keep `DB_RETENTION_DRY_RUN=true` if you need to inspect candidates without deletion. Restoration of already-deleted rows requires an operator backup.
