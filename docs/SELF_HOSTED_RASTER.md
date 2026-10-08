# Self-hosted VIIRS raster tiles (RV1)

Since about 2026-10-08 01:20Z the third-party GeoServer behind `/api/raster`
(`www2.lightpollutionmap.info`) answers our tile requests with 403, so
production returns `403 {"message":"upstream raster error"}` and the Public
smoke workflow fails. Operator ruling RV1 (TIN-3692 comment `c362231a`) is to
self-host: render our own VIIRS tiles from the authoritative NASA source, store
them behind Cloudflare, and serve `/api/raster` from them. We do not scrape or
mirror the provider that is denying us.

## What the code does

- `src/lib/server/raster/SelfHostedTiles.ts` reads
  `${DARKMAP_RASTER_TILE_BASE_URL}/${selfHostedPath}/${z}/${x}/${y}.png`.
  The base URL is `https://…` (production: a public R2 custom domain) or
  `file:///…` (local proofs, or a mounted volume).
- `/api/raster` uses it whenever `DARKMAP_RASTER_TILE_BASE_URL` is set and
  then never contacts the upstream WMS. Responses are `image/png` with the
  existing `cache-control`, `cdn-cache-control` and
  `cloudflare-cdn-cache-control` headers, sanitized by `AdStripper`, plus
  `x-darkmap-raster-source: self-hosted`.
- The pyramid is sparse: tiles with no valid radiance are not stored. A 404
  inside the rendered range is answered with a transparent 256 × 256 PNG. Any
  other store error is a `RasterError` (the stale in-memory cache still
  applies). Requests deeper than the rendered zoom get a transparent tile;
  the VIIRS layers declare `maxNativeZoom: 8`, so MapLibre overzooms instead.
- Without the variable, the legacy upstream client stays in place (rollback is
  removing the ConfigMap key and restarting the deployment).
- The VIIRS layers now carry the NASA attribution. `world_atlas_2015`
  (Falchi 2016) is **not** self-hosted: its redistribution license has not
  been verified, so it still uses the upstream and degrades as before.

## Source and license

NASA Black Marble **VNP46A4 collection 002**, annual composites,
`AllAngle_Composite_Snow_Free`, from LAADS DAAC
(<https://ladsweb.modaps.eosdis.nasa.gov/missions-and-measurements/products/VNP46A4/>).
LAADS data may be used and redistributed with acknowledgment
(<https://modaps.modaps.eosdis.nasa.gov/services/faq/LAADS_Data-Use_Citation_Policies.pdf>).
Cite doi:10.5067/VIIRS/VNP46A4.002. Downloads need an Earthdata Login token.
An anonymous request is redirected to the license/login page; this was checked
on 2026-10-08 with a 1 KiB range request, and no data was received.

One year is 540 granules, about 49 GB (2019 listing, checked 2026-10-08). The
smoke tile `8/74/96` needs `h10v04` and `h10v05`.

Quality policy (same as the pilot): only `AllAngle_Composite_Snow_Free_Quality
== 0` is kept. Fill, other flags, negative and non-finite values become nodata
(transparent). Leaf tiles (z8) use nearest samples from the native 15
arc-second grid. Parents use the mean of valid child radiance. The palette is
the pilot's physical-unit `pilot-radiance-classes-v1`. It is **not** the
upstream SLD, so the look differs from the old layer.

## Operator steps (credentials are not created by agents)

1. **Earthdata token.** Sign in at <https://urs.earthdata.nasa.gov>, open
   *Generate Token*, and create a user token (valid 60 days). Approve the
   LAADS DAAC application if prompted. On sting, store it outside git:
   `install -m 600 /dev/null /srv/fast-local/jess/secrets/earthdata-token` and
   paste the token into that file. Tell the lane the path, not the value.
2. **Tile bucket behind Cloudflare.** In the Cloudflare account that owns
   `xoxd.ai`:
   - Create an R2 bucket `darkmap-tiles`.
   - Connect a custom domain to it, for example `tiles.darkmap.xoxd.ai`
     (public read). Leave `r2.dev` public access disabled.
   - Create an R2 API token with *Object Read & Write* on `darkmap-tiles`
     only.
   - Store the token's S3 access key pair on sting in an AWS shared-credentials
     file with profile `darkmap-r2`, at
     `/srv/fast-local/jess/secrets/darkmap-r2.credentials`, mode 600.
   - Record the account ID for the endpoint
     `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

   If an existing OpenTofu Cloudflare stack should own this bucket, add it
   there instead. This repo's `infra/tofu` has no Cloudflare provider today.
3. **Render and upload** (lane work once steps 1–2 exist; on sting, through
   `tld-heavy`, inside `nix develop --no-write-lock-file .#raster-pilot`):

   ```sh
   W=/srv/fast-local/jess/data/darkmap-raster/2019
   just raster-fetch 2019 $W/archives /srv/fast-local/jess/secrets/earthdata-token
   just raster-prepare $W/archives $W/prepared
   just raster-render $W/prepared/mosaic.vrt $W/tiles $W/work vnp46a4-002/2019 $W/archives/receipts.json 8
   AWS_SHARED_CREDENTIALS_FILE=/srv/fast-local/jess/secrets/darkmap-r2.credentials \
     aws --profile darkmap-r2 --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
     s3 sync $W/tiles s3://darkmap-tiles/raster/vnp46a4-002/2019 \
     --content-type image/png --cache-control 'public, max-age=31536000, immutable' \
     --exclude manifest.json
   ```

   Upload `manifest.json` with `--content-type application/json`, then repeat
   for 2012–2018. Each year can be fetched, rendered, uploaded and its
   archives deleted before the next one.
4. **Switch production.** Add the URL to the darkmap namespace (it is not a
   secret). The preferred route is a follow-up PR with a kustomize
   `configMapGenerator` named `darkmap-raster-source`. The immediate route:

   ```sh
   kubectl -n darkmap create configmap darkmap-raster-source \
     --from-literal=DARKMAP_RASTER_TILE_BASE_URL=https://tiles.darkmap.xoxd.ai/raster
   kubectl -n darkmap rollout restart deploy/darkmap
   ```
5. **Verify.**

   ```sh
   curl -sI 'https://darkmap.phasi.space/api/raster?layer=viirs_2019&z=8&x=74&y=96'
   ```

   Expect `content-type: image/png` and `x-darkmap-raster-source: self-hosted`.
   Then dispatch `public-smoke.yml` for both hosts.

Until the store is populated, years without uploaded tiles render as fully
transparent. Do not set the variable before 2019 is uploaded.
