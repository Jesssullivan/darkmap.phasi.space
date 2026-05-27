# infra/tofu

OpenTofu stack for the darkmap deployment. The public service hostname is
`darkmap.phasi.space`; legacy `darkmap.tinyland.dev` resources may remain until
the infrastructure cutover is completed. The stack manages:

- Kubernetes `Namespace/darkmap`
- optionally, the public Cloudflare DNS record for `darkmap.phasi.space`
- the legacy Cloudflare DNS record for `darkmap.tinyland.dev`

Everything else (`Deployment`, `Service`, `tailscale-svc`, `Ingress`)
lives in `infra/kustomize/honey/darkmap/` and is applied with
`kubectl apply -k`.

## State backend

State lives in the on-prem `rustfs` S3 endpoint:

```
http://attic-rustfs-hl.nix-cache.svc:9000/tofu-state/darkmap-tinyland-dev/terraform.tfstate
```

Reach it from a tailnet-joined host (operator workstation or the
GloriousFlywheel CI runner). Backend config is non-interactive in
`backend.hcl`.

CI jobs do not fall back to hosted runners for this backend. Tofu plan/apply
and GitOps drift workflows first run `scripts/ci-tofu-route-preflight.mjs` on a
hosted runner. PR plans stay strict unless `RUNNER_ROUTE_PREFLIGHT_TOKEN` can
read repository runners. Default-branch apply/drift may dispatch the configured
self-hosted ARC labels even when the workflow token cannot list runners or the
scale set is at zero warm runners.

After backend init, CI runs `scripts/ci-tofu-state-check.sh` to prove the remote
state can be listed before planning. Production apply uses
`scripts/ci-tofu-apply-retry.sh`, which retries once after reinitializing the
backend when OpenTofu hits the observed RustFS/S3 apply-time state reopen error
(`NoSuchBucket` / `ListObjectsV2`) after a successful plan.

Cluster jobs call `scripts/ci-normalize-kubeconfig.sh` after decoding
`KUBE_CONFIG_HONEY`; inside ARC runner pods it rewrites the kubeconfig server to
the in-cluster Kubernetes API endpoint and verifies the context before OpenTofu
uses the Kubernetes provider.

## Local workflow

From the repo root (`direnv allow` first to load the Nix shell):

```bash
just tofu-init
just tofu-plan
just tofu-apply         # type yes
```

## Why not the whole site in Tofu?

Operationally, Kustomize-driven Deployment/Ingress lifecycle is
faster to iterate (no providers, no state lock contention) for
container-image rollouts. Tofu owns the slowly-changing primitives
(namespace, public/legacy DNS, spoke modules); Kustomize owns the workload.

## Public DNS adoption

`darkmap.phasi.space` is already live through the retained Blahaj
`honey-ingress` Cloudflare Tunnel. This stack can adopt that DNS record once an
operator supplies the `phasi.space` zone id and flips the gate:

```hcl
public_dns_enabled       = true
phasi_cloudflare_zone_id = "<phasi.space zone id>"
```

The tunnel CNAME target is public routing metadata, not a secret; the default
matches the Blahaj public-edge intent for `honey-ingress`.
