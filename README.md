# darkmap.tinyland.dev

Ad-free, fast, fully reverse-engineered reimplementation of
[lightpollutionmap.info](https://www.lightpollutionmap.info), served
tailnet-only from the `blahaj` cluster.

Phase 1 (this initiative — week of 2026-05-17): SvelteKit + Effect.ts
reverse-proxy of the upstream `QueryRaster` endpoint with ads, Prebid,
and analytics surfaces stripped. MapLibre GL JS renders VIIRS annual
composites (2017 / 2020 / 2021), the VIIRS multi-year trend, the
Falchi 2015 World Atlas overlay, and the SQM-user layer.

Phase 2+ (deferred): self-host VIIRS / Falchi tiles in rustfs, deck.gl
custom raster overlay, public exposure, user SQM submissions write-path.

## Stack

- **Just** — sole authoritative DX/AX entrypoint (`Justfile`)
- **Nix flake + direnv** — reproducible dev shell
- **Bazel 8 + Bzlmod** — RBE-first via `tinyland-inc/bazel-registry`, GloriousFlywheel cache (`--config=flywheel`)
- **SvelteKit + adapter-static** — static frontend
- **Effect.ts** — service layer (`RasterClient`, `Cache`, `AdStripper` layers)
- **MapLibre GL JS** — interactive map (EPSG:3857)
- **TypeScript** — pinned to `typescript@next` (tracking next-major; churn risk documented in `MODULE.bazel`)
- **OpenTofu + rustfs S3** — IaC with on-prem state backend
- **Kustomize → blahaj RKE2** — deploy target
- **Tailscale operator** — tailnet-only exposure (`honey-sting-tailnet` ProxyClass)

## Quick start

```bash
direnv allow
just setup          # pnpm install --frozen-lockfile
just check          # lint + typecheck + unit
just build          # static SvelteKit build
just dev            # local Vite dev server
```

Bazel smoke (CI proves module graph integrity):

```bash
bazelisk mod graph                                  # local
bazelisk --config=flywheel build //:node_modules    # in-cluster runner
```

## Planning

- Linear project: [darkmap.tinyland.dev — Week 1 launch](https://linear.app/tinyland/project/darkmaptinylanddev-week-1-launch-0571e880990b)
- GitHub issues: [#1–#8](https://github.com/Jesssullivan/darkmap.tinyland.dev/issues)
- Operator contract: [`AGENTS.md`](./AGENTS.md)

## Network exposure

Tailnet-only. nginx ingress with `100.64.0.0/10, 10.0.0.0/8` source
whitelist. Off-tailnet traffic gets 403 / connection refused. There is
no public DNS for this hostname outside the Tailscale magicdns suffix
during Phase 1.

## Attribution

Data © Jurij Stare, [lightpollutionmap.info](https://www.lightpollutionmap.info) —
NASA VIIRS DNB · Falchi et al. 2016 *World Atlas of Artificial Night
Sky Brightness*.
