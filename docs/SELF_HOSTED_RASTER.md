# Self-hosted raster tiles (RV1, RV12, RV13)

Since about 2026-10-08 01:20Z the third-party GeoServer behind `/api/raster`
(`www2.lightpollutionmap.info`) answers our tile requests with 403, so
production returned `403 {"message":"upstream raster error"}` and the Public
smoke workflow failed. Operator rulings (TIN-3692):

- **RV1**: self-host the VIIRS night-lights tiles; no dependence on the
  upstream provider. We do not scrape or mirror the provider that is denying us.
- **RV12**: serve tiles now from NASA GIBS's public Black Marble WMTS (no
  login), labelled with GIBS's real product, year and composite, never as
  2019. Replace them with VNP46A4 2019 tiles once the operator places an
  Earthdata token on sting. Both halves are done: the GIBS 2016 interim
  served from 2026-10-09 22:42Z, and the slot now serves VNP46A4 2019.
- **RV13**: the store is a read-only PVC in ns `darkmap` (`file://` base
  URL), with DreamObjects (DreamHost S3) as the durable object copy.

## What is served today

| | |
|---|---|
| Layer id (kept for permalinks, cache keys and smoke) | `viirs_2019` (the newest VIIRS slot) |
| UI label | `VIIRS 2019 (VNP46A4)` (year chip `2019`) |
| Source | NASA Black Marble VNP46A4 collection 002 from LAADS DAAC, 2019 annual composite, `AllAngle_Composite_Snow_Free` (VIIRS DNB, Suomi NPP); 540 granules |
| Rendering | our own: quality flag 0 only, EPSG:3857 z0..z8, 256 px PNG, pilot palette `pilot-radiance-classes-v1` (physical units), sparse (empty tiles are not written) |
| Tiles | 56,358 (z0 1, z1 4, z2 16, z3 56, z4 190, z5 694, z6 2,699, z7 10,674, z8 42,024); about 291MB; rendered 2026-10-10T02:18:32Z with GDAL 3.12.3 |
| Store path | `vnp46a4-002/2019/{z}/{x}/{y}.png` plus `manifest.json` (with the per-granule receipts) and `SHA256SUMS` |
| API headers | `x-darkmap-raster-source: self-hosted`, `x-darkmap-raster-product: NASA Black Marble VNP46A4.002 2019 annual composite (AllAngle_Composite_Snow_Free)` |
| Attribution | `NASA Black Marble VNP46A4 collection 002 (VIIRS Land SIPS, LAADS DAAC), doi:10.5067/VIIRS/VNP46A4.002` |

The tiles use the pilot palette, not the upstream GeoServer SLD, so the rail
shows the layer description instead of the upstream VIIRS colour-scale legend
while this slot is active. The 2012-2018 VIIRS years and World Atlas 2015 keep
the upstream WMS and degrade as before.

### Interim (RV12 first half, kept for rollback)

From 2026-10-09 22:42Z until the VNP46A4 swap the slot served our mirror of
NASA GIBS `VIIRS_Black_Marble`, time `2016-01-01` (the Black Marble 2016
annual composite), `GoogleMapsCompatible_Level8`, labelled
`Black Marble 2016 (NASA GIBS)`, never as 2019. That pyramid stays in the store
at `gibs-viirs-black-marble/2016` (87,380 tiles, `manifest.json`,
`SHA256SUMS`; GIBS bytes unmodified, "Imagery courtesy NASA EOSDIS GIBS",
<https://nasa-gibs.github.io/gibs-api-docs/>). Reverting the VNP46A4 rebind
commit points the slot back at it.

## What the code does

- `src/lib/layers.ts`: a layer with a `selfHosted` binding (`path`, `maxZoom`,
  `product`, `dataYear`) is served only from our store. Its `label`,
  `chipLabel`, `description` and `attribution` describe the stored product.
- `src/lib/server/raster/SelfHostedTiles.ts` is the raster client for the whole
  route:
  - bound layer, store set: read `${DARKMAP_RASTER_TILE_BASE_URL}/${path}/manifest.json`
    once (re-checked every 30 s while missing), then `${path}/${z}/${x}/${y}.png`.
    The base URL is `https://…` or `file:///…`, with no query, fragment or
    credentials. z/x/y are validated integers and `path` comes from the static
    layer table, so no request string reaches the file path.
  - missing manifest (unmounted or empty volume, wrong base path): **503
    `raster store unavailable`**, so an outage cannot hide behind blank 200s.
  - missing tile inside a present pyramid: transparent 256 × 256 PNG (sparse
    pyramids). Deeper than `maxZoom`: transparent (MapLibre overzooms).
  - other store errors or non-PNG bytes: 502. No fallback to the upstream.
  - bound layer, store unset: 503 (a layer labelled as our product is never
    served from the upstream).
  - unbound layer: the upstream WMS client, as before, with or without a store.
- Cache headers are unchanged (`cache-control`, `cdn-cache-control`,
  `cloudflare-cdn-cache-control`, AdStripper).

## Build the GIBS pyramid

On sting, data under `/srv/fast-local/jess/data/darkmap-tiles/` (never `/home`).
`scripts/raster-pilot/gibs_mirror.py` is standard-library Python: modest
concurrency (default 4, max 8), a global rate cap, an identifying User-Agent,
backoff on 429/5xx, and resumable runs.

```sh
just raster-gibs-mirror /srv/fast-local/jess/data/darkmap-tiles/gibs-viirs-black-marble/2016
```

87,381 tiles (z0..z8), about 3 GB.

## Load the PVC (RV13a)

`infra/kustomize/honey/darkmap/pvc.yaml` declares `darkmap-raster-tiles`
(`local-path-retain`, 8Gi, RWO). The deployment mounts it read-only at
`/var/lib/darkmap-tiles` and sets
`DARKMAP_RASTER_TILE_BASE_URL=file:///var/lib/darkmap-tiles`. local-path binds
the volume to the node of its first consumer, so create the claim and bind it
on honey with a loader pod before the deployment first mounts it:

```sh
kubectl kustomize infra/kustomize/honey/darkmap \
  | yq 'select(.kind == "PersistentVolumeClaim")' | kubectl apply -f -
kubectl -n darkmap apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: {name: darkmap-tiles-loader}
spec:
  nodeSelector: {kubernetes.io/hostname: honey}
  restartPolicy: Never
  containers:
    - name: loader
      image: busybox:1.36
      command: ['sh', '-c', 'sleep 7200']
      volumeMounts: [{name: tiles, mountPath: /data}]
  volumes:
    - name: tiles
      persistentVolumeClaim: {claimName: darkmap-raster-tiles}
EOF
kubectl -n darkmap wait --for=condition=Ready pod/darkmap-tiles-loader --timeout=300s
tar -C /srv/fast-local/jess/data/darkmap-tiles -cf - gibs-viirs-black-marble \
  | kubectl -n darkmap exec -i darkmap-tiles-loader -- tar -xf - -C /data
kubectl -n darkmap exec darkmap-tiles-loader -- sh -c \
  'cd /data/gibs-viirs-black-marble/2016 && sha256sum -c SHA256SUMS | grep -vc ": OK$"'   # expect 0
kubectl -n darkmap delete pod darkmap-tiles-loader
```

Swapping or adding a pyramid later uses the same loader pod; the app reads
the new files without a restart (a newly added manifest is picked up within
30 s).

## Durable copy on DreamObjects (RV13b)

The durable object copy is on DreamObjects (DreamHost S3, Backblaze B2 underneath).
It has its own tenancy, separate from the lab offsite-backup legs:

| | |
| --- | --- |
| Endpoint / region | `https://s3.us-east-005.dream.io` / `us-east-005` |
| DreamObjects user | `tinyland-darkmap-tiles` (created 2026-10-10; owns only this bucket) |
| Bucket | `tinyland-darkmap-tiles` (private; ACL owner `FULL_CONTROL` only, no public grants) |
| Key custody | lab `nix/secrets/operators/dreamobjects-darkmap-tiles.yaml`, `dreamobjects.darkmap_tiles.{endpoint,region,user,bucket,purpose,created_at,access_key_id,secret_access_key}`, recipients honey, neo-unique and sting; registry row `dreamobjects.darkmap_tiles` |

The object prefixes mirror the store layout under
`/srv/fast-local/jess/data/darkmap-tiles/` (and the PVC root):

| Prefix | Contents |
| --- | --- |
| `vnp46a4-002/2019/` | VNP46A4.002 2019 pyramid (served): `{z}/{x}/{y}.png` z0-8, `manifest.json`, `SHA256SUMS` |
| `gibs-viirs-black-marble/2016/` | GIBS 2016 pyramid (rollback): `{z}/{x}/{y}.png` z0-8, `manifest.json`, `SHA256SUMS` |

The backup-leg keys (`nix/secrets/operators/dreamobjects-*-leg.yaml` and the
blahaj legs) are never used for this bucket, and this key never touches theirs.
Per-user tenancy is the confinement boundary on both sides.

### Re-sync procedure

Run this from sting after a pyramid is added or rebuilt, once the PVC has been
loaded and verified as above. The key goes into the environment only and is
never echoed:

```sh
# from a lab checkout on sting (the file decrypts with sting's age key)
F=nix/secrets/operators/dreamobjects-darkmap-tiles.yaml
k() { sops decrypt --extract "[\"dreamobjects\"][\"darkmap_tiles\"][\"$1\"]" "$F"; }
AWS_ACCESS_KEY_ID="$(k access_key_id)" AWS_SECRET_ACCESS_KEY="$(k secret_access_key)"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=us-east-005 \
  AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
for p in vnp46a4-002/2019 gibs-viirs-black-marble/2016; do
  /srv/fast-local/jess/bin/tld-heavy -- aws --endpoint-url https://s3.us-east-005.dream.io \
    s3 sync /srv/fast-local/jess/data/darkmap-tiles/$p s3://tinyland-darkmap-tiles/$p \
    --no-progress --only-show-errors
done
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

`sops exec-env` cannot be used here: it refuses nested documents. Command
substitution keeps the values off the terminal; do not `set -x` around it.
Never pass `--acl`: objects stay private. A new pyramid goes under its own
`<product>/<year>/` prefix, matching the store path.

Verify after every sync:

1. Object count per prefix (`aws s3api list-objects-v2 --bucket tinyland-darkmap-tiles --prefix <p>/ --query KeyCount`, paginated)
   must equal `find /srv/fast-local/jess/data/darkmap-tiles/<p> -type f | wc -l`.
2. Download a random sample of at least 10 objects per prefix to a transient
   directory (for example `/dev/shm`) and check them with `sha256sum -c` against
   that prefix's `SHA256SUMS`. Then remove the directory.

The bucket stays private, and the PVC is what production reads. Serving straight
from the bucket would need a public read path behind Cloudflare and an `https://` base
URL. That is a separate decision.

## VNP46A4 2019 (RV12 second half)

NASA Black Marble **VNP46A4 collection 002**, annual composites,
`AllAngle_Composite_Snow_Free`, from LAADS DAAC
(<https://ladsweb.modaps.eosdis.nasa.gov/missions-and-measurements/products/VNP46A4/>).
LAADS data may be used and redistributed with acknowledgment
(<https://modaps.modaps.eosdis.nasa.gov/services/faq/LAADS_Data-Use_Citation_Policies.pdf>).
Cite doi:10.5067/VIIRS/VNP46A4.002. Downloads need an Earthdata Login token;
an anonymous request is redirected to the login page. One year is 540 granules,
about 49 GB. The smoke tile `8/74/96` needs `h10v04` and `h10v05`.

Quality policy (same as the pilot): only `AllAngle_Composite_Snow_Free_Quality
== 0` is kept. Fill, other flags, negative and non-finite values become nodata
(transparent). Leaf tiles (z8) use nearest samples from the native 15
arc-second grid. Parents use the mean of valid child radiance. The palette is
the pilot's physical-unit `pilot-radiance-classes-v1`, **not** the upstream
SLD.

Operator step: sign in at <https://urs.earthdata.nasa.gov>, *Generate Token*
(valid 60 days), approve the LAADS DAAC application if prompted, then on sting
`install -m 600 /dev/null /srv/fast-local/jess/secrets/earthdata-token` and
paste the token into it. Lanes get only the path.

Lane steps (on sting, through `tld-heavy`, inside
`nix develop --no-write-lock-file .#raster-pilot`):

```sh
W=/srv/fast-local/jess/data/darkmap-raster/2019
just raster-fetch 2019 $W/archives /srv/fast-local/jess/secrets/earthdata-token
just raster-prepare $W/archives $W/prepared
just raster-render $W/prepared/mosaic.vrt \
  /srv/fast-local/jess/data/darkmap-tiles/vnp46a4-002/2019 $W/work vnp46a4-002/2019 $W/archives/receipts.json 8
```

Then write `SHA256SUMS` in the render directory, load `vnp46a4-002/2019`
into the PVC (and DreamObjects) as above, and only then deploy the code that
binds the slot to it. `src/lib/layers.ts` binds `viirs_2019` to
`{ path: 'vnp46a4-002/2019', maxZoom: 8, product: 'NASA Black Marble VNP46A4.002 2019 annual composite (AllAngle_Composite_Snow_Free)', dataYear: 2019 }`
with the label `VIIRS 2019 (VNP46A4)` and the VNP46A4 attribution. The upstream
radiance legend stays hidden, because the tiles use the pilot palette.

## Rollback

To go back to the GIBS 2016 interim, revert the VNP46A4 rebind commit (the
pyramid is still in the store). To leave self-hosting entirely, remove the
`selfHosted` binding from the slot (it then returns to the upstream WMS and its
old label). Removing only the environment variable is not a
rollback: a bound layer then answers 503.

## Verify

```sh
curl -sI 'https://darkmap.phasi.space/api/raster?layer=viirs_2019&z=8&x=74&y=96'
```

Expect `200`, `content-type: image/png`, `x-darkmap-raster-source: self-hosted`
and an `x-darkmap-raster-product` naming `VNP46A4.002 2019`. Then
dispatch `public-smoke.yml` for both hosts.
