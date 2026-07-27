# Agent avatar Lucide discovery

`lucide-react@0.575.0` exposes `iconNames` and `DynamicIcon` from
`lucide-react/dynamic`. `iconNames` provides the complete 1,936-name discovery
surface without importing every SVG. The server only validates the stored icon
as kebab-case, so no backend contract or migration is involved.

The current static 64-icon catalog remains valuable as the no-query shortlist
and fast render path. The 30-entry `WORKER_ICONS` fallback pool (including its
order and modulus) is compatibility-sensitive and must remain unchanged.

Plan A will be accepted only if the production build's chunk count and size are
reasonable. Otherwise the fallback is a static, expanded searchable catalog.
