# Scientific raster pilot (TIN-1287 / GH #103)

This offline pilot accepts a supplied, reviewed scientific crop and writes just
`8/74/96.png` and its parent `7/37/48.png`. Each PNG has a neighboring
`.science.tif` with physical Float32 radiance, plus a shared `receipt.json`.
Nothing imports the tool into the application. It changes no raster source,
upstream fallback, browser cache, runtime service, deployment, or storage.
It does not complete GH #103's self-hosted rendering or full pyramid acceptance.

## Source decision and scientific boundary

The first real input is NASA Black Marble **VNP46A4, collection 002, annual
2019, `AllAngle_Composite_Snow_Free`**. The existing application description's
NOAA label is not an authority for these input bytes. NASA describes this
product as annual, corrected nighttime lights from Suomi-NPP VIIRS and
identifies the collection-002 DOI and HDF5 archive naming convention on its
[product page](https://ladsweb.modaps.eosdis.nasa.gov/missions-and-measurements/products/VNP46A4/).
The chosen input is measured nighttime radiance; it is not a direct measurement
of ground sky brightness or a Bortle class.

The [Black Marble v2 user guide](https://ladsweb.modaps.eosdis.nasa.gov/api/v2/content/archives/Document%20Archive/Science%20Data%20Product%20Documentation/Black-Marble_v2.0_UG_2024.pdf),
section 5.3 / tables 11–12 and the VNP46A4 file specification in its appendix,
records physical Float32 radiance with scale 1 and offset 0. Its science fill is
`-999.9`. The matching `AllAngle_Composite_Snow_Free_Quality` has 0 good,
1 poor, 2 gap-filled and 255 fill. For this pilot the handoff crop accepts only
flag 0; source fill, rejected flags, and non-finite values must be normalized to
`-9999` before delivery, with the exact preprocessing recorded in the manifest.
The tool checks that receipt and the crop format; it does not independently
recreate or audit the crop's quality masking from the original full archive.
That masking remains part of the input review.

Falchi 2016 is modeled artificial night sky brightness, a separate quantity
and artifact. Its exact source artifact, redistribution license and scientific
normalization have not been verified for this pilot. No Falchi fixture is
accepted. No display PNG is treated as a scientific source raster.

## Received-byte contract

`data/raster-pilot/nasa-input.template.json` is an intentionally incomplete,
non-executable handoff template. Its null fields are not example checksums.
Before running with NASA data, supply all of:

- One to four original authorized HDF5 archives, each with its exact NASA
  filename, collection/version, acquisition year, receipt time and locally
  computed SHA-256; the tool checks bytes, filename and science/quality SDS.
  A full-coverage crop can cross granule boundaries; retain every contributing
  archive's receipt in `archives`, including any reviewed crop/mosaic steps.
- One reviewed north-up COG crop, at most 4096 × 4096 pixels, exactly one
  Float32 band in `nW cm-2 sr-1` (band unit metadata must match), explicit CRS,
  scale 1, offset 0, and nodata `-9999`. Include the exact crop filename and
  received-byte SHA-256. Native `EPSG:4326` is accepted and reprojected.
  The COG must be self-contained; external metadata, masks and overviews are
  not bound by its checksum and are rejected. Internal mask rejection must
  agree with the explicit normalized nodata values.
- A provenance receipt identifying who supplied the approved bytes and how
  the selected science SDS, QA flag 0 policy, source fill conversion, georeference
  and crop extent were prepared. Credentials do not belong in the manifest.

No NASA archive or scientific crop has been received for this change. The
program has no downloader, login, token minting, credential reader or network
calls. Missing local data, placeholder hashes and scientific metadata mismatch
fail before an output directory is created. An existing output directory is
refused so earlier evidence is preserved.
An all-nodata result in either requested tile also fails before writing output;
an unrelated or empty crop cannot be presented as a successful pilot.

The requested child spans approximately 39.91–40.98° N and its parent
38.82–40.98° N, both within approximately 75.94–73.13° W. These are geometry
derived from the XYZ request, not observations from acquired source bytes.
Against the user guide's geographic 10° grid (section 3 / figure 2), both
cross the 40° boundary; a complete source crop can therefore require the
neighboring `h10v04` and `h10v05` granules. Exact archive identities, production
versions and checksums remain required handoff fields, not inferred here.

The source-identity checks bind a reviewed crop to a received archive receipt;
they do not prove that upstream `PostGIS:VIIRS_2019` was built from the same
NASA archive or collection. That mapping needs its own evidence before any
runtime replacement can be accepted.

## Execution

Use the dedicated shell from this repository's existing `flake.lock`. GIS
packages are kept out of the default application shell.

```sh
nix develop --no-write-lock-file .#raster-pilot --command just raster-pilot-test
nix develop --no-write-lock-file .#raster-pilot --command just raster-pilot \
  /approved/input.json /approved/crop.tif /scratch/pilot-run \
  archive=/approved/original-granules
```

The second command is a handoff shape, not evidence of acquired archives.
`archive` accepts a directory containing the manifest's exact received filenames;
for a single-granule crop it also accepts that original HDF5 file directly.
Keep large scientific input bytes and generated outputs in operator-approved
scratch storage. Do not commit downloaded archives, credentials or tile trees.

The tool matches `src/lib/server/raster/TileMath.ts`'s XYZ bounds in EPSG:3857
and `RasterClient.ts`'s 256 × 256 output size. It uses nearest-neighbor
resampling from the native band, disables source overviews (which could contain
averaged values), and uses an exact transformer and one warp thread. Scientific samples stay
Float32, including dim fractional radiance and values above the old integer
saturation. Nodata maps to transparent RGBA `(0,0,0,0)`; valid zero remains
opaque. The science TIFF is the data artifact; the PNG is presentation only.

`pilot-radiance-classes-v1` is a deliberately explicit **pilot palette in
physical units**, recorded in the receipt. It has lower-bound classes at
0, 0.1, 1, 10 and 100 nW cm-2 sr-1. It does not reuse the application's
`VIIRS_RAMP`, whose documented quantities are styled bytes. No inverse byte
stretch or equivalence to the upstream SLD is known or implied.

## Parity evidence

An optional supplied reference manifest compares the two generated PNGs to
received upstream WMS PNGs. The program never fetches the references. Pass its
path as `reference=/approved/reference.json`. The JSON shape is:

```json
{
  "kind": "upstream-wms-capture",
  "layer": "PostGIS:VIIRS_2019",
  "captured_at": "ACTUAL RECEIPT TIME",
  "crs": "EPSG:3857",
  "tiles": {
    "8/74/96": {
      "filename": "child.png",
      "request_url": "EXACT PUBLIC WMS 1.1.1 GetMap URL FOR THIS BBOX",
      "sha256": "ACTUAL RECEIVED-BYTE SHA-256",
      "bbox": ["EXACT NUMERIC BOUNDS FROM TileMath, NOT STRINGS"],
      "width": 256,
      "height": 256
    },
    "7/37/48": {
      "filename": "parent.png",
      "request_url": "EXACT PUBLIC WMS 1.1.1 GetMap URL FOR THIS BBOX",
      "sha256": "ACTUAL RECEIVED-BYTE SHA-256",
      "bbox": ["EXACT NUMERIC BOUNDS FROM TileMath, NOT STRINGS"],
      "width": 256,
      "height": 256
    }
  }
}
```

This displayed shape is incomplete and must not be mistaken for a receipt.
Reference PNG paths resolve relative to their manifest. Reference checksums,
256 × 256 size, 8-bit channels, CRS, layer and each exact bbox are checked before
output. Indexed, grayscale, RGB and RGBA references decode to RGBA for comparison;
the checksum remains the received PNG's, without rewriting it.
Acquired upstream references must also record their exact public WMS request
URL; the tool verifies its endpoint, layer, default style, size and bbox and
rejects unexpected query parameters.
The receipt includes the complete reference manifest and its checksum,
alpha mismatch count, RGB mismatch count over jointly visible pixels, and
mean/max channel error. A difference report is evidence for review, not a
claim of visual or scientific parity. Color/class parity remains unverified
until the upstream source/version/stretch/SLD is reconciled, actual reference
bytes are supplied, and the operator reviews the resulting tiles.

Synthetic comparison references must say `kind: synthetic-fixture`; the test
uses that explicit designation. A synthetic zero-difference test validates the
comparison algorithm, not NASA acquisition or live upstream equivalence.

## Verification and next handoff

The tests generate a small scientific COG from known values in a temporary
directory: dim fractional values, high radiance, valid zero and rejected-data
holes. No fixture file impersonates a satellite download. Tests cover repeated
byte-identical PNG/science/receipt output, exact Float32 retention, transparent
nodata, parent/child sample alignment, EPSG:4326 reprojection, out-of-crop
transparency, checksum/units/scale/CRS/quality/integer failures, reference
integrity and comparison metrics. This is a local scientific-tool proof, not a
browser, RBE, deployed-rendering or operator LOOK proof.

The remaining operator handoff is the authorized original NASA granules and
reviewed scientific crop, exact provenance/quality receipts, and actual WMS
references for both tiles. No large acquisition, account login or token action
is authorized by this source-only implementation. Full pyramid generation,
COG hosting, storage/cache headers, update cadence, runtime selection and
Falchi licensing remain outside this pilot and GH #103 stays open.
