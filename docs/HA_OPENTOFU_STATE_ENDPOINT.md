# HA OpenTofu State Endpoint Package

This document is the public, non-secret handoff for
[darkmap #141](https://github.com/Jesssullivan/darkmap.phasi.space/issues/141).
It defines what must exist before #142 or #144 can run proof commands against a
candidate backend.

## Status

Current status: endpoint package contract ready, live package pending. The
checked-in public status artifact is
[`docs/contracts/ha-opentofu-state-live-candidate-status.json`](./contracts/ha-opentofu-state-live-candidate-status.json)
and currently records `NO_LIVE_HA_STATE_CANDIDATE`.

The selected candidate class is a managed or appliance HA S3-compatible state
service, recorded in
[`docs/contracts/ha-opentofu-state-managed-s3-candidate.json`](./contracts/ha-opentofu-state-managed-s3-candidate.json).
The editable package shape is
[`docs/contracts/ha-opentofu-state-endpoint-package.template.json`](./contracts/ha-opentofu-state-endpoint-package.template.json).

Do not treat the existing RustFS singleton as satisfying this contract. RustFS
remains guarded interim state until the HA package, proof credentials, scratch
proof, disposable OpenTofu proof, and protected migration are complete.

Validate the current interim status explicitly:

```bash
just tofu-state-ha-readiness --expect-interim
```

For final #141 readiness, the same command must pass without
`--expect-interim` after the status artifact points at a filled non-secret
endpoint package:

```bash
just tofu-state-ha-readiness --status docs/contracts/ha-opentofu-state-live-candidate-status.json \
  --endpoint-package endpoint-package.json
```

## Endpoint Package Requirements

The endpoint package is non-secret JSON. It may name endpoint coordinates,
audience, owners, scratch bucket, policies, observability, and proof commands.
It must not contain credential values, kubeconfig contents, local operator
paths, or private recovery commands.

Required package facts:

- HTTPS S3-compatible endpoint URL and region.
- Network audience for the proof runner or operator.
- State-only credential source, rotation owner, and restore owner.
- Credential injection names:
  `TOFU_HA_STATE_ENDPOINT`, `TOFU_HA_STATE_REGION`,
  `TOFU_HA_STATE_ACCESS_KEY`, and `TOFU_HA_STATE_SECRET_KEY`.
- Scratch bucket that is not `tofu-state` and is not a protected stack key.
- Scratch policy allowing create, list, read, write, and delete only for that
  scratch bucket.
- Explicit protected-state denials for the active darkmap key and the final
  darkmap spoke key.
- Versioning or equivalent object-generation history plus retained backup or
  restore behavior.
- OpenTofu S3 `use_lockfile` proof before protected state migration.
- Managed maintenance, quorum, two-endpoint, or equivalent failure-domain proof.
- Signals for failed auth, failed write, replication lag, and delete behavior.
- Authority separation from Attic cache, Bazel cache, BCR/Bzlmod mirrors, and
  RBE CAS/action-cache.

## Credential Boundary

Proof credentials must come from the private secret authority and be injected
only at proof runtime. Public artifacts can name the `TOFU_HA_STATE_*`
variables, but must not publish secret names, values, encrypted payloads, or
secret-store paths.

The first proof credentials are scratch-only. They must not read, write, list,
or delete:

- active `tofu-state` data
- `tofu-state/darkmap-tinyland-dev/terraform.tfstate`
- `spokes/darkmap/terraform.tfstate`
- unrelated Tinyland infrastructure state keys
- Attic, Bazel, BCR/Bzlmod, RBE CAS, or action-cache buckets

## Credential Boundary Check

Before running the mutating scratch proof, run the non-mutating credential
boundary check:

```bash
just ha-state-credential-boundary-check endpoint-package.json \
  --checkpoint-file credential-boundary.json
```

The check validates that the proof credentials can list and head the scratch
bucket, that bucket listing does not expose `tofu-state`, and that HEAD requests
against the active/final darkmap state bucket and keys return only `403` or
`404`. It does not write to protected state paths.

Validate the public-safe checkpoint before posting #141 evidence:

```bash
just ha-state-proof-evidence-check endpoint-package.json \
  --credential-boundary credential-boundary.json
```

## Operator Sequence

1. Copy the endpoint package template outside this repo or into an approved
   public-safe package path.
2. Replace every `replace-me` and `example.invalid` value with real non-secret
   endpoint, policy, owner, recovery, maintenance, and observability facts.
3. Inject proof credentials through the private secret authority.
4. Validate the filled package:

   ```bash
   just ha-state-endpoint-package-check <endpoint-package.json>
   ```

5. Run `just ha-state-credential-boundary-check` and attach a public-safe
   summary of the checkpoint to #141.
6. Run the scratch S3 proof for #142 using
   [`docs/HA_OPENTOFU_STATE_SCRATCH_PROOF.md`](./HA_OPENTOFU_STATE_SCRATCH_PROOF.md).
7. Run the disposable OpenTofu proof for #144 using
   [`docs/HA_OPENTOFU_STATE_DISPOSABLE_TOFU_PROOF.md`](./HA_OPENTOFU_STATE_DISPOSABLE_TOFU_PROOF.md).
8. Validate the public-safe proof checkpoint bundle with
   `just ha-state-proof-evidence-check`.
9. Keep the protected migration in #145 blocked until both proof phases pass
   and evidence is recorded, then use
   [`docs/HA_OPENTOFU_STATE_MIGRATION.md`](./HA_OPENTOFU_STATE_MIGRATION.md).

## Completion Criteria For #141

#141 should remain open until the public tracker can link to a filled non-secret
endpoint package and private operators confirm scoped proof credentials exist.
The filled package can stay outside this public repo if publishing endpoint
coordinates would create operational risk, but the public issue must record the
non-secret contract facts, credential boundary result, and verification result.
