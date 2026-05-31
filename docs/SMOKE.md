# Smoke Runbook

This runbook is intentionally public-safe. It validates the repo, the public
Cloudflare Tunnel edge, and the legacy tailnet ingress without documenting
private cluster addresses, credential paths, or operator-specific secret
material.

## Local Smoke

```bash
just smoke-local
```

The recipe runs the normal repo gate, builds the SvelteKit server bundle, starts
it on localhost, then checks:

- `/` returns `200`
- the built and served HTML do not contain `ad_prebid`
- `/api/raster` response headers do not contain cookies or ad-tech headers

## Deployment Smoke

Run from an environment that already has the approved deployment credentials,
cluster access, and Tinyland tailnet routing configured.

```bash
just tofu-plan
just kustomize-validate-server
just deploy
```

Before treating DNS as fully delegated, verify the public DNS record:

```bash
dig +short CNAME darkmap.phasi.space @1.1.1.1
dig +short A darkmap.phasi.space @1.1.1.1
```

Current acceptable public-edge state:

```text
<Cloudflare edge addresses, no 100.64.0.0/10 address>
```

Audit `dig +short NS phasi.space @a.nic.space` separately from the A/AAAA
answers. The registrar-side Cloudflare nameservers are:

```text
austin.ns.cloudflare.com.
oaklyn.ns.cloudflare.com.
```

Then verify the public edge:

```bash
curl -sI https://darkmap.phasi.space/
curl -s https://darkmap.phasi.space/ | rg -c ad_prebid
curl -sI 'https://darkmap.phasi.space/api/raster?layer=viirs_2019&z=8&x=74&y=96' | rg -i 'set-cookie|prebid|googletag'
```

Expected:

- homepage status is `200`
- `ad_prebid` count is `0`
- the final header scan exits with no matches
- headers include `server: cloudflare`

## Hosted Public Smoke

GitHub Actions runs `.github/workflows/public-smoke.yml` on `main`, on a
six-hour schedule, and manually. It uses only public HTTP checks:

- homepage returns through Cloudflare
- built page does not expose `ad_prebid`
- raster endpoint returns `image/png`
- homepage and raster headers do not expose cookies or ad-tech headers

This workflow proves the public edge only. It does not prove Kubernetes deploy,
OpenTofu state, or RustFS backend reachability.

## Browser RBE Smoke

Browserful regression checks are GloriousFlywheel REAPI proofs, not local
Playwright runs. The current aggregate target is:

```text
//:playwright_browser_rbe_smoke_suite
```

It expands to the narrow browser smoke slices for shell load, mobile layers,
MapLibre canvas readiness, point readout, mobile HUD, and the mobile HUD
viewport matrix. Each slice serves the declared `//:app_build` adapter-node
output inside the Bazel test action and uses the Chromium binary pinned in the
GF worker image.

### PR Proof Workflow

`.github/workflows/browser-rbe-proof.yml` is the repo-local PR status for this
proof path. It dispatches `tinyland-inc/GloriousFlywheel`
`gf-reapi-cell-proof.yml`, waits for the GF run, downloads the uploaded proof
artifact, and verifies the machine-readable `proof-result.json`.

The workflow intentionally does not run Playwright locally. It only orchestrates
and verifies the GF proof.

Operator setup:

- Set repo variable `GF_REAPI_PROOF_ENABLED=true`.
- Set repo secret `GF_REAPI_PROOF_DISPATCH_TOKEN` to a token that can dispatch
  and read Actions runs/artifacts in `tinyland-inc/GloriousFlywheel`.
- Optional: set repo variable `GF_REAPI_CELL_IMAGE_DIGEST` when the proved GF
  browser worker image digest changes. The workflow defaults to the digest
  proved during the darkmap browser-RBE tranche.

Same-repo PRs run automatically after the variable and secret are present.
External fork PRs do not receive the cross-repo dispatch secret; after
maintainer review, run the workflow manually with `workflow_dispatch` against
the reviewed commit SHA.

Branch protection should not require `browser-rbe-proof` until the variable and
secret are configured. Once required, treat a skipped workflow as missing proof
unless the PR is an external fork awaiting a maintainer-triggered dispatch.

Dispatch the suite from `tinyland-inc/GloriousFlywheel`:

```bash
gh workflow run gf-reapi-cell-proof.yml \
  --repo tinyland-inc/GloriousFlywheel \
  --ref main \
  -f image_digest=sha256:a567696e341f6eb0589ece9efd6014a2133a4f10831bdad31e8dd84055eff8a0 \
  -f target=//:playwright_browser_rbe_smoke_suite \
  -f bazel_command=test \
  -f consumer_repository=Jesssullivan/darkmap.phasi.space \
  -f consumer_ref=<commit-or-pr-head-sha> \
  -f consumer_checkout_authority=github-app \
  -f force_execution=true
```

Acceptance for a browser-RBE claim:

- `countable_remote_execution=true`
- `remote_processes > 0`
- proof verifier passes
- worker image digest is recorded
- the proof target is `//:playwright_browser_rbe_smoke_suite` or a named
  narrower `//:playwright_*_smoke` target

Remote-cache hits, GitHub runner placement, deployed-site smoke, and local
Playwright are not browser-RBE evidence.

## CI/CD Route Smoke

Cluster deploy and OpenTofu/RustFS jobs first run
`scripts/ci-tofu-route-preflight.mjs` on a hosted runner. PR `tofu plan` stays
strict unless a runner-read token is configured. Default-branch apply, deploy,
and drift workflows may dispatch the configured self-hosted ARC labels even
when GitHub's workflow token cannot list repository runners or the scale set is
currently at zero warm runners.

The route guard never rewrites `TOFU_LINUX_RUNNER_LABELS_JSON` to
`ubuntu-latest`; hosted runners must not touch RustFS state or apply
Kubernetes manifests.

Use `.github/workflows/gitops-drift.yml` for the scheduled/manual state check.
When the runner route is ready, it runs:

- `tofu plan -detailed-exitcode` against the RustFS-backed state backend
- `kubectl diff` against the checked-in Kustomize overlay

Cluster jobs normalize the checked-in kubeconfig secret to the in-cluster API
endpoint before running OpenTofu or `kubectl`, then fail fast if that API is not
reachable.

When `GitOps drift` fails on OpenTofu state symptoms, capture the run URL and
the uploaded drift evidence before any platform recovery. The public-safe
evidence path and RustFS recovery boundary are in
[`TOFU_STATE_GUARDRAILS.md`](./TOFU_STATE_GUARDRAILS.md).

The next non-RustFS state authority gate is the HA endpoint package documented
in [`HA_OPENTOFU_STATE_ENDPOINT.md`](./HA_OPENTOFU_STATE_ENDPOINT.md).

## Browser Smoke

Open <https://darkmap.phasi.space/> and verify:

- MapLibre canvas renders
- layer toggles load tiles through `/api/raster`
- place search accepts both names and coordinates
- point readout returns a value or a clear upstream error
- DevTools Network shows no Prebid, Google Tag Manager, or ad-tech requests

## Tracker Sanity

Repo-local implementation work should be represented as GitHub issues. Linear
records can remain the Tinyland-wide planning source, but active darkmap tasks
should not exist only in Linear once this repository is public.

See [`PUBLIC_LAUNCH.md`](./PUBLIC_LAUNCH.md) for the current DNS/TLS gates and
the public issue map.
