# darkmap

An ad-free dark-sky and atmosphere planning map for the work that happens above the
horizon — astronomy, air quality, atmospheric optics, and satellite passes. Live at
<https://darkmap.phasi.space>.

darkmap re-presents open public datasets on one shared map, re-weighted for four
kinds of user — and it never hides a feature behind a mode you have to discover.

## One map, four lenses

Pick a **lens** and the same map re-orders and re-emphasizes itself for your work;
nothing is greyed out or removed.

- **◐ Sky** — dark-sky & astrophotography planning: Bortle/SQM from VIIRS + Falchi
  2016, sun/moon ephemeris, and tonight's dark window.
- **☁ Air** — air quality & atmosphere: multi-pollutant NowCast AQI, an OpenAQ
  ground-station layer, and cloud / aerosol / water-vapor overlays.
- **📡 Links** — RF / laser link planning: atmospheric transmission T(λ) computed
  along the actual beam, with a go / no-go link-budget margin.
- **🛰 Orbit** — LEO ground-station ops: satellite passes gated by the _real_ terrain
  horizon (not a flat one), with az/el track, Doppler, and keyhole notes.

Every derived value carries an honesty label — measured / modeled / predicted — and
its coverage caveats; the map never fabricates a reading it doesn't have.

## Built on open data and prior art

darkmap stands on the shoulders of open datasets and earlier work. The idea was
inspired by lightpollutionmap.info — an inspiration and comparison point, not an
affiliation or primary attribution.

- **Light pollution** — NASA/NOAA VIIRS Day/Night Band + Falchi et al. 2016, _The new
  world atlas of artificial night sky brightness_
- **Atmosphere** — NASA GIBS (clouds, aerosol optical depth, water vapor) + Open-Meteo
  point forecast & CAMS air quality (CC-BY 4.0)
- **Ground air quality** — OpenAQ v3 (CC-BY 4.0)
- **Orbital elements** — Celestrak TLEs (SGP4 via satellite.js)
- **Spectral bands** — a curated HITRAN2020 line subset
- **Geocoding & elevation** — OpenStreetMap via Photon + AWS Terrarium terrain tiles

See [`/docs`](https://darkmap.phasi.space/docs) for the full, canonical attribution.

## Run it

The Justfile is the authoritative entrypoint for every local and CI command.

```bash
direnv allow
just setup     # pnpm install
just check     # lint + typecheck + unit tests
just build
just dev
```

## Stack

SvelteKit (adapter-node) · Svelte 5 + TypeScript · MapLibre GL · Skeleton 4.15.2
(pinned) + Tailwind v4 · Effect.ts service layers · astronomy-engine + satellite.js.
Just + Nix for local dev; Bazel/Bzlmod for the module graph and unit-test proofs.

## Privacy

- No user accounts, payments, runtime database, or write APIs.
- No analytics or ad-tech.
- Upstream data APIs are proxied only to normalize responses and add caching; the one
  runtime secret (an OpenAQ key) lives outside the repo, never in git.

## Contributing

Issues and PRs are welcome — there are a few [good first issues][gfi] to start with
(a logo, contributor docs, a perf pass). Agents and operators should read
[`AGENTS.md`](./AGENTS.md) first.

[gfi]: https://github.com/Jesssullivan/darkmap.phasi.space/labels/good%20first%20issue
