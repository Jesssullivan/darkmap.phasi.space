# Guarded delivery adapter — 2026-10-05

Authority: explicit root/operator request for an isolated delivery-script
successor; R-HOOK-CONVERGENCE-20261004, R-N12/R-N13. Source parent is product
candidate `c1e4ff4`; no running product qualification checkout is changed.

The previous helper used unconditional `kubectl set image`. The successor
requires the recorded Deployment UID, app image and resourceVersion. It reads
metadata/spec, requires exactly one container named app and checks all recorded
values. Its JSON Patch atomically tests UID, resourceVersion, app name at the
resolved index and prior image before replacing only that image. A recreate,
concurrent update or container reorder cannot be silently overwritten. Rollout,
image readback and pod imageID/ready reporting remain required. No Secret payload
is read.

Nine fake-CLI tests passed through `just test-deploy-exact`, covering successful
nonzero container index, read-time UID/version/image mismatches, missing/duplicate
app and patch-time UID/version/image races. Shell syntax and whitespace checks
pass. These are delivery-adapter tests, not cluster or rollout acceptance.

Use the reviewed adapter from the qualified application's clean checkout:

```text
bash /absolute/reviewed-adapter/scripts/deploy-exact.sh \
  FULL_QUALIFIED_APP_SHA sha256:IMAGE_DIGEST \
  EXPECTED_DEPLOYMENT_UID EXPECTED_PRIOR_APP_IMAGE EXPECTED_RESOURCE_VERSION
```

Record both the immutable application SHA/image digest and delivery-adapter SHA.
Do not rebuild the application merely to include delivery tooling. Do not execute
the adapter from its own checkout when its HEAD differs from the qualified app.
The tracked Just entrypoint exposes the same five inputs when helper and app
source are intentionally together.

Publisher reconnaissance found the repo's existing Container workflow uses
Buildx and GITHUB_TOKEN custody for GHCR. There is no repo local-publish recipe.
On the macOS operator host Docker/Podman/Skopeo CLIs exist, but Docker has no
reachable daemon, Podman has no configured connection, and Docker config
metadata lists no auth hosts or credential helpers. This does not establish a
working direct-publish path; no credential values, login, daemon start, push,
cluster patch or provider request was performed.

Sting metadata-only checks confirm Podman 5.8.6, rootless Linux amd64, and
Buildah 1.43.2. No stored GHCR login or auth file in its standard/environment
custody locations was found. Direct building is available there; direct push
authority remains unestablished. Do not substitute the macOS daemon result for
estate-wide capability.

Live GitHub repo variable PRIMARY_LINUX_RUNNER_LABELS_JSON is ["ubuntu-latest"].
The existing Container job therefore uses an ordinary hosted Buildx runner,
not ARC/GF, with packages:write GITHUB_TOKEN login/publish custody. This is a
possible root-reviewed publisher fallback without new credentials. Its
Containerfile executes pnpm run build, so it rebuilds rather than merely
assembling a prebuilt qualified bundle. Root must bind the exact source ref,
OCI revision and resulting digest and review artifact acceptance separately.
No workflow was dispatched during reconnaissance.
