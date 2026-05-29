# HA OpenTofu State Migration

This is the public runbook for
[darkmap #145](https://github.com/Jesssullivan/darkmap.phasi.space/issues/145).
It stays blocked until the endpoint package and both proof phases are complete:

- [#141](https://github.com/Jesssullivan/darkmap.phasi.space/issues/141):
  filled HA endpoint package and scoped proof credentials
- [#142](https://github.com/Jesssullivan/darkmap.phasi.space/issues/142):
  scratch S3 proof
- [#144](https://github.com/Jesssullivan/darkmap.phasi.space/issues/144):
  disposable OpenTofu proof with S3 lockfile behavior

The migration moves darkmap from the interim key:

`tofu-state/darkmap-tinyland-dev/terraform.tfstate`

to the final protected spoke key:

`tofu-state/spokes/darkmap/terraform.tfstate`

The endpoint must be the HA S3-compatible state authority from the filled
endpoint package, not the current RustFS singleton.

## Guarded Planner

The planner validates a filled non-secret endpoint package, refuses the scratch
proof bucket, requires the final darkmap spoke key, requires `use_lockfile`, and
refuses to overwrite `infra/tofu/backend.hcl` directly.

Offline self-test:

```bash
just ha-state-migration-plan-self-test
```

Render the backend config to a reviewable temp file:

```bash
just ha-state-migration-plan endpoint-package.json \
  --output-backend /tmp/darkmap-ha-backend.hcl \
  --checkpoint-file /tmp/darkmap-ha-migration-plan.json
```

The generated backend config is public-safe endpoint metadata, but operators
should still review it before copying it into `infra/tofu/backend.hcl`.

## Migration Sequence

1. Confirm #141, #142, and #144 have public evidence comments for all required
   phases.
2. Pull a private state snapshot from the current backend:

   ```bash
   cd infra/tofu
   tofu state pull > /tmp/darkmap-state-pre-ha-$(date -u +%Y%m%dT%H%M%SZ).tfstate
   ```

3. Generate and review the HA backend config with
   `just ha-state-migration-plan`.
4. Open a PR that changes only `infra/tofu/backend.hcl` to the reviewed
   generated config.
5. On the approved state runner, inject credentials from the private secret
   authority using the environment names from the endpoint package.
6. Run the backend migration:

   ```bash
   cd infra/tofu
   tofu init -backend-config=/tmp/darkmap-ha-backend.hcl -migrate-state
   ```

7. Run a no-op plan:

   ```bash
   cd infra/tofu
   tofu plan -detailed-exitcode
   ```

   Exit code `0` is the expected clean result. Exit code `2` needs review before
   any apply.

8. Run the repo gates:

   ```bash
   just tofu-plan
   just tofu-apply
   ```

9. Confirm GitOps drift, public smoke, and live health remain green.
10. Add a public tracker comment with the migration commit, run IDs, old key,
    new key, snapshot timestamp, and rollback owner. Do not publish snapshot
    contents or credential details.

## Rollback Shape

Rollback should be a reviewed operator action, not an automatic script:

- keep the private pre-migration state snapshot until the HA backend has passed
  drift and restore checks
- keep the old backend/key coordinates in the tracker comment
- if rollback is required, restore the reviewed snapshot to the interim backend
  and revert `infra/tofu/backend.hcl` in a PR
- rerun Tofu plan/apply, GitOps drift, and public smoke

## Completion Criteria For #145

#145 can close only after:

- `infra/tofu/backend.hcl` points at the HA state endpoint and
  `spokes/darkmap/terraform.tfstate`
- the migration used OpenTofu backend migration rather than ad hoc object copy
- `use_lockfile = true` is in the protected backend config
- darkmap Tofu apply passes on the HA backend
- GitOps drift passes on the HA backend
- public health and smoke checks pass after migration
- rollback evidence exists without exposing secrets or state contents
