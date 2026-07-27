# Agent avatar Lucide picker QA

Ran locally on 2026-07-27 with `qa-use` against a scratch API and Vite UI.

- [Default shortlist](screenshots/2026-07-27-agent-avatar-lucide-picker/01-default-shortlist.png): an empty query shows the familiar 64 choices.
- [Normalized search](screenshots/2026-07-27-agent-avatar-lucide-picker/02-normalized-search.png): `tree deciduous` finds `tree-deciduous` and reports 1 of 1.
- [Result cap](screenshots/2026-07-27-agent-avatar-lucide-picker/03-result-cap.png): broad `a` query reports 100 of 307.
- [Persistence](screenshots/2026-07-27-agent-avatar-lucide-picker/04-selection-persisted.png): selecting `tree-deciduous` survives a page reload.
- [Zero result](screenshots/2026-07-27-agent-avatar-lucide-picker/05-zero-results.png): an unmatched query reports 0 of 0.
