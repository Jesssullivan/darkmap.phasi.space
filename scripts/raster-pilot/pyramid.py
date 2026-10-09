"""Self-hosted VIIRS pyramid (RV1, TIN-1287 / GH #103).

NASA Black Marble VNP46A4 collection 002 annual granules -> sparse XYZ PNG tiles
for `/api/raster` (see src/lib/server/raster/SelfHostedTiles.ts).

  fetch    download one year's granules from LAADS DAAC with an operator
           Earthdata Login token (EARTHDATA_TOKEN or --token-file); the token is
           never printed or written to receipts.
  prepare  quality-mask each granule to Float32 radiance (QA flag 0 only,
           nodata -9999) as a georeferenced GeoTIFF and build a mosaic VRT.
  render   write EPSG:3857 256 x 256 PNG tiles z0..max-zoom using the pilot's
           physical-unit palette; empty tiles are not written.

Network access happens only in `fetch`, only to ladsweb.modaps.eosdis.nasa.gov.
"""

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import urllib.request

import numpy as np
from osgeo import gdal, osr

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pilot  # noqa: E402  (shared bbox, palette, PNG writer)

gdal.UseExceptions()
osr.SetPROJEnableNetwork(False)

LAADS = "https://ladsweb.modaps.eosdis.nasa.gov"
LISTING = LAADS + "/archive/allData/5200/VNP46A4/{year}/001.json"
NAME = re.compile(r"^VNP46A4\.A(?P<year>\d{4})001\.h(?P<h>\d{2})v(?P<v>\d{2})\.002\.\d{13}\.h5$")
GRID = "HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data_Fields"
SCIENCE = "AllAngle_Composite_Snow_Free"
QUALITY = "AllAngle_Composite_Snow_Free_Quality"
GRANULE_PX = 2400
NODATA = -9999.0
DOI = "https://doi.org/10.5067/VIIRS/VNP46A4.002"
ATTRIBUTION = ("NASA Black Marble VNP46A4 collection 002 (VIIRS Land SIPS, LAADS DAAC), "
               "doi:10.5067/VIIRS/VNP46A4.002")
MAX_LAT = 85.0511287798066


def log(message):
    print(f"pyramid: {message}", file=sys.stderr, flush=True)


def read_token(token_file):
    token = os.environ.get("EARTHDATA_TOKEN", "")
    if not token and token_file:
        token = Path(token_file).read_text().strip()
    pilot.require(token, "set EARTHDATA_TOKEN or pass --token-file (operator Earthdata Login token)")
    return token


def listing(year):
    with urllib.request.urlopen(LISTING.format(year=year), timeout=60) as res:
        rows = json.load(res)["content"]
    files = [r for r in rows if NAME.match(r.get("name", "")) and NAME.match(r["name"])["year"] == str(year)]
    pilot.require(files, f"LAADS listing for {year} has no VNP46A4 granules")
    return files


def granule_filter(names):
    wanted = {n.strip() for n in (names or "").split(",") if n.strip()}
    return lambda name: not wanted or any(f".{w}." in name for w in wanted)


def download(row, out_dir, token):
    target = Path(out_dir) / row["name"]
    if target.is_file() and target.stat().st_size == row["size"]:
        return target, "kept"
    part = target.with_suffix(".h5.part")
    request = urllib.request.Request(row["downloadsLink"], headers={"Authorization": f"Bearer {token}"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=300) as res, part.open("wb") as stream:
                pilot.require(res.headers.get("content-type", "").split(";")[0] != "text/html",
                              "LAADS returned an HTML page (token missing, expired or license not accepted)")
                shutil.copyfileobj(res, stream, 4 * 1024 * 1024)
            pilot.require(part.stat().st_size == row["size"], f"{row['name']} size mismatch")
            part.rename(target)
            return target, "downloaded"
        except (OSError, ValueError) as error:
            if attempt == 3:
                raise
            log(f"{row['name']}: retry {attempt + 1} after {type(error).__name__}")
            time.sleep(10 * (attempt + 1))
    raise RuntimeError("unreachable")


def cmd_fetch(args):
    token = read_token(args.token_file)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    keep = granule_filter(args.granules)
    rows = [r for r in listing(args.year) if keep(r["name"])]
    log(f"{len(rows)} granules, {sum(r['size'] for r in rows) / 1e9:.1f} GB for {args.year}")
    receipts = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(download, row, out, token): row for row in rows}
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            row = futures[future]
            path, how = future.result()
            receipts.append({"filename": row["name"], "size": row["size"], "sha256": pilot.sha256(path),
                             "source": row["downloadsLink"], "laads_mtime": row.get("mtime"),
                             "acquired_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                             "how": how})
            if done % 25 == 0:
                log(f"{done}/{len(rows)}")
    receipts.sort(key=lambda r: r["filename"])
    (out / "receipts.json").write_text(json.dumps({
        "schema_version": 1, "product": "VNP46A4", "collection": "002", "year": str(args.year),
        "product_url": pilot.PRODUCT_URL, "doi": DOI, "archives": receipts}, indent=2) + "\n")
    log(f"wrote {out / 'receipts.json'}")
    return 0


def subdataset(path, name):
    return f'HDF5:"{path}"://{GRID}/{name}'


def attribute(ds, band, suffix):
    """HDF5 attributes surface as metadata; GDAL does not always map them to scale/nodata."""
    for metadata in (band.GetMetadata(), ds.GetMetadata()):
        for key, value in metadata.items():
            if key.endswith(suffix):
                try:
                    return float(str(value).split()[0].strip("{},"))
                except ValueError:
                    continue
    return None


def prepare_one(path, out_dir):
    match = NAME.match(Path(path).name)
    h, v = int(match["h"]), int(match["v"])
    target = Path(out_dir) / (Path(path).stem + ".radiance.tif")
    if target.is_file():
        return str(target)
    science = gdal.Open(subdataset(path, SCIENCE))
    quality = gdal.Open(subdataset(path, QUALITY))
    pilot.require(science.RasterXSize == science.RasterYSize == GRANULE_PX, f"{path}: unexpected grid size")
    band = science.GetRasterBand(1)
    raw = band.ReadAsArray().astype(np.float64)
    fill = band.GetNoDataValue()
    if fill is None:
        fill = attribute(science, band, "_FillValue")
    scale = band.GetScale() or attribute(science, band, "scale_factor") or 1.0
    offset = band.GetOffset() or attribute(science, band, "add_offset") or 0.0
    values = raw * scale + offset
    qa = quality.GetRasterBand(1).ReadAsArray()
    rejected = (qa != 0) | ~np.isfinite(values) | (values < 0)
    if fill is not None:
        rejected |= raw == fill
    values = np.where(rejected, NODATA, values).astype(np.float32)
    lon0, lat0, step = -180.0 + 10.0 * h, 90.0 - 10.0 * v, 10.0 / GRANULE_PX
    tmp = target.with_suffix(".part.tif")
    ds = gdal.GetDriverByName("GTiff").Create(str(tmp), GRANULE_PX, GRANULE_PX, 1, gdal.GDT_Float32,
                                              options=["COMPRESS=DEFLATE", "PREDICTOR=3", "TILED=YES"])
    ds.SetGeoTransform((lon0, step, 0.0, lat0, 0.0, -step))
    ds.SetSpatialRef(pilot.srs(4326))
    out = ds.GetRasterBand(1)
    out.WriteArray(values)
    out.SetNoDataValue(NODATA)
    out.SetUnitType(pilot.UNITS)
    ds = None
    tmp.rename(target)
    return str(target)


def cmd_prepare(args):
    archives = sorted(Path(args.archives).glob("VNP46A4.A*.h5"))
    pilot.require(archives, "no VNP46A4 archives found")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers) as pool:
        tifs = list(pool.map(prepare_one, map(str, archives), [str(out)] * len(archives)))
    vrt = out / "mosaic.vrt"
    gdal.BuildVRT(str(vrt), sorted(tifs), srcNodata=NODATA, VRTNodata=NODATA)
    log(f"prepared {len(tifs)} granules -> {vrt}")
    return 0


def lonlat_to_tile(lon, lat, z):
    lat = max(-MAX_LAT, min(MAX_LAT, lat))
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def granule_tiles(vrt_path, z):
    tiles = set()
    for path in gdal.Open(vrt_path).GetFileList()[1:]:
        match = re.search(r"h(\d{2})v(\d{2})", Path(path).name)
        h, v = int(match[1]), int(match[2])
        west, north = -180.0 + 10 * h, 90.0 - 10 * v
        if north - 10 >= MAX_LAT or north <= -MAX_LAT:
            continue
        x0, y0 = lonlat_to_tile(west + 1e-9, north - 1e-9, z)
        x1, y1 = lonlat_to_tile(west + 10 - 1e-9, north - 10 + 1e-9, z)
        tiles.update((x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1))
    return sorted(tiles)


_VRT = None


def _init(vrt_path):
    global _VRT
    gdal.UseExceptions()
    osr.SetPROJEnableNetwork(False)
    _VRT = gdal.Open(vrt_path)


def write_tile(out, work, z, x, y, values):
    valid = values != NODATA
    if not valid.any():
        return False
    directory = Path(out) / str(z) / str(x)
    directory.mkdir(parents=True, exist_ok=True)
    pilot.save_png(pilot.colorize(values), directory / f"{y}.png")
    science = Path(work) / str(z) / str(x)
    science.mkdir(parents=True, exist_ok=True)
    np.save(science / f"{y}.npy", values)
    return True


def render_leaf(task):
    z, x, y, out, work = task
    warped = gdal.Warp("", _VRT, format="MEM", dstSRS="EPSG:3857", outputBounds=pilot.bbox(z, x, y),
                       width=256, height=256, outputType=gdal.GDT_Float32, srcNodata=NODATA,
                       dstNodata=NODATA, resampleAlg="near", errorThreshold=0, multithread=False)
    return write_tile(out, work, z, x, y, warped.GetRasterBand(1).ReadAsArray())


def render_parent(task):
    z, x, y, out, work = task
    block = np.full((512, 512), NODATA, dtype=np.float32)
    for dx in (0, 1):
        for dy in (0, 1):
            child = Path(work) / str(z + 1) / str(2 * x + dx) / f"{2 * y + dy}.npy"
            if child.is_file():
                block[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = np.load(child)
    quads = block.reshape(256, 2, 256, 2).transpose(0, 2, 1, 3).reshape(256, 256, 4)
    valid = quads != NODATA
    counts = valid.sum(axis=2)
    sums = np.where(valid, quads, 0).sum(axis=2, dtype=np.float64)
    values = np.where(counts > 0, sums / np.maximum(counts, 1), NODATA).astype(np.float32)
    return write_tile(out, work, z, x, y, values)


def cmd_render(args):
    out, work = Path(args.out), Path(args.work)
    pilot.require(not out.exists() or not any(out.iterdir()), "output directory must be new or empty")
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    counts = {}
    leaves = granule_tiles(args.vrt, args.max_zoom)
    log(f"z{args.max_zoom}: {len(leaves)} candidate tiles")
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers, initializer=_init,
                                                initargs=(args.vrt,)) as pool:
        tasks = [(args.max_zoom, x, y, str(out), str(work)) for x, y in leaves]
        counts[args.max_zoom] = sum(pool.map(render_leaf, tasks, chunksize=16))
        for z in range(args.max_zoom - 1, -1, -1):
            children = Path(work) / str(z + 1)
            parents = sorted({(int(p.parent.name) // 2, int(p.stem) // 2) for p in children.glob("*/*.npy")})
            tasks = [(z, x, y, str(out), str(work)) for x, y in parents]
            counts[z] = sum(pool.map(render_parent, tasks, chunksize=16))
            log(f"z{z}: {counts[z]} tiles")
    receipts = json.loads(Path(args.receipts).read_text()) if args.receipts else None
    manifest = {
        "schema_version": 1,
        "kind": "darkmap-self-hosted-raster",
        "layer_path": args.layer_path,
        "product": "VNP46A4", "collection": "002", "dataset": SCIENCE, "doi": DOI,
        "attribution": ATTRIBUTION,
        "quality_policy": f"{QUALITY} == 0 kept; other flags, fill, negative and non-finite -> nodata",
        "units": pilot.UNITS,
        "tiling": {"crs": "EPSG:3857", "scheme": "xyz", "size": 256, "min_zoom": 0,
                   "max_zoom": args.max_zoom, "sparse": True,
                   "leaf_resampling": "nearest from native 15 arc-second samples",
                   "parent_resampling": "mean of valid child radiance"},
        "palette": {"id": "pilot-radiance-classes-v1", "units": pilot.UNITS, "stops": pilot.PALETTE},
        "tile_counts": {str(z): counts[z] for z in sorted(counts)},
        "gdal_version": gdal.VersionInfo("RELEASE_NAME"),
        "numpy_version": np.__version__,
        "rendered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "archives": receipts["archives"] if receipts else None,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"wrote {sum(counts.values())} tiles and {out / 'manifest.json'}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("fetch")
    fetch.add_argument("--year", type=int, required=True)
    fetch.add_argument("--out", required=True)
    fetch.add_argument("--token-file", default="")
    fetch.add_argument("--granules", default="", help="comma list like h10v04,h10v05 (default: all)")
    fetch.add_argument("--workers", type=int, default=4)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--archives", required=True)
    prepare.add_argument("--out", required=True)
    prepare.add_argument("--workers", type=int, default=4)
    render = sub.add_parser("render")
    render.add_argument("--vrt", required=True)
    render.add_argument("--out", required=True)
    render.add_argument("--work", required=True)
    render.add_argument("--layer-path", required=True, help="e.g. vnp46a4-002/2019")
    render.add_argument("--receipts", default="")
    render.add_argument("--max-zoom", type=int, default=8)
    render.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    try:
        return {"fetch": cmd_fetch, "prepare": cmd_prepare, "render": cmd_render}[args.command](args)
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as error:
        print(f"pyramid: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
