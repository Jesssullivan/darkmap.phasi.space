# dd28 next release packet — source-only, not admitted

Application dd28a8398699e6b790ab29616ad07a15d52c1a02 is frozen; original
cache owner retains it. Independent source ACK and exact single-target 31/31
receipt are preserved at 5aafb3e. Operator adapter baac0dadbf4cde773ca4eb1dd6b01bc676e36bc5
is distinct; UI owner independently reviewed predecessor4bc79b1, with two
explicit response-evidence assertions added in baac0da. Four local fixtures pass.

Exact reviewed files and SHA256:

- scripts/smoke-real-service-worker.mjs: 2f95074c53f91bb2a7dbef6c803e47bc71f2fbb5cc67abd889f5d813d805ec2b
- scripts/real-sw-fixtures.mjs: 0af5525ab77cb4a229e2430339a7f1707508c41c5f516e02fa4b2dfe41318cd6
- scripts/deploy-exact.sh: d75508066aa80d8a08ee3b66254f9c32d556ed9707a64f2d75125eb4b396b86f

## Admission and local image proof

No launch authorized by this packet. Original resource producer
plan_deploy_recipes_sol61 must provide actual tinyland-heavy wrapper identity
and hash, fresh parent limits (14/18 GiB unchanged), host memory, active overlap
and physical scratch/cache/output path df/statfs/quota receipts. Use lowering
child MemoryHigh=3G MemoryMax=4G CPUWeight=25 only. Existing pinned Node22.22.2,
Just1.50 and Chromium147 paths are in the original owner handoff; do not realize
Nix or substitute drifted profile tools. Account rootless container memory even
if its scope lies outside wrapper (container512MiB; outer browser at most3GiB).
No unrelated JVM/process signals or pool/quota escape.

After root reviews actual wrapper/caps, producer runs explicit immutable image
locally, recording container id, index/amd64 child and source OCI label. Then:

```
just --justfile ADAPTER/Justfile smoke-real-service-worker APP_ROOT http://127.0.0.1:IMAGE_PORT ARTIFACTS dd28a8398699e6b790ab29616ad07a15d52c1a02 sha256:EXACT_INDEX
```

Result real-sw-result.json must pass all checks in the adapter receipt; bind
its hash, actual driver SHA, image index/child and compiled worker hash. This is
isolated controlled-fixture cache plumbing, NOT provider availability/science,
user-visible cache UI or old-worker upgrade proof. Existing7d415 UI recipe can
check the SAME image separately; its blocked-worker mode is not cache proof.

## Existing hosted publication custody (root-only future action)

No new registry credentials. Existing Container workflow uses ordinary hosted
Buildx (current PRIMARY_LINUX_RUNNER_LABELS_JSON=["ubuntu-latest"]), GITHUB_TOKEN
packages:write and GHCR ghcr.io/jesssullivan/darkmap.phasi.space. It rebuilds
Containerfile, so local bundle acceptance does not prove its resulting bytes.
After explicit root publication approval, publish exact frozen app ref (not
operator adapter branch), verify remote ref equals dd28, then dispatch:

```
gh workflow run container.yml --repo Jesssullivan/darkmap.phasi.space --ref candidate/cache-storage-resilience-20261005
```

Branch push is a separate root-approved action; currently not performed. Capture
actual run id/head SHA/runner/output digest, inspect immutable index and amd64
child OCIrevision=dd28, then qualify actual published image using above driver.
Sting Podman/Buildah exist but direct push credential custody is unproven; do
not invent credentials. Hosted publisher does not wait for GF/ARC.

## Forward and inverse guarded deployment (not authorized now)

Retain served ec16b51b5e56ab65efaa4fc10c742573ee2d8056 index
sha256:c5ca6a6907e4bc431835f2b49b2d81587b9cec5e344c309b9c5ab31b81d1d021;
amd64 child sha256:b461f2304b61b64720fdebcf0d7943f8c2ec6fb3ce0c68deaccbcb92c0f117c2.
Retain accepted UI, canonical darkmap.xoxd.ai and both phasi/tinyland routes.
No DNS change, automatic main merge/rollout or blind kubectl set image.

From clean frozen app cwd, absolute adapter deploy-exact.sh takes full appSHA,
new immutable index, expected deploymentUID, exact prior image and freshRV.
Atomic API-server JSON tests enforce UID/RV/namedapp/index/priorimage before
replace. Record both source SHAs, rollout status, actual pod imageID/readiness
and all three served-host checks. Concurrent changes require rereview, not retry
with guessed values. Inverse uses the same guarded script from clean retained
ec16 checkout, ec16 index above, fresh postrollout UID/RV and exact dd28 prior
image; root separately authorizes any inverse. Never reuse staleRV.
