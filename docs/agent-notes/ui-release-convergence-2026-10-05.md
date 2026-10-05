# Darkmap UI and cache release convergence — 2026-10-05

Authority: operator-approved autonomous integration/release and bounded local
Bazelisk/browser qualification; R-HOOK-CONVERGENCE-20261004, R-N12/R-N13.
Root release lane owns the sole heavy producer. Do not dispatch GF browser
proof or rerun/bypass independent TIN-5374 for this release.

Preserved base: `044705ec1a13284f13985c8da6bb7495ae15b32c`, based on current
GitHub main `4abc16935af081567902a4e25d9f4efad01eae08`. Original seven dirty
paths in `skeleton5-reconcile-20260927` were read, selectively carried with
apply_patch, and left unchanged. The source-fusion contract remains outside
this carrier. Cache source `e242578` was cherry-picked as `ffeea4e`; see the
separate data/cache receipt for provenance and acceptance limits.

Skeleton 5.0.1 and Zag 1.43.0 lock graph now match the manifest. Air/local dome
remain in the right inspector. Compact tall mounts exactly one compact
InstrumentColumn, not a CSS-hidden second desktop instance. Short landscape
uses native Air disclosure without duplicating the dome. FloatingPanel offers
drag, resize, minimize/maximize/restore, redock and Escape focus recovery.
Only the viewport toolbar owns the visible Twilight toggle; command-palette
action remains. Focused tests include reduced motion and unique mount counts.

## Producer entrypoints

From the clean integrated source, root runs pinned tooling:

```sh
nix develop .#browser --command just setup
nix develop .#browser --command just typecheck
nix develop .#browser --command just test-unit
nix develop .#browser --command just build
nix develop .#browser --command just test-instrument-panel
```

The focused browser recipe requires the prebuilt bundle and pinned CHROME_BIN;
Playwright uses that executable with SwiftShader rather than downloading a
browser. This is authorized local qualification, not an RBE claim. Root may
select smaller Bazel targets if full test graph is expensive, and must name the
exact tests actually run. Source checks are not runtime acceptance.

## Publish and exact-source rollout

Existing `Container` workflow builds the adapter-node Containerfile production
stage and publishes GHCR SHA/branch tags with OCI revision metadata using its
existing GITHUB_TOKEN custody. No replacement registry credential is needed.
After publishing the qualified source, resolve its immutable digest through
`skopeo inspect --override-os linux --override-arch amd64`, then run
`just deploy-exact FULL_SOURCE_SHA sha256:DIGEST` from that exact clean checkout.
The recipe verifies source, honey context and image revision before updating
only Deployment/darkmap's app image; it does not apply mutable-main manifests.
The legacy `just deploy` remains available but is not exact-source proof.

Read-only metadata at 2026-10-05 approximately 21:34 UTC: honey deployment
generation 244, ready 2/2, image tag `4abc169`; registry OCI revision equals the
full main SHA above; registry and both pod imageIDs use
`sha256:24297eeadfe47c39ec6ae59935cd3ca96fab1e54c9e22c0a399ddfcda88cf0aa`.
This is the prior image and rollback reference, not the new release digest.
No Secret payloads were read.

All three hosts returned HTTPS 200 with xoxd canonical/OG URL during the
earlier 21:04–21:07 UTC audit. Preserve `darkmap.xoxd.ai`, public
`darkmap.phasi.space`, and tailnet `darkmap.tinyland.dev`; no DNS mutation is
required. Acceptance still needs exact new image identity, rollout readiness,
served map/browser smoke and all-host continuity after deployment.
