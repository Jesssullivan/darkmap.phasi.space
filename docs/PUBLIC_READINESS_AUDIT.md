# Public Readiness Audit

Last refreshed: 2026-05-27.

This is the public-safe audit note for preparing `darkmap.phasi.space` as a
public repository and public service. It records what was checked, what remains
intentionally visible, and which gates still require operator action.

## Scope

- Repository: `Jesssullivan/darkmap.phasi.space`
- Public hostname: `darkmap.phasi.space`
- Legacy hostname: `darkmap.tinyland.dev`
- Operator secret authority: external SOPS store under `../lab` and GitHub
  Actions secrets, not this repository

## Checks Run

```bash
just format-check
just typecheck
just test-local
just build
nix develop --command just lanes-validate
nix develop --command just tofu-validate
nix develop --command just repo-manifest-validate
nix develop --command just bazel-graph
nix develop --command gitleaks detect --source . --redact --verbose
nix develop --command just conformance
git diff --check
```

Latest known results:

- formatting: pass
- typecheck: pass, 0 errors / 0 warnings
- unit tests: pass, 186 tests
- production build: pass
- lanes schema: pass
- OpenTofu validation: pass
- repo manifest schema: pass
- Bazel module graph: pass
- gitleaks history scan: pass, no leaks found across 142 commits
- conformance: 8 pass, 0 fail, 4 manual
- whitespace check: pass

## Secret Boundary

No plaintext credentials, `.env` files, kubeconfigs, Cloudflare API tokens,
RustFS access keys, or private keys should be committed here.

Operator-only material remains outside this repo:

- SOPS-backed secrets and schemas under `../lab`
- GitHub Actions repository/environment secrets
- live Kubernetes Secret values
- local kubeconfig paths and workstation-specific credential material

This repo may document secret names and trust boundaries when necessary for
operators, but it should not contain secret values or operator-only recovery
runbooks.

## Intentional Public Topology

The following topology is intentionally public because it is needed to audit
CI/CD, deployment shape, and public-service routing:

- GitHub workflow names and runner-routing gates
- Kubernetes namespace/resource names
- public hostnames
- legacy `darkmap.tinyland.dev` ingress/DNS/state references
- S3-compatible state backend hostname, without credentials
- Cloudflare Tunnel CNAME target for the retained `honey-ingress` route

The `darkmap.tinyland.dev` references that remain after cleanup are legacy
runtime or historical notes. Repo identity and public-facing package/build
metadata now use `darkmap.phasi.space`.

## Operator-Gated Items

- `infra/tofu` has a default-off `public_dns_enabled` adoption gate for the
  existing `darkmap.phasi.space` Cloudflare DNS record.
- Do not flip `public_dns_enabled` until an operator supplies
  `phasi_cloudflare_zone_id` and is ready for Tofu to adopt the existing DNS
  record.
- Conformance manual items remain for the ci-templates wrapper cutover,
  repository ruleset/status-check configuration, and lane DNS reachability.

## Tracker

Public tracker issue:
[#122](https://github.com/Jesssullivan/darkmap.phasi.space/issues/122).

Related launch and follow-up issues are listed in
[`PUBLIC_LAUNCH.md`](./PUBLIC_LAUNCH.md#tracker-gate).
