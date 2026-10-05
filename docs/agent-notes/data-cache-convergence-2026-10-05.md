# Data/cache convergence — 2026-10-05

Authority: operator-approved local Bazelisk/browser qualification and convergence
on current GitHub main `4abc16935af081567902a4e25d9f4efad01eae08`;
R-HOOK-CONVERGENCE-20261004, R-N12/R-N13. This source receipt does not assert
deployment or provider-key validity.

## Source boundaries

Reviewed and integrated the six-path source/test graph delta from PR #455,
signed head `b9491abacc02d6c22402961fe9db60018ffc6244`, for TIN-1709 / GH #269.
Runtime entries obey their response's browser max-age, preserve origin age,
refresh unknown/expired metadata, coalesce equivalent requests per bucket and
storage adapter, and preserve usable offline bytes when refresh fails. Cache
writes record decoded bytes and actual write time; quota failures do not discard
successful network responses. App-shell behavior and 32 MiB eviction are unchanged.

Added response-local `x-darkmap-runtime-cache: fresh|stale`, accumulated Age when
known, and a stale Warning. Hits do not rewrite stored timestamps. Stale fallback
is offline continuity, not a promise of current environmental measurements;
clients must retain source observation/model timestamps and unavailable states.

Main already contains bounded OpenAQ requests, success-only five-minute caching,
in-flight sharing, 429 cooldown and distinct failure reasons. It also rejects
out-of-coverage forecast times. These changes are not replayed from older WIP.
Shared origin/edge caching remains GH #163; process-cache hits are not edge proof.

## Provider, palette and scientific truth

AirNow in the AQI palette selector is the EPA-category presentation palette,
not an AirNow API integration. ColorVision Assist is an alternative accessible
presentation ramp, not a measurement provider. Switching palettes changes no
concentration, AQI, station identity or timestamp. Never derive physical values
by reversing a styled raster's colors.

OpenAQ stations are observations; CAMS/Open-Meteo values are model forecasts.
Keep their provenance separate when displaying or comparing them. Missing data
is null/unavailable, never zero. Hosted free-use eligibility is separate from
open-source/self-host capability. No new provider, credential or quota call is
introduced by this tranche.

TIN-1287 / GH #103 / PR #456 remain scientific raster authority. Real approved
NASA granules, QA-reviewed Float32 COG and acquired reference PNGs are separate
inputs; synthetic fixtures do not establish radiance or upstream style parity.
Preserve units, nodata, checksums, QA and projection geometry before rollout.

Geometric viewport sun/moon summaries remain keyed by UTC day and canonical tile
cover under `docs/EPHEMERIS_TILE_CACHE.md`. Terrain-horizon-aware pin/GPS results
remain observer-specific; do not substitute coarse summaries for precise twilight.
Location-derived runtime keys may persist in browser Cache Storage; cache clearing
is an operator/user choice, not an automatic broad purge in this change.

## Validation handoff

Root owns integrated local Bazelisk, application and browser qualification and
deployment receipts. Prior #455 unit evidence is not new candidate evidence.
Focused candidate diagnostic through a temporary Just entrypoint passed 43 tests
in the runtime-cache and browser-adapter slices (two files). The attempted policy
filter matched no file; no policy-slice pass is claimed. Dependencies and generated
SvelteKit configuration were borrowed by temporary symlinks from the owner checkout
(removed after the diagnostic);
this is a compatibility diagnostic, not hermetic Bazel or browser proof.
No Skeleton, lockfile, page/panel, credential, DNS or scientific-input mutation
is included. Existing source-owner worktrees remain intact.
