# Smoke Runbook

This runbook is intentionally public-safe. It validates the repo, the public
Cloudflare Tunnel edge, and the legacy tailnet ingress without documenting
private cluster addresses, credential paths, or operator-specific secret
material.

## Local Smoke

```bash
just smoke-local
```

The recipe runs the normal repo gate, builds the SvelteKit server bundle, starts
it on localhost, then checks:

- `/` returns `200`
- the built and served HTML do not contain `ad_prebid`
- `/api/raster` response headers do not contain cookies or ad-tech headers

## Deployment Smoke

Run from an environment that already has the approved deployment credentials,
cluster access, and Tinyland tailnet routing configured.

```bash
just tofu-plan
just kustomize-validate-server
just deploy
```

Before treating DNS as fully public, verify the public DNS record:

```bash
dig +short CNAME darkmap.phasi.space @1.1.1.1
dig +short A darkmap.phasi.space @1.1.1.1
```

Target steady state:

```text
<Cloudflare edge addresses, no 100.64.0.0/10 address>
```

During authority propagation, public resolvers may still return the older
DreamHost-served CNAME to `darkmap.tinyland.dev` and the `100.125.97.64`
tailnet ingress IP. Also audit `dig +short NS phasi.space @a.nic.space`.
Cloudflare steady state should show `austin.ns.cloudflare.com` and
`oaklyn.ns.cloudflare.com` for the zone used by this repo.

Then verify the public edge:

```bash
curl -sI https://darkmap.phasi.space/
curl -s https://darkmap.phasi.space/ | rg -c ad_prebid
curl -sI 'https://darkmap.phasi.space/api/raster?layer=viirs_2019&z=8&x=74&y=96' | rg -i 'set-cookie|prebid|googletag'
```

Expected:

- homepage status is `200`
- `ad_prebid` count is `0`
- the final header scan exits with no matches
- once recursive DNS reaches Cloudflare, headers include `server: cloudflare`

## Browser Smoke

Open <https://darkmap.phasi.space/> and verify:

- MapLibre canvas renders
- layer toggles load tiles through `/api/raster`
- place search accepts both names and coordinates
- point readout returns a value or a clear upstream error
- DevTools Network shows no Prebid, Google Tag Manager, or ad-tech requests

## Tracker Sanity

Repo-local implementation work should be represented as GitHub issues. Linear
records can remain the Tinyland-wide planning source, but active darkmap tasks
should not exist only in Linear once this repository is public.

See [`PUBLIC_LAUNCH.md`](./PUBLIC_LAUNCH.md) for the current DNS/TLS gates and
the public issue map.
