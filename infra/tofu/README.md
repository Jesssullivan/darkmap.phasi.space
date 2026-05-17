# infra/tofu

OpenTofu stack for `darkmap.tinyland.dev`. Manages:

- Kubernetes `Namespace/darkmap`
- Kubernetes `Secret/darkmap-upstream` holding `QUERY_RASTER_KEY`

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

## Local workflow

From the repo root (`direnv allow` first to load the Nix shell):

```bash
export TF_VAR_query_raster_key='<the-real-key>'
just tofu-init
just tofu-plan          # non-empty diff expected on first run
just tofu-apply         # type yes
```

## Why not the whole site in Tofu?

Operationally, Kustomize-driven Deployment/Ingress lifecycle is
faster to iterate (no providers, no state lock contention) for
container-image rollouts. Tofu owns the slowly-changing primitives
(namespace, secret); Kustomize owns the workload.
