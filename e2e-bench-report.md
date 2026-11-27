## E2E benchmark

sqlite: 2026-11-21T22:40:19.174Z (43.5s), postgres: 2026-11-21T22:41:03.465Z (66.9s)

| Surface | SQLite | Postgres |
| --- | ---: | ---: |
| routes covered | 16/511 | 16/511 |
| mcp tools covered | 1/194 | 1/194 |
| node types covered | 0/15 | 0/15 |

| Latency | SQLite p50 | Postgres p50 | Δ p50 | SQLite p95 | Postgres p95 | Δ p95 | Calls SQLite / Postgres |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| overall | 76.63 | 128.91 | +52.28 (+68%) | 291.72 | 911.21 | +619.49 (+212%) | 766 / 722 |
| agents | 63.04 | 147.71 | +84.67 (+134%) | 170.38 | 518.73 | +348.35 (+204%) | 75 / 75 |
| executor-types | 34.01 | 11.32 | -22.69 (-67%) | 34.01 | 11.32 | -22.69 (-67%) | 1 / 1 |
| kv | 20.83 | 70.33 | +49.50 (+238%) | 31.01 | 146.32 | +115.31 (+372%) | 21 / 21 |
| poll | 23.12 | 55.57 | +32.45 (+140%) | 94.35 | 241.74 | +147.39 (+156%) | 192 / 192 |
| schedules | 111.79 | 213.82 | +102.03 (+91%) | 305.28 | 435.34 | +130.06 (+43%) | 169 / 125 |
| tasks | 108.62 | 206.13 | +97.51 (+90%) | 347.8 | 949.12 | +601.32 (+173%) | 287 / 287 |
| workflows | 26.69 | 44.9 | +18.21 (+68%) | 34.13 | 56.56 | +22.43 (+66%) | 21 / 21 |

| Scenario | SQLite | Postgres | Δ |
| --- | ---: | ---: | ---: |
| divergence-concurrent-schedule-claim | 20.5s pass | 20.8s pass | +310.00 (+2%) |
| stress-poll-claim | 1.9s pass | 3.9s pass | +1991.00 (+106%) |
| stress-task-create | 0.5s pass | 0.7s pass | +261.00 (+57%) |
| stress-task-finish | 2.3s pass | 3.2s pass | +890.00 (+38%) |

Suite exit codes: SQLite 0, Postgres 0.

### Postgres transaction retries by site

36 sites, 1923 transactions, 173 retried, 0 exhausted retries. D7 threshold: a retry rate above 5% at a site.

| Site | Transactions | Retried | Retry rate | Retries | Exhausted | SQLSTATEs |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `src/http/kv.ts:663` | 20 | 18 | 90.0% ⚠ | 58 | 0 | 40001×58 |
| `src/http/tasks.ts:1381` | 10 | 9 | 90.0% ⚠ | 9 | 0 | 40001×9 |
| `src/workflows/engine.ts:350` | 10 | 9 | 90.0% ⚠ | 9 | 0 | 40001×9 |
| `src/scheduler/scheduler.ts:297` | 111 | 99 | 89.2% ⚠ | 395 | 0 | 40001×395 |
| `src/http/agents.ts:758` | 51 | 38 | 74.5% ⚠ | 71 | 0 | 40001×71 |
| `src/be/boot-scrub-sweep.ts:366` | 601 | 0 | 0.0% | 0 | 0 |  |
| `src/http/poll.ts:826` | 192 | 0 | 0.0% | 0 | 0 |  |
| `src/http/tasks.ts:2039` | 156 | 0 | 0.0% | 0 | 0 |  |
| `src/be/seed-prompt-templates.ts:141` | 134 | 0 | 0.0% | 0 | 0 |  |
| `src/http/tasks.ts:1388` | 121 | 0 | 0.0% | 0 | 0 |  |
| `src/http/poll.ts:837` | 120 | 0 | 0.0% | 0 | 0 |  |
| `src/be/savings/rollup.ts:195` | 91 | 0 | 0.0% | 0 | 0 |  |
| `src/be/savings/rollup.ts:268` | 91 | 0 | 0.0% | 0 | 0 |  |
| `src/tools/send-task.ts:675` | 60 | 0 | 0.0% | 0 | 0 |  |
| `src/be/seed-skills/index.ts:708` | 58 | 0 | 0.0% | 0 | 0 |  |
| `src/be/scripts/db.ts:117` | 42 | 0 | 0.0% | 0 | 0 |  |
| `src/http/agents.ts:1075` | 24 | 0 | 0.0% | 0 | 0 |  |
| `src/http/workflows.ts:819` | 10 | 0 | 0.0% | 0 | 0 |  |
| `src/be/db/model-groups.ts:95` | 4 | 0 | 0.0% | 0 | 0 |  |
| `src/be/seed-pricing.ts:441` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/be/rbac-roles.ts:412` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/be/model-catalog-store.ts:211` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/be/pricing-refresh.ts:69` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/be/db/tasks/search-index.ts:92` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/be/db/tasks/human-free.ts:217` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/be/db/session-moves.ts:44` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/be/session-source-backfill.ts:109` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/be/boot-scrub-sweep.ts:256` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/scheduler/scheduler.ts:362` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/scheduler/scheduler.ts:407` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/http/schedules.ts:887` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/workflows/engine.ts:993` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/workflows/checkpoint.ts:51` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/workflows/engine.ts:715` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/http/workflows.ts:1068` | 1 | 0 | 0.0% | 0 | 0 |  |
| `src/be/rbac-audit.ts:184` | 1 | 0 | 0.0% | 0 | 0 |  |
