# darkmap

Public dark-sky planning map for astronomy, field sensing, cycling, hiking, and
low-light logistics: <https://darkmap.phasi.space>.

The map combines VIIRS DNB radiance, Falchi 2016 World Atlas, NASA GIBS
atmospheric overlays (clouds, aerosol optical depth, water vapor), an OpenAQ
PM2.5 layer with a kernel-diffusion estimate, a spectral transmission widget
(T(λ) with band guidance), point readout, OSM search, terrain horizon
raycasting, sun/moon ephemeris, and shareable map state.

## Launch Status

The public cutover is complete; [issue #97](https://github.com/Jesssullivan/darkmap.phasi.space/issues/97)
has the closing evidence. `darkmap.tinyland.dev` remains an intentional legacy
Tinyland path for current infrastructure and should not be renamed casually.

See [`docs/PUBLIC_LAUNCH.md`](./docs/PUBLIC_LAUNCH.md) for DNS, TLS,
Cloudflare Tunnel, legacy tailnet path, and public-repo readiness notes.

## Privacy

This repo should be safe to make public:

- no user accounts, payments, runtime database, or write APIs
- no checked-in `.env` files or plaintext credentials
- no repo-owned analytics or ad-tech scripts
- map APIs are proxied only to normalize responses and caching

Operational secrets live outside the repo in the operator SOPS store and in
GitHub Actions secrets. This repo should only document secret boundaries, not
copy secret values or operator-only material.

Before release-sensitive changes, run the public-readiness checks in
[`docs/PUBLIC_LAUNCH.md`](./docs/PUBLIC_LAUNCH.md). The latest local audit
summary is in [`docs/PUBLIC_READINESS_AUDIT.md`](./docs/PUBLIC_READINESS_AUDIT.md).

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
Tinyland-wide planning records, but repo-local implementation work lives in
GitHub first. The launch/follow-up issue map lives in
[`docs/PUBLIC_LAUNCH.md`](./docs/PUBLIC_LAUNCH.md#tracker-gate).

Current public-readiness follow-up: [#122](https://github.com/Jesssullivan/darkmap.phasi.space/issues/122).

## Data Sources

- NASA/NOAA VIIRS Day/Night Band composites
- Falchi et al. 2016, *The new world atlas of artificial night sky brightness*
- NASA GIBS WMTS (MODIS Terra / VIIRS NOAA-20 true-color, MODIS Combined AOD, MODIS Terra water vapor)
- Open-Meteo point forecast (RH, cloud cover, visibility, PWV), CC-BY 4.0
- OpenAQ v3 ground-station PM2.5, CC-BY 4.0
- HITRAN2020 line data (curated subset) for the spectral transmission bands
- OpenStreetMap data through Photon
- AWS Mapzen Terrarium elevation tiles
- Current public WMS transport for selected light-pollution rasters

lightpollutionmap.info is an inspiration and comparison point, not an
affiliation or primary attribution. See [`/docs`](./src/routes/docs/+page.svelte)
for source notes.
