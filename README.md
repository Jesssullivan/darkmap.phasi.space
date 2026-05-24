# darkmap

Dark-sky planning map for astronomy, field sensing, bike/hike planning, and
night-work logistics. The canonical hostname is
<https://darkmap.phasi.space>.

The map combines public light-pollution datasets with terrain-aware astronomy
tools: VIIRS DNB radiance, Falchi 2016 World Atlas, OSM search, terrain horizon
raycasting, sun/moon ephemeris, and shareable map state.

## Launch Status

`darkmap.phasi.space` is the public service hostname. The launch tracker is
[GitHub issue #97](https://github.com/Jesssullivan/darkmap.phasi.space/issues/97).

As of 2026-05-24, the Cloudflare Tunnel route and proxied Cloudflare DNS record
are configured for `darkmap.phasi.space`. Some public resolvers may still return
the older DreamHost-served CNAME to `darkmap.tinyland.dev`, which lands on the
legacy tailnet ingress IP, until `phasi.space` authority fully converges.

The SOPS-backed Cloudflare account has an active `phasi.space` zone. The zone
used by this repo is assigned these nameservers:

- `austin.ns.cloudflare.com`
- `oaklyn.ns.cloudflare.com`

See [`docs/PUBLIC_LAUNCH.md`](./docs/PUBLIC_LAUNCH.md) for the DNS, TLS,
Cloudflare Tunnel, legacy tailnet path, and public-repo readiness checklist.

## Privacy

This repo should be safe to make public:

- no user accounts, payments, runtime database, or write APIs
- no checked-in `.env` files or plaintext credentials
- no analytics or ad-tech scripts
- map APIs are proxied only to normalize responses and caching

Operational secrets live outside the repo in the operator secret store and in
GitHub Actions secrets.

Before release-sensitive changes, run the public-readiness checks in
[`docs/PUBLIC_LAUNCH.md`](./docs/PUBLIC_LAUNCH.md).

## Stack

- SvelteKit + adapter-node
- Svelte 5, TypeScript, Skeleton 4, Tailwind v4
- MapLibre GL JS
- Effect.ts service layers for raster, geocoder, elevation, and ephemeris work
- astronomy-engine for sun/moon calculations
- Just + Nix for local development
- Bazel/Bzlmod for module graph and unit-test proofs
- OpenTofu + Kustomize for the current deployment path

## Development

Use the Justfile. It is the authoritative entrypoint for local and CI commands.

```bash
direnv allow
just setup
just check
just build
just dev
```

Useful targeted checks:

```bash
just test-local
just test-unit
just format-check
```

## Project Work

GitHub issues are the public work tracker for this repo. Linear may still hold
Tinyland-wide planning records, but repo-local implementation work should have a
matching GitHub issue. The launch/follow-up issue map lives in
[`docs/PUBLIC_LAUNCH.md`](./docs/PUBLIC_LAUNCH.md#tracker-gate).

## Data Sources

- NASA/NOAA VIIRS Day/Night Band composites
- Falchi et al. 2016, *The new world atlas of artificial night sky brightness*
- OpenStreetMap data through Photon
- AWS Mapzen Terrarium elevation tiles
- Current public WMS transport for selected light-pollution rasters

lightpollutionmap.info is an inspiration and comparison point, not an
affiliation or primary attribution. See [`/docs`](./src/routes/docs/+page.svelte)
for source notes.
