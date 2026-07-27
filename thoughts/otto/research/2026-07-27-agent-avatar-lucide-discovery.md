# Agent avatar Lucide discovery

`lucide-react@0.575.0` exposes `iconNames` and `DynamicIcon` from
`lucide-react/dynamic`. `iconNames` provides the complete 1,936-name discovery
surface without importing every SVG. The server only validates the stored icon
as kebab-case, so no backend contract or migration is involved.

The current static 64-icon catalog remains valuable as the no-query shortlist
and fast render path. The 30-entry `WORKER_ICONS` fallback pool (including its
order and modulus) is compatibility-sensitive and must remain unchanged.

Plan A was rejected after production builds: baseline was 182 files / 6,920,761
bytes; dynamic imports emitted 1,717 files / 7,889,424 bytes. Plan B's static
400-icon catalog measured 185 files / 7,015,043 bytes, so it adds only three
files and 94,282 bytes without a lazy-chunk explosion.
