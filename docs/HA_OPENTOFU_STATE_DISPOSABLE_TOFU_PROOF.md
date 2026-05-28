# HA OpenTofu State Disposable Proof

This is the public runbook for
[darkmap #144](https://github.com/Jesssullivan/darkmap.phasi.space/issues/144).
It stays blocked until
[#141](https://github.com/Jesssullivan/darkmap.phasi.space/issues/141) has a
filled non-secret endpoint package and private proof credentials.

The proof uses the same endpoint package as
[`HA_OPENTOFU_STATE_SCRATCH_PROOF.md`](./HA_OPENTOFU_STATE_SCRATCH_PROOF.md).
It never targets the active `tofu-state` bucket or protected darkmap state
keys.

## What The Harness Proves

`just ha-state-candidate-proof --run-disposable-tofu --use-lockfile` creates a
temporary local OpenTofu stack and points its S3 backend at a disposable key
under:

`darkmap-ha-state-proof/disposable-tofu/<phase>/.../terraform.tfstate`

The harness proves:

- `tofu init` against the candidate backend
- first state write with `tofu apply`
- state readback through `tofu output -json`
- no-op `tofu plan -detailed-exitcode`
- S3 lockfile contention with `use_lockfile = true`
- state object delete and restore, followed by another no-op plan
- cleanup of the disposable state and lock objects

The disposable stack has no cloud resources. Its state contains proof outputs
only.

## Required Runtime Inputs

The filled endpoint package names the required access-key and secret-key
environment variables. Operators should export the exact variable names from
the package's `credential_injection` block without writing values into this
repo.

Optional session credentials use:

`TOFU_HA_STATE_SESSION_TOKEN`

`TOFU_HA_STATE_ENDPOINT` and `TOFU_HA_STATE_REGION` may be set by the private
runtime, but if set they must exactly match the non-secret endpoint package.

## Commands

Offline self-test:

```bash
just ha-state-scratch-proof-self-test
```

Dry-run the disposable proof without network calls, credentials, or OpenTofu:

```bash
just ha-state-candidate-proof \
  --endpoint-package endpoint-package.json \
  --run-disposable-tofu \
  --use-lockfile \
  --dry-run
```

Run the baseline disposable proof:

```bash
just ha-state-candidate-proof \
  --endpoint-package endpoint-package.json \
  --run-disposable-tofu \
  --use-lockfile \
  --phase baseline \
  --checkpoint-file disposable-tofu-baseline.json
```

Repeat after endpoint restart or managed maintenance:

```bash
just ha-state-candidate-proof \
  --endpoint-package endpoint-package.json \
  --run-disposable-tofu \
  --use-lockfile \
  --phase post-maintenance \
  --checkpoint-file disposable-tofu-post-maintenance.json
```

Repeat after a node or failure-domain event, or the managed equivalent:

```bash
just ha-state-candidate-proof \
  --endpoint-package endpoint-package.json \
  --run-disposable-tofu \
  --use-lockfile \
  --phase post-failure-domain \
  --checkpoint-file disposable-tofu-post-failure-domain.json
```

## Completion Criteria For #144

#144 can close only after the public tracker has a summary for all required
phases:

- baseline disposable OpenTofu proof
- post-restart or post-managed-maintenance disposable proof
- post-node or post-failure-domain disposable proof
- restore proof confirmation
- cleanup confirmation that disposable state and lock objects were deleted

Do not publish credential values, private secret-store paths, kubeconfig
contents, or provider-internal recovery commands in GitHub comments or
checkpoint artifacts.
