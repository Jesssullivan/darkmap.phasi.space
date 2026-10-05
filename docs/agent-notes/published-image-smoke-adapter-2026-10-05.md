# Published-image smoke adapter — 2026-10-05

Authority: root-approved actual-image smoke request relayed through the release
producer; R-HOOK-CONVERGENCE-20261004, R-N12/R-N13. This is a delivery-adapter
successor, not an application rebuild or source qualification change.

`just smoke-published-image` requires the qualified app root, explicit localhost
container URL, artifact directory, full app SHA and immutable image digest.
It resolves installed Playwright from that app root and uses locked CHROME_BIN.
It never builds or spawns an application server. The producer independently
binds the running container's OCI revision/digest to those recorded arguments.

The driver checks actual image /healthz and homepage HTTP 200, canonical xoxd URL,
nonzero MapLibre canvas with WebGL context, right inspector geometry, a unique
instrument column, Skeleton detach/redock and compact mobile instrument mounting.
It captures desktop, detached and mobile screenshots plus a JSON evidence receipt.
Unexpected page exceptions fail; console errors are recorded for operator review.

External requests and /api provider routes are intercepted: OpenAQ receives an
explicit degraded empty diagnostic; other provider routes receive 503. This
tests unavailable-data UI against the real published image without consuming
provider quota or credentials. It does not prove basemap/raster geographic data,
measurements, provider keys, public routing, first-run onboarding or full field QA.
Tour dismissal is preseeded and service workers are blocked for this bounded run.

Source checks: node syntax, Just recipe discovery and whitespace pass. Actual
image/browser execution and the admitted container/browser memory allocation
belong to the root producer. No image pull/start, heavy browser, credential or
cluster action was performed in preparing this adapter.
