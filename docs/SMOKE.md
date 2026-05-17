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
