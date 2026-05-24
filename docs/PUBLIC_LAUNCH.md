# Public Launch Runbook

This document tracks the public-repo and public-service launch state for
`darkmap.phasi.space`.
It is intentionally public-safe: no secret values, private key material, or
operator credential paths belong here.

## Current State

Last refreshed: 2026-05-24.

- Canonical hostname: `darkmap.phasi.space`
- GitHub repo: <https://github.com/Jesssullivan/darkmap.phasi.space>
- Launch tracker: [darkmap #97](https://github.com/Jesssullivan/darkmap.phasi.space/issues/97)
- Cloudflare Tunnel route is configured for `darkmap.phasi.space`
- Cloudflare DNS has `darkmap.phasi.space` as a proxied CNAME to the
  `honey-ingress` tunnel
- Blahaj source-truth follow-up for the live tunnel route is tracked in
  [tinyland-inc/blahaj#714](https://github.com/tinyland-inc/blahaj/issues/714)
- Legacy `darkmap.tinyland.dev` remains a tailnet ingress path
- Public recursive DNS currently resolves `darkmap.phasi.space` to Cloudflare
  edge A records, but registrar authority may still show DreamHost
  nameservers until delegation converges
- cert-manager issued a valid `darkmap.phasi.space` certificate
- Cloudflare zone exists for `phasi.space` and is visible to the SOPS-backed
  Cloudflare token
- authority cleanup remains: registrar delegation still needs to converge to
  the intended Cloudflare nameservers

For the Cloudflare zone used by this repo, expected registrar nameservers are:

```text
izabella.ns.cloudflare.com
sullivan.ns.cloudflare.com
```

## DNS Gate

First verify the public DNS record:

```bash
dig +short CNAME darkmap.phasi.space @1.1.1.1
dig +short A darkmap.phasi.space @1.1.1.1
```

Target steady state:

```text
Cloudflare edge A/AAAA answers; no 100.64.0.0/10 address
```

Older or stale recursive paths may still return:

```text
darkmap.tinyland.dev.
100.125.97.64
```

Then audit authority:

```bash
dig +short NS phasi.space @a.nic.space
dig +short NS phasi.space @1.1.1.1
```

Current transition state may still show DreamHost nameservers. Delegated steady
state should show:

```text
izabella.ns.cloudflare.com.
sullivan.ns.cloudflare.com.
```

## TLS Gate

Cloudflare serves the public edge certificate for `darkmap.phasi.space` once
recursive DNS reaches the proxied record. The legacy ingress also includes both
`darkmap.phasi.space` and `darkmap.tinyland.dev`; cert-manager issues that
certificate through DNS-01. The live cluster issuer was patched during launch to
allow `phasi.space`; the source follow-up is tracked in
[tinyland-inc/blahaj#713](https://github.com/tinyland-inc/blahaj/issues/713).

Check certificate state from a cluster-capable operator environment:

```bash
kubectl -n darkmap get certificate,order,challenge
kubectl -n darkmap describe certificate darkmap-tls
```

Expected state:

```text
certificate.cert-manager.io/darkmap-tls   True
```

Then verify HTTPS:

```bash
curl -sI https://darkmap.phasi.space/
```

Expected:

```text
HTTP/2 200
server: cloudflare
```

If recursive DNS still returns the tailnet path, a successful response without
`server: cloudflare` proves only the legacy tailnet ingress path.

## Public-Readiness Gate

Run from the repository root:

```bash
gitleaks detect --source . --redact --verbose
gitleaks dir . --redact --verbose
just tofu-validate
BAZEL_STARTUP_ARGS=--output_user_root=/tmp/darkmap-bazel \
  BAZEL_ARGS=--disk_cache=/tmp/darkmap-bazel-cache \
  just check
BAZEL_STARTUP_ARGS=--output_user_root=/tmp/darkmap-bazel \
  BAZEL_ARGS=--disk_cache=/tmp/darkmap-bazel-cache \
  just smoke-local
```

Expected:

- no committed or working-tree secrets
- OpenTofu validation passes
- lint, typecheck, and Bazel unit tests pass
- local smoke serves `/` and `/api/raster`
- build and served HTML remain free of `ad_prebid`
- raster headers do not include cookies or ad-tech headers

## CI/CD Gate

Public edge smoke is automated by `.github/workflows/public-smoke.yml` on
`main`, on a six-hour schedule, and manually.

OpenTofu/RustFS and Kustomize deploy jobs must run on a repository-visible
cluster-capable runner. The Tofu plan/apply, staging deploy, and GitOps drift
workflows run `scripts/ci-tofu-route-preflight.mjs` first. If
`TOFU_LINUX_RUNNER_LABELS_JSON` points at labels that are not available to this
repo, the workflow writes a public-safe GitHub summary and skips the
cluster-mutating job instead of queuing indefinitely or falling back to hosted
runners.

The remaining CI/CD closeout is tracked in
[#110](https://github.com/Jesssullivan/darkmap.phasi.space/issues/110):

- bind a repository-visible runner that can reach RustFS and the cluster API
- prove `tofu plan -detailed-exitcode` against the RustFS backend
- prove `kubectl diff` / deploy against the checked-in Kustomize overlay
- keep public smoke separate from cluster/state proofs

## Tracker Gate

GitHub issues are the public tracker for repo-local work. Linear may remain the
Tinyland-wide planning system, but active work should not exist only in Linear
after public launch.

Public launch and follow-up issues:

- DNS and edge cutover: [#97](https://github.com/Jesssullivan/darkmap.phasi.space/issues/97)
- Mobile field UX: [#98](https://github.com/Jesssullivan/darkmap.phasi.space/issues/98)
- PII/topology/secrets scrub: [#99](https://github.com/Jesssullivan/darkmap.phasi.space/issues/99)
- Offline caching / PWA: [#100](https://github.com/Jesssullivan/darkmap.phasi.space/issues/100)
- ci-templates lane-env cutover: [#101](https://github.com/Jesssullivan/darkmap.phasi.space/issues/101)
- Compass/orientation: [#102](https://github.com/Jesssullivan/darkmap.phasi.space/issues/102)
- Self-hosted tiles: [#103](https://github.com/Jesssullivan/darkmap.phasi.space/issues/103)
- KML/GPX/GeoJSON import: [#104](https://github.com/Jesssullivan/darkmap.phasi.space/issues/104)
- Remote verification: [#105](https://github.com/Jesssullivan/darkmap.phasi.space/issues/105)
- Ingress 404 behavior: [#106](https://github.com/Jesssullivan/darkmap.phasi.space/issues/106)
- Authority matrix: [#107](https://github.com/Jesssullivan/darkmap.phasi.space/issues/107)
- Route smoke: [#108](https://github.com/Jesssullivan/darkmap.phasi.space/issues/108)
- Stale Linear cleanup: [#109](https://github.com/Jesssullivan/darkmap.phasi.space/issues/109)
- Tofu / RustFS / GitOps CI/CD proof: [#110](https://github.com/Jesssullivan/darkmap.phasi.space/issues/110)
