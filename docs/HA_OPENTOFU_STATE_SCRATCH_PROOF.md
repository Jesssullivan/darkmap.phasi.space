# HA OpenTofu State Scratch Proof

This is the public runbook for
[darkmap #142](https://github.com/Jesssullivan/darkmap.phasi.space/issues/142).
It stays blocked until
[#141](https://github.com/Jesssullivan/darkmap.phasi.space/issues/141) has a
filled non-secret endpoint package and private scratch/proof credentials.

The proof uses the endpoint package from
[`docs/HA_OPENTOFU_STATE_ENDPOINT.md`](./HA_OPENTOFU_STATE_ENDPOINT.md). It never
targets the active `tofu-state` bucket or protected darkmap state keys.

## What The Harness Proves

`just ha-state-candidate-proof` currently runs the #142 scratch S3 phase only.
It performs these operations against the package's `scratch_bucket`:

- list buckets and confirm the scratch bucket is visible
- head the scratch bucket
- put one scratch object under `darkmap-ha-state-proof/<phase>/`
- head the scratch object
- get the scratch object and verify the payload
- delete the scratch object
- head the deleted object and require HTTP 404

The harness writes no credentials to stdout or checkpoint artifacts. Checkpoints
record operation names, public-safe paths, HTTP status codes, phase, package
name, and scratch bucket only.

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

Dry-run a filled package without network calls or credentials:

```bash
just ha-state-candidate-proof \
  --endpoint-package endpoint-package.json \
  --dry-run
```

Run the baseline scratch proof:

```bash
just ha-state-candidate-proof \
  --endpoint-package endpoint-package.json \
  --phase baseline \
  --checkpoint-file scratch-proof-baseline.json
```

Repeat after endpoint restart or managed maintenance:

```bash
just ha-state-candidate-proof \
  --endpoint-package endpoint-package.json \
  --phase post-maintenance \
  --checkpoint-file scratch-proof-post-maintenance.json
```

Repeat after a node or failure-domain event, or the managed equivalent:

```bash
just ha-state-candidate-proof \
  --endpoint-package endpoint-package.json \
  --phase post-failure-domain \
  --checkpoint-file scratch-proof-post-failure-domain.json
```

## Completion Criteria For #142

#142 can close only after the public tracker has a summary for all required
phases:

- baseline scratch proof
- post-restart or post-managed-maintenance scratch proof
- post-node or post-failure-domain scratch proof
- cleanup confirmation that the scratch objects were deleted

Do not publish credential values, private secret-store paths, kubeconfig
contents, or provider-internal recovery commands in GitHub comments or
checkpoint artifacts.
