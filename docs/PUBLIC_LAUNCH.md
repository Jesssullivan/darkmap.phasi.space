# Public Launch Runbook

This document tracks the public-repo and public-service launch state for
`darkmap.phasi.space`.
It is intentionally public-safe: no secret values, private key material, or
operator credential paths belong here.

## Current State

Last refreshed: 2026-05-27.

- Canonical hostname: `darkmap.phasi.space`
- GitHub repo: <https://github.com/Jesssullivan/darkmap.phasi.space>
- Launch tracker: [darkmap #97](https://github.com/Jesssullivan/darkmap.phasi.space/issues/97)
- Cloudflare Tunnel route is configured for `darkmap.phasi.space`
- Cloudflare DNS has `darkmap.phasi.space` as a proxied CNAME to the
  `honey-ingress` tunnel
- `infra/tofu` now has a default-off `public_dns_enabled` adoption gate for
  managing that existing record once the `phasi.space` zone id is supplied
- Blahaj source-truth follow-up for the live tunnel route is tracked in
  [tinyland-inc/blahaj#714](https://github.com/tinyland-inc/blahaj/issues/714)
- Legacy `darkmap.tinyland.dev` remains a tailnet ingress path
- Public recursive DNS resolves `darkmap.phasi.space` to Cloudflare edge A/AAAA
  records
- `phasi.space` registrar authority delegates to Cloudflare
- cert-manager issued a valid `darkmap.phasi.space` certificate
- Cloudflare zone exists for `phasi.space` and is visible to the SOPS-backed
  Cloudflare token

For the Cloudflare zone used by this repo, expected registrar nameservers are:

```text
austin.ns.cloudflare.com
oaklyn.ns.cloudflare.com
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

Then audit authority:

```bash
dig +short NS phasi.space @a.nic.space
dig +short NS phasi.space @1.1.1.1
```

Delegated steady state should show:

```text
austin.ns.cloudflare.com.
oaklyn.ns.cloudflare.com.
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

If a future resolver returns a non-Cloudflare path, a successful response
without `server: cloudflare` proves only that alternate ingress path.

## Public-Readiness Gate

Latest local audit summary:
[`PUBLIC_READINESS_AUDIT.md`](./PUBLIC_READINESS_AUDIT.md).

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

## Public-Safety Notes

The repo intentionally retains a small amount of deployment topology:

- runner labels and workflow routing, so CI/CD failures can be audited publicly
- Kubernetes namespace/context names, so manifests and smoke docs stay
  actionable
- S3-compatible state backend hostnames, because the endpoint is not a
  credential and the actual access keys live only in secret stores
- the legacy `darkmap.tinyland.dev` path, because Tofu and Kustomize still
  preserve it separately from the public `darkmap.phasi.space` edge

Do not add local filesystem paths, plaintext token values, kubeconfig contents,
or operator-only credential runbooks to public docs.

## CI/CD Gate

Public edge smoke is automated by `.github/workflows/public-smoke.yml` on
`main`, on a six-hour schedule, and manually.

OpenTofu/RustFS and Kustomize deploy jobs must run on a cluster-capable runner.
The Tofu plan/apply, staging deploy, and GitOps drift workflows run
`scripts/ci-tofu-route-preflight.mjs` first. Main-branch apply/deploy/drift may
dispatch the configured self-hosted ARC route even when GitHub's workflow token
cannot list repository runners or the ARC scale set is at zero warm runners.
The guard still refuses to fall back to hosted runners for stateful work.

Cluster jobs call `scripts/ci-normalize-kubeconfig.sh` so ARC runner pods use
the in-cluster Kubernetes API endpoint instead of a workstation or tailnet API
server address from the secret.

The CI/CD closeout is complete in
[#110](https://github.com/Jesssullivan/darkmap.phasi.space/issues/110). Keep
public smoke separate from cluster/state proofs:

- public smoke proves the Cloudflare edge and raster endpoint
- Tofu apply proves RustFS state/backend access from the approved runner class
- staging deploy proves Kustomize apply and rollout
- GitOps drift proves Tofu state and live Kustomize shape agree

OpenTofu state remains on the interim RustFS-backed path until the HA state
migration tracked in
[#139](https://github.com/Jesssullivan/darkmap.phasi.space/issues/139) is
complete. State failure evidence and the repo/platform recovery boundary are
documented in [`TOFU_STATE_GUARDRAILS.md`](./TOFU_STATE_GUARDRAILS.md).
The next endpoint-package contract is documented in
[`HA_OPENTOFU_STATE_ENDPOINT.md`](./HA_OPENTOFU_STATE_ENDPOINT.md).
The public live-candidate status remains
`NO_LIVE_HA_STATE_CANDIDATE` and is intentionally validated with
`just tofu-state-ha-readiness --expect-interim` until #141/TIN-1026 supplies a
filled non-secret endpoint package. Final HA readiness requires
`just tofu-state-ha-readiness` to pass without `--expect-interim`.
The scratch S3 proof runbook is documented in
[`HA_OPENTOFU_STATE_SCRATCH_PROOF.md`](./HA_OPENTOFU_STATE_SCRATCH_PROOF.md).
The disposable OpenTofu proof runbook is documented in
[`HA_OPENTOFU_STATE_DISPOSABLE_TOFU_PROOF.md`](./HA_OPENTOFU_STATE_DISPOSABLE_TOFU_PROOF.md).
Credential boundary and proof closeout evidence must pass
`just ha-state-proof-evidence-check` before public tracker closeout.
The protected migration runbook is documented in
[`HA_OPENTOFU_STATE_MIGRATION.md`](./HA_OPENTOFU_STATE_MIGRATION.md).

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
- Mobile twilight rail: [#121](https://github.com/Jesssullivan/darkmap.phasi.space/issues/121)
- Public-readiness follow-up: [#122](https://github.com/Jesssullivan/darkmap.phasi.space/issues/122)
- Mobile regression suite: [#123](https://github.com/Jesssullivan/darkmap.phasi.space/issues/123)
- GPS follow mode: [#124](https://github.com/Jesssullivan/darkmap.phasi.space/issues/124)
- Mobile point readout sheet: [#125](https://github.com/Jesssullivan/darkmap.phasi.space/issues/125)
- HA OpenTofu state migration: [#139](https://github.com/Jesssullivan/darkmap.phasi.space/issues/139)
- Interim Tofu state guardrails: [#140](https://github.com/Jesssullivan/darkmap.phasi.space/issues/140)
- HA state endpoint package: [#141](https://github.com/Jesssullivan/darkmap.phasi.space/issues/141)
- HA state scratch proof: [#142](https://github.com/Jesssullivan/darkmap.phasi.space/issues/142)
- HA state scaffold/runbook cleanup: [#143](https://github.com/Jesssullivan/darkmap.phasi.space/issues/143)
- HA state disposable OpenTofu proof: [#144](https://github.com/Jesssullivan/darkmap.phasi.space/issues/144)
- Darkmap HA state migration: [#145](https://github.com/Jesssullivan/darkmap.phasi.space/issues/145)
