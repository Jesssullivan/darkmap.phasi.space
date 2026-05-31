# OpenTofu State Guardrails

This runbook is public-safe. It describes what darkmap CI captures while the
OpenTofu state backend still uses the interim RustFS-backed S3 path. Do not add
credential values, kubeconfig contents, local operator paths, or private
endpoint details here.

## Current Posture

RustFS remains an interim state backend only. The durable fix is tracked in
[darkmap #139](https://github.com/Jesssullivan/darkmap.phasi.space/issues/139):
move OpenTofu state to a dedicated HA S3-compatible authority with scoped
state-only credentials, object history or backup/restore proof, locking proof,
and one-stack-at-a-time migration.

The HA endpoint package contract for that next step is documented in
[`HA_OPENTOFU_STATE_ENDPOINT.md`](./HA_OPENTOFU_STATE_ENDPOINT.md).
The current public machine-readable status is
[`contracts/ha-opentofu-state-live-candidate-status.json`](./contracts/ha-opentofu-state-live-candidate-status.json)
and is validated with:

```bash
just tofu-state-ha-readiness --expect-interim
```

That command should pass only with `--expect-interim` while #141/TIN-1026 is
blocked on external endpoint provisioning. Final HA readiness requires
`just tofu-state-ha-readiness` to pass without `--expect-interim`.

The repo guardrails are intentionally narrower than that platform work. They
make failures visible early, preserve evidence, and keep retries bounded. They
do not repair RustFS, promote RustFS to HA, or hide persistent backend failure.

## What CI Proves

`Tofu apply` and `GitOps drift` both initialize the backend through
`scripts/ci-tofu-init-retry.sh`, then run `scripts/ci-tofu-state-check.sh`
before planning or checking drift. Production apply also uses
`scripts/ci-tofu-apply-retry.sh` to reinitialize once if OpenTofu reopens state
after a successful plan and hits the same S3 bucket-index symptoms.

`GitOps drift` is the recurring public proof. A green run means the approved
runner route could initialize OpenTofu, list the remote state, run a drift plan,
and compare the checked-in Kustomize overlay against live cluster shape.

## Failure Signals

Treat these as platform-state signals, not app regressions:

- `NoSuchBucket`
- `ListObjectsV2`
- `S3 bucket does not exist`
- `error loading state`
- `Failed to get existing workspaces`
- repeated OpenTofu init retry exhaustion

The wrappers retry only within their configured attempt limits. If those limits
are exhausted, capture evidence before attempting any platform recovery.

## Evidence To Capture

Before any recovery action, capture the GitHub Actions run URL and the uploaded
artifact logs when present:

- `tofu-init.log`
- `tofu-state-list.log`
- `tofu-apply.log`
- `tofu-apply-reinit.log`
- `tofu-drift.txt`
- `kustomize-drift.txt`

For the public tracker, summarize only the failure class, workflow name, run
URL, commit SHA, and which log contained the signal. Do not paste secrets,
kubeconfig contents, access keys, secret names, or private recovery commands.

## Recovery Boundary

Repo-level guardrails can:

- fail early when backend state is not listable
- preserve enough public-safe evidence to correlate failures
- keep main-branch drift checks as a visible health proof
- prevent infinite retry loops from masking persistent backend breakage

Platform recovery belongs outside this repo:

- RustFS bucket-index repair or replacement
- provisioning the HA state endpoint
- issuing scoped state-only credentials
- proving backup, restore, and locking behavior
- migrating protected OpenTofu state keys

Use [#139](https://github.com/Jesssullivan/darkmap.phasi.space/issues/139) as
the public umbrella for that migration path.
