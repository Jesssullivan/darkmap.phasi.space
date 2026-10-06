# Real compiled service-worker qualification adapter

Authority: root source-only approval, original Darkmap cache owner. Reliability
lane; existing TIN-5374 is independent and is not rerun/bypassed here.

Frozen application: dd28a8398699e6b790ab29616ad07a15d52c1a02 (direct child of
served ec16b51b5e56ab65efaa4fc10c742573ee2d8056). The prior signed 5aafb3e
31/31 local Bazel receipt remains valid but is NOT image/browser acceptance.
This operator adapter is separate source; no application, provider or lock edits.

Entrypoints:

```
just --justfile ADAPTER/Justfile test-real-service-worker-adapter
just --justfile ADAPTER/Justfile smoke-real-service-worker APP_ROOT LOCAL_IMAGE_URL ARTIFACT_DIR APP_SHA IMAGE_INDEX_DIGEST
```

APP_ROOT supplies the already qualified installed Playwright library. Required
CHROME_BIN points to the existing pinned Chromium; no pnpm install, Nix
realization, source build or application server is spawned by this recipe.
Producer separately records actual image index, amd64 child digest and OCI
revision equality to APP_SHA before running. Exact driver SHA must be recorded.

Acceptance: byte-identical actual image /service-worker.js; activated original
worker and controlling page; genuine service-worker fixture network requests;
normalized cache hit; warm offline hit; expired stale response/Warning/Age with
unchanged write timestamp; coalesced refresh; failed refresh preserving bytes;
worker-local open/match/put denial preserving successful network response;
quota failure retaining prior stored bytes/time; navigation storage-denial
preserving actual HTML; restored storage recovery and truthful offline miss.
Synthetic raster bytes are explicitly fixtures, NEVER scientific measurements.

The owned localhost proxy denies all provider API calls except its scoped
classified raster fixture. Original worker/assets are forwarded without body
changes. Diagnostic same-origin CSP also fences worker external fetches that
page.route cannot intercept. This isolated context does not prove production
CSP, provider availability, user-visible cache UI, worker upgrade from an older
version or first-install CacheStorage denial (outside dd28 runtime scope).
Original 7d415 image UI proof remains separate and blocks workers by design.

Lightweight fixture tests 4/4 PASS, syntax and diff checks PASS. Actual browser
has NOT run. Next heavy phase requires root review and fresh original producer
admission: Sting only, lowering-only MemoryHigh=3G MemoryMax=4G CPUWeight=25,
unchanged parent14/18 limits, exact source/cache/output quota and overlap checks.
No publication/deployment in this phase. Hosted Container GITHUB_TOKEN publisher
is retained for later exact reviewed branch; it rebuilds the image and requires
its own digest/revision readback. Guarded CAS adapter, canonical xoxd and retained
phasi/tinyland hosts remain unchanged; no automatic main rollout.
