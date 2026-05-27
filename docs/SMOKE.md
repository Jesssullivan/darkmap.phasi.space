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
