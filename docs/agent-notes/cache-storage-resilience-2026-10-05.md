# Cache-storage resilience follow-up — 2026-10-05

Authority: root reattachment of the original data/cache lane with minimal actual
source fixes authorized; R-HOOK-CONVERGENCE-20261004, R-N12/R-N13. Source parent
is served/accepted application ec16b51b5e56ab65efaa4fc10c742573ee2d8056.
Mapping: TIN-1709 / GH #269, browser freshness and mobile storage-budget follow-up.

## Concrete source defect and bounded fix

Despite e242's successful cache-put quota handling, runtime cacheFirst awaited
CacheStorage.open/match outside its network fallback. A denied storage API could
therefore prevent a healthy online tile request. networkFirst also let cache.open
failure discard a successful navigation response and replace its failure with a
second storage failure. This is actual source behavior, not a inference from the
provider-denial image smoke.

The two-file change treats cache open/match/write availability as optional while
preserving successful network bytes, normalized refresh coalescing, and the original
network error if both network and fallback storage fail. Existing readable cache
entries and source age/stale labels retain their prior semantics. No purge, new
provider, TTL policy, key operation, panel, lock or infrastructure change is included.
User-visible benefit: online maps/navigation still work when browser storage is
denied; offline data is not fabricated when storage cannot be read.

## Checks and remaining acceptance

Temporary Just diagnostic on this candidate passed all 31 runtime-cache tests,
including six new open/match failure, independent body/coalescing and original-error
regressions. Focused formatting and git diff --check pass. The diagnostic borrowed
owner-checkout dependencies/generated configuration via temporary symlinks removed
afterward; it is not a new frozen-install, hermetic Bazel or browser proof. Root's
producer owns any subsequent //src/lib/sw:sw_test and bounded browser admission.

Service-worker activation remains a distinct acceptance gap. Source installs an
app-shell cache before skipWaiting, then removes old app-shell versions and calls
clients.claim while retaining runtime buckets. A provider-denied image capture with
service workers blocked cannot prove activation, real offline-to-online refresh,
old-bucket migration or mobile storage pressure. Private/storage-disabled browsers
may never install a worker; this fix does not promise offline capability there.

Runtime stale bytes remain labelled fallback, not current measurements. The browser
fallback itself is not age-bounded; the raster origin cache separately uses a
24-hour fresh window plus seven-day stale allowance. Shared edge-cache hits and
versioned scientific source invalidation remain GH #163 / TIN-1287 / GH #103.

## Provider truth retained, not re-probed

The three public probes at 2026-10-05 22:48:56–57 UTC showed OpenAQ marker discovery
HTTP 200, degraded=false, one marker; CAMS air-quality HTTP 200 with a matched 22:00
model hour and finite PM2.5/AOD; representative VIIRS raster HTTP 403. These are dated
live receipts, not fresh measurement proof or a served-SHA binding. No additional
provider call or credential inspection was needed for this source fix.

OpenAQ metadata does not establish a fresh station value/history. CAMS remains a
model, not an observed substitute; missing observations stay unavailable, not zero.
AirNow/ColorVision palettes change presentation only. The smallest public/FOSS
follow-up is honest per-source modeled fallback/cache/provenance, not wholesale
replacement or reverse-decoding styled colors. Open-Meteo hosted non-commercial
eligibility is separate from its AGPL server/self-host path; consult existing
provider-terms receipts before making commercial hosted assumptions.
