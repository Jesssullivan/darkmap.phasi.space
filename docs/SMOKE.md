# End-to-end smoke runbook — darkmap.tinyland.dev

The week-1 launch acceptance gate. Two passes:

1. **Local smoke** (`just smoke-local`) — anyone with the repo cloned, no cluster access. Validates the proxy infrastructure, ad-strip behavior, and bundle hygiene.
2. **Tailnet smoke** — from a tailnet-joined workstation with `KUBE_CONFIG_HONEY` access. Validates the deployed shape end-to-end.

## 1. Local smoke (offline)

Quoting current results so future runs have a fixed reference:

```bash
just smoke-local
```

The recipe:

- `just check` — prettier clean, svelte-check 0/0 across 5039 files, 13/13 unit tests.
- `just build` — `adapter-node ✔`, emits `build/index.js`.
- `rg ad_prebid build/` — **no matches**.
- Starts `node build/index.js` with `QUERY_RASTER_KEY=PLACEHOLDER_TEST` on `:3055`, then:
  - `HEAD /` → `200 OK`, `Content-Type: text/html`.
  - `HEAD /api/raster?layer=viirs_2021&qt=tile&qd=8/74/96` → 2xx, response headers contain **no** `Set-Cookie`, **no** `*prebid*`, **no** `*googletag*`.
  - `curl /` body — `grep -c ad_prebid` returns `0`.

## 2. Tailnet smoke (cluster-side)

Prerequisites:

- Joined to the Tinyland tailnet (`tailscale status` shows `100.x.y.z`).
- `kubectl` context `honey` reachable.
- A real `QUERY_RASTER_KEY` in your shell.
- The Container workflow has produced an SHA-tagged image at `ghcr.io/jesssullivan/darkmap.tinyland.dev:<sha>`.

### 2a. One-time provisioning

The first time the workload lands on `honey`, two pieces need to be in place.

**`ghcr-registry` secret in the `darkmap` namespace** — `ghcr.io/jesssullivan/darkmap.tinyland.dev` is a private package and the kubelet needs a `dockerconfigjson` to pull. Same pattern as sibling sites (`elders`, `financebro`, `account-controller-system`). Easiest is to copy from a sibling that already has it:

```bash
kubectl --context honey get secret ghcr-registry -n elders -o json \
  | jq 'del(.metadata.namespace, .metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .metadata.ownerReferences) | .metadata.namespace = "darkmap"' \
  | kubectl --context honey apply -f -
```

Or mint a fresh PAT with `read:packages` and create the secret via [`kubectl create secret docker-registry`](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/). Read the PAT into an env var first (`read -rs GHCR_TOKEN; export GHCR_TOKEN`) so the token doesn't land in shell history, then pass it as the docker auth field for the new secret with `--namespace darkmap --docker-server=ghcr.io --docker-username=Jesssullivan`. `unset GHCR_TOKEN` when done.

**Rustfs port-forward for `tofu init`.** The state backend lives at `http://attic-rustfs-hl.nix-cache.svc:9000` — a cluster-internal address with no tailnet hostname. Open a port-forward in a separate shell and override the endpoint for the Tofu session:

```bash
# shell A — leave running:
kubectl --context honey -n nix-cache port-forward svc/attic-rustfs-hl 9000:9000

# shell B — your apply session:
# Decrypt the rustfs creds from the blahaj SOPS vault and export them as
# the standard S3 env-var pair the AWS SDK reads at startup. The keys
# live under `default.rustfs_access_key` / `default.rustfs_secret_key`.
sops -d /Users/jess/git/blahaj/secrets/opentofu-backend.enc.yaml
# Then `export` the two S3 env vars manually (or pipe through yq/jq).
export AWS_ENDPOINT_URL_S3=http://localhost:9000
```

Because `backend.hcl` hardcodes the in-cluster endpoint, you also need to override it for local invocations. Create a `backend.local.hcl` (gitignored) or pass `-backend-config="endpoint=http://localhost:9000"` to `tofu init`.

### Known-working invocation (2026-05-17, verified)

```bash
cd infra/tofu
# Create a transient local backend override (do NOT commit):
cat > backend.local.hcl <<EOF
bucket                      = "tofu-state"
key                         = "darkmap-tinyland-dev/terraform.tfstate"
region                      = "us-east-1"
endpoint                    = "http://localhost:9000"
use_path_style              = true
skip_credentials_validation = true
skip_region_validation      = true
skip_metadata_api_check     = true
skip_requesting_account_id  = true
skip_s3_checksum            = true
EOF
nix develop ../.. -c tofu init -backend-config=backend.local.hcl
nix develop ../.. -c tofu plan
rm backend.local.hcl  # never commit this file
```

The state file lands at `s3://tofu-state/darkmap-tinyland-dev/terraform.tfstate`.

### 2b. Apply

Steps:

```bash
# 0. RBE warm + bazel module graph proof
nix develop --command bazelisk --config=flywheel build //:node_modules
nix develop --command bazelisk mod graph                    # resolves the 4 tummycrypt_* modules

# 1. Tofu — namespace + upstream secret
export TF_VAR_query_raster_key='<the-real-key>'
just tofu-init
just tofu-plan                                              # non-empty diff first time
just tofu-apply

# 2. Kustomize — workload
cd infra/kustomize/honey/darkmap
kustomize edit set image darkmap=ghcr.io/jesssullivan/darkmap.tinyland.dev:<sha>
just kustomize-validate-server                              # server-side admission OK
just kustomize-apply
kubectl -n darkmap rollout status deployment/darkmap --timeout=180s

# 3. Tailnet reachability + content
curl -sI https://darkmap.tinyland.dev/ | head -5            # 200 OK
curl -s https://darkmap.tinyland.dev/ | rg -c ad_prebid     # 0
curl -sI 'https://darkmap.tinyland.dev/api/raster?layer=viirs_2021&qt=tile&qd=8/74/96' | rg -i 'set-cookie|prebid|googletag'  # exit 1 (no matches)

# 4. Visual smoke — open in a browser on the tailnet
open https://darkmap.tinyland.dev/
# DevTools Network: verify
#   - tiles render
#   - zero requests to *.prebid.* / *.googletagmanager.* / *.lightpollutionmap.info
#   - each layer toggle => 200 from /api/raster

# 5. Off-tailnet rejection
# From a non-tailnet network (cellular hotspot, public WiFi):
curl -sI https://darkmap.tinyland.dev/                       # connection refused OR 403
```

## 3. PM cross-link sanity

- Linear project: https://linear.app/tinyland/project/darkmaptinylanddev-week-1-launch-0571e880990b — 8 issues, each with a GH attachment.
- GH issues: https://github.com/Jesssullivan/darkmap.tinyland.dev/issues — 1 through 8, each links to its Linear ticket.

## Acceptance summary

| Gate | Result |
|---|---|
| 1. `just check` | ✅ |
| 2. `bazelisk mod graph` | ✅ (offline-reproducible) |
| 3. `just tofu-plan` | Operator (requires tailnet) |
| 4. `just deploy` | Operator (requires tailnet) |
| 5. MapLibre canvas renders | Operator (visual) |
| 5. No Prebid/googletag requests | ✅ partially (build artifact clean); operator confirms runtime |
| 5. Each layer hits /api/raster | ✅ wiring proven via local smoke |
| 5. `rg ad_prebid build/` | ✅ |
| 6. Linear ↔ GH cross-links | ✅ |
| 7. Off-tailnet rejection | Operator |
