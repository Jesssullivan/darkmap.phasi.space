"""Offline, bounded scientific COG -> two XYZ tiles. No network or app imports."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, urlparse

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
HALF_EQUATOR_M = 20037508.342789244
TILES = ((8, 74, 96), (7, 37, 48))
UNITS = "nW cm-2 sr-1"
PRODUCT_URL = "https://ladsweb.modaps.eosdis.nasa.gov/missions-and-measurements/products/VNP46A4/"
# Deliberately a pilot palette in physical units, NOT the upstream byte SLD.
PALETTE = ((0.0, (0, 0, 0)), (0.1, (5, 22, 55)), (1.0, (32, 153, 143)),
           (10.0, (255, 255, 0)), (100.0, (176, 0, 18)))


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def has_text(value):
    return isinstance(value, str) and bool(value.strip())


def check_file(path, expected, label):
    path = Path(path)
    require(path.is_file(), f"missing {label}: {path}")
    require(isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected),
            f"{label} needs a received-byte SHA-256; placeholders are invalid")
    require(sha256(path) == expected, f"{label} SHA-256 mismatch")


def bbox(z, x, y):
    span = 2 * HALF_EQUATOR_M / (2 ** z)
    left = -HALF_EQUATOR_M + x * span
    top = HALF_EQUATOR_M - y * span
    return (left, top - span, left + span, top)


def srs(code):
    value = osr.SpatialReference()
    value.ImportFromEPSG(code)
    value.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return value


def validate_input(manifest, input_path, archive_path=""):
    require(isinstance(manifest, dict), "input manifest must be a JSON object")
    require(manifest.get("schema_version") == 1, "unsupported scientific input manifest")
    kind = manifest.get("kind")
    require(kind in ("synthetic-scientific-fixture", "nasa-black-marble"), "unsupported input kind")
    semantics = "measured-nighttime-radiance" if kind == "nasa-black-marble" else "synthetic-radiance"
    require(manifest.get("semantics") == semantics, "wrong scientific semantics")
    require(manifest.get("units") == UNITS, "input must use physical radiance units")
    require(manifest.get("scale") == 1 and manifest.get("offset") == 0,
            "COG must already contain physical values; packed integers are unsupported")
    require(manifest.get("nodata") == -9999, "explicit -9999 nodata is required")
    quality = manifest.get("quality")
    require(isinstance(quality, dict) and quality.get("policy") == "rejected-to-nodata",
            "quality rejection must be applied before the cropped COG handoff")
    require(has_text(quality.get("receipt")),
            "quality receipt is required")
    require(manifest.get("input_filename") == Path(input_path).name, "input filename mismatch")
    check_file(input_path, manifest.get("input_sha256"), "cropped scientific COG")
    require(has_text(manifest.get("provenance")), "provenance receipt is required")
    if kind == "nasa-black-marble":
        require(manifest.get("product") == "VNP46A4" and manifest.get("collection") == "002",
                "pilot requires VNP46A4 collection 002")
        require(manifest.get("dataset") == "AllAngle_Composite_Snow_Free", "wrong science dataset")
        require(manifest.get("product_url") == PRODUCT_URL, "wrong product authority")
        require(manifest.get("acquisition") == "2019", "pilot is restricted to annual 2019")
        name = manifest.get("archive_filename", "")
        require(isinstance(name, str) and
                re.fullmatch(r"VNP46A4\.A2019001\.h\d{2}v\d{2}\.002\.\d{13}\.h5", name),
                "exact collection-002 annual-2019 archive filename is required")
        require(archive_path and Path(archive_path).name == name, "supply the received original archive")
        check_file(archive_path, manifest.get("archive_sha256"), "original NASA archive")
        archive = gdal.Open(str(archive_path), gdal.GA_ReadOnly)
        require(archive.GetDriver().ShortName == "HDF5", "original archive must be HDF5")
        datasets = [name.rsplit("/", 1)[-1] for name, _ in archive.GetSubDatasets()]
        require(manifest["dataset"] in datasets and
                "AllAngle_Composite_Snow_Free_Quality" in datasets,
                "archive must contain the science dataset and matching quality dataset")
        require(has_text(manifest.get("acquired_at")), "actual acquisition receipt is required")
        require(quality.get("dataset") == "AllAngle_Composite_Snow_Free_Quality",
                "record the matching quality dataset")
        require(quality.get("accepted_values") == [0], "pilot accepts only good-quality flag 0")
    else:
        require(manifest.get("product") == "GENERATED-NOT-NASA", "fixture must say GENERATED-NOT-NASA")
        require(not archive_path, "synthetic fixture must not bind a NASA archive")

    ds = gdal.Open(str(input_path), gdal.GA_ReadOnly)
    require(ds.GetDriver().ShortName == "GTiff", "input must be a GeoTIFF COG")
    require(ds.GetMetadata("IMAGE_STRUCTURE").get("LAYOUT") == "COG", "input must declare COG layout")
    require(ds.RasterCount == 1, "input must contain exactly one science band")
    require(0 < ds.RasterXSize <= 4096 and 0 < ds.RasterYSize <= 4096,
            "pilot requires a bounded crop no larger than 4096 x 4096")
    band = ds.GetRasterBand(1)
    require(band.DataType == gdal.GDT_Float32, "science crop must contain physical Float32 values")
    require(band.GetNoDataValue() == -9999, "band nodata mismatch")
    require(band.GetScale() in (None, 1) and band.GetOffset() in (None, 0), "band still has packed scaling")
    require(band.GetUnitType() == UNITS, "band radiance units mismatch")
    require(ds.GetSpatialRef() is not None, "missing CRS")
    declared = osr.SpatialReference()
    require(has_text(manifest.get("crs")), "missing manifest CRS")
    require(declared.SetFromUserInput(manifest.get("crs", "")) == 0, "invalid manifest CRS")
    declared.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    require(bool(ds.GetSpatialRef().IsSame(declared)), "manifest and COG CRS differ")
    transform = ds.GetGeoTransform()
    require(transform[1] > 0 and transform[5] < 0 and transform[2] == transform[4] == 0,
            "crop must be north-up with an explicit affine transform")
    values = band.ReadAsArray()
    require(np.isfinite(values).all(), "NaN/infinity must be normalized to nodata before handoff")
    require(np.all((values == -9999) | (values >= 0)), "negative radiance must be normalized to nodata")
    return ds


def warp_science(ds, tile):
    # Match RasterClient's XYZ bbox, 256 pixels, EPSG:3857; nearest preserves
    # measured sample values. No smoothing or scientific-to-byte conversion.
    out = gdal.Warp("", ds, format="MEM", dstSRS="EPSG:3857", outputBounds=bbox(*tile),
                    width=256, height=256, outputType=gdal.GDT_Float32,
                    srcNodata=-9999, dstNodata=-9999, resampleAlg="near",
                    errorThreshold=0, multithread=False, warpOptions=["NUM_THREADS=1"])
    out.GetRasterBand(1).SetUnitType(UNITS)
    return out


def colorize(values):
    valid = np.isfinite(values) & (values != -9999)
    thresholds = np.array([item[0] for item in PALETTE])
    classes = np.clip(np.searchsorted(thresholds, values, side="right") - 1, 0, len(PALETTE) - 1)
    colors = np.array([item[1] for item in PALETTE], dtype=np.uint8)
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    rgba[valid, :3] = colors[classes[valid]]
    rgba[valid, 3] = 255
    return rgba


def save_png(rgba, path):
    memory = gdal.GetDriverByName("MEM").Create("", 256, 256, 4, gdal.GDT_Byte)
    for i, role in enumerate((gdal.GCI_RedBand, gdal.GCI_GreenBand, gdal.GCI_BlueBand, gdal.GCI_AlphaBand)):
        band = memory.GetRasterBand(i + 1)
        band.WriteArray(rgba[:, :, i])
        band.SetColorInterpretation(role)
    gdal.GetDriverByName("PNG").CreateCopy(str(path), memory, options=["ZLEVEL=9"])


def read_png(path):
    ds = gdal.Open(str(path), gdal.GA_ReadOnly)
    require(ds.GetDriver().ShortName == "PNG" and
            ds.RasterXSize == ds.RasterYSize == 256, "reference must be a 256 x 256 PNG")
    require(all(ds.GetRasterBand(i).DataType == gdal.GDT_Byte for i in range(1, ds.RasterCount + 1)),
            "reference must use 8-bit channels")
    raw = ds.ReadAsArray()
    if ds.RasterCount == 1 and ds.GetRasterBand(1).GetColorTable():
        table = ds.GetRasterBand(1).GetColorTable()
        return np.array([table.GetColorEntry(i) for i in range(table.GetCount())], dtype=np.uint8)[raw]
    rgba = np.full((256, 256, 4), 255, dtype=np.uint8)
    if ds.RasterCount == 1:
        rgba[:, :, :3] = raw[:, :, None]
    elif ds.RasterCount == 2:
        rgba[:, :, :3] = raw[0, :, :, None]
        rgba[:, :, 3] = raw[1]
    elif ds.RasterCount in (3, 4):
        rgba[:, :, :ds.RasterCount] = np.moveaxis(raw, 0, -1)
    else:
        raise ValueError("unsupported reference PNG bands")
    return rgba


def compare_pixels(candidate, reference):
    ca, ra = candidate[:, :, 3], reference[:, :, 3]
    both = (ca > 0) & (ra > 0)
    delta = np.abs(candidate[:, :, :3].astype(np.int16) - reference[:, :, :3].astype(np.int16))
    return {
        "pixels": 65536,
        "alpha_mismatch_pixels": int(np.count_nonzero(ca != ra)),
        "shared_visible_pixels": int(np.count_nonzero(both)),
        "rgb_mismatch_pixels": int(np.count_nonzero(both & np.any(delta > 0, axis=2))),
        "mean_absolute_channel_error_shared_visible": float(delta[both].mean()) if both.any() else None,
        "max_channel_error_shared_visible": int(delta[both].max()) if both.any() else None,
        "acceptance": "operator-review-required; palette is not verified against upstream SLD",
    }


def validate_reference_url(url, tile):
    require(has_text(url), "upstream reference needs its exact WMS request URL")
    parsed = urlparse(url)
    require(parsed.scheme == "https" and parsed.netloc == "www2.lightpollutionmap.info" and
            parsed.path == "/geoserver/gwc/service/wms" and not parsed.fragment,
            "reference URL must identify the current public WMS endpoint")
    query = parse_qs(parsed.query)
    expected = {"service": "WMS", "version": "1.1.1", "request": "GetMap",
                "layers": "PostGIS:VIIRS_2019", "format": "image/png",
                "transparent": "true", "srs": "EPSG:3857", "width": "256", "height": "256"}
    require(all(query.get(key) == [value] for key, value in expected.items()),
            "reference WMS request parameters mismatch")
    require(set(query) <= set(expected) | {"bbox", "styles"}, "unexpected reference URL parameters")
    require(query.get("styles", [""]) == [""], "reference must use the default upstream style")
    require(len(query.get("bbox", [])) == 1, "reference URL needs one bbox")
    require([float(value) for value in query["bbox"][0].split(",")] == list(bbox(*tile)),
            "reference WMS URL bbox mismatch")


def render(manifest_path, input_path, output_path, archive_path="", reference_path=""):
    manifest = json.loads(Path(manifest_path).read_text())
    ds = validate_input(manifest, input_path, archive_path)
    # Refuse an existing destination to preserve previous evidence; missing input
    # and checksum failures happen before creating any output directory.
    output = Path(output_path)
    require(not output.exists(), "output directory already exists; choose a fresh destination")
    reference = None
    if reference_path:
        reference = json.loads(Path(reference_path).read_text())
        require(isinstance(reference, dict), "reference manifest must be a JSON object")
        require(reference.get("kind") in ("upstream-wms-capture", "synthetic-fixture"),
                "reference must identify acquired upstream bytes or a synthetic fixture")
        require(reference.get("layer") == "PostGIS:VIIRS_2019", "wrong reference layer")
        require(has_text(reference.get("captured_at")), "reference needs acquisition time")
        require(reference.get("crs") == "EPSG:3857", "reference CRS must be EPSG:3857")
        for tile in TILES:
            key = "/".join(map(str, tile))
            item = reference.get("tiles", {}).get(key, {})
            if reference["kind"] == "upstream-wms-capture":
                validate_reference_url(item.get("request_url"), tile)
            require(item.get("bbox") == list(bbox(*tile)), "reference bbox mismatch")
            require(item.get("width") == item.get("height") == 256, "reference size mismatch")
            local = Path(reference_path).parent / item.get("filename", "")
            check_file(local, item.get("sha256"), "reference PNG")
            read_png(local)
    receipt = {
        "schema_version": 1,
        "kind": manifest["kind"],
        "input": manifest,
        "input_geometry": {"size": [ds.RasterXSize, ds.RasterYSize],
                           "geotransform": ds.GetGeoTransform(), "crs_wkt": ds.GetProjection(),
                           "band_dtype": "Float32", "band_units": ds.GetRasterBand(1).GetUnitType()},
        "manifest_sha256": sha256(manifest_path),
        "gdal_version": gdal.VersionInfo("RELEASE_NAME"),
        "numpy_version": np.__version__,
        "resampling": "nearest; exact transformer; one thread",
        "output_crs": "EPSG:3857",
        "scientific_dtype": "Float32",
        "palette": {"id": "pilot-radiance-classes-v1", "units": UNITS, "stops": PALETTE,
                    "upstream_style_verified": False},
        "reference": reference,
        "reference_manifest_sha256": sha256(reference_path) if reference else None,
        "tiles": [],
        "runtime_switch": False,
        "actual_nasa_data": manifest["kind"] == "nasa-black-marble",
    }
    science_tiles = [warp_science(ds, tile) for tile in TILES]
    require(all(np.any(science.ReadAsArray() != -9999) for science in science_tiles),
            "crop has no valid scientific samples in a requested pilot tile")
    output.mkdir(parents=True)
    for tile, science in zip(TILES, science_tiles):
        key = "/".join(map(str, tile))
        directory = output / str(tile[0]) / str(tile[1])
        directory.mkdir(parents=True, exist_ok=True)
        values = science.ReadAsArray()
        rgba = colorize(values)
        png = directory / f"{tile[2]}.png"
        tif = directory / f"{tile[2]}.science.tif"
        save_png(rgba, png)
        gdal.GetDriverByName("GTiff").CreateCopy(str(tif), science,
            options=["COMPRESS=DEFLATE", "PREDICTOR=3", "NUM_THREADS=1"])
        valid = values[values != -9999]
        row = {"xyz": list(tile), "bbox": list(bbox(*tile)), "size": [256, 256],
               "png_sha256": sha256(png), "science_sha256": sha256(tif),
               "valid_pixels": int(valid.size), "nodata_pixels": int(values.size - valid.size),
               "radiance_min": float(valid.min()) if valid.size else None,
               "radiance_max": float(valid.max()) if valid.size else None,
               "parity": "not-compared; no received upstream reference"}
        if reference:
            ref = Path(reference_path).parent / reference["tiles"][key]["filename"]
            row["parity"] = compare_pixels(rgba, read_png(ref))
        receipt["tiles"].append(row)
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("manifest", "input", "output"):
        parser.add_argument("--" + field, required=True)
    parser.add_argument("--archive", default="")
    parser.add_argument("--reference", default="")
    args = parser.parse_args()
    try:
        result = render(args.manifest, args.input, args.output, args.archive, args.reference)
        print(json.dumps({"kind": result["kind"], "tiles": len(result["tiles"]),
                          "receipt": str(Path(args.output) / "receipt.json")}))
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as error:
        print(f"raster-pilot: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
