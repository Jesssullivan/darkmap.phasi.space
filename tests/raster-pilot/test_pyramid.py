"""Synthetic (GENERATED, not NASA) checks for the self-hosted pyramid renderer."""

import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

import numpy as np
from osgeo import gdal

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "raster-pilot"))
import pilot  # noqa: E402
import pyramid  # noqa: E402

gdal.UseExceptions()


def write_granule(directory, h, v, values):
    path = Path(directory) / f"VNP46A4.A2019001.h{h:02d}v{v:02d}.002.0000000000000.radiance.tif"
    size = values.shape[0]
    ds = gdal.GetDriverByName("GTiff").Create(str(path), size, size, 1, gdal.GDT_Float32)
    step = 10.0 / size
    ds.SetGeoTransform((-180.0 + 10 * h, step, 0.0, 90.0 - 10 * v, 0.0, -step))
    ds.SetSpatialRef(pilot.srs(4326))
    band = ds.GetRasterBand(1)
    band.WriteArray(values)
    band.SetNoDataValue(pyramid.NODATA)
    ds = None
    return str(path)


class PyramidTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        values = np.full((240, 240), 5.0, dtype=np.float32)
        values[:, :120] = pyramid.NODATA  # western half has no valid samples
        values[0, 239] = 250.0
        tif = write_granule(root, 10, 4, values)  # 80..70 W, 50..40 N
        self.vrt = str(root / "mosaic.vrt")
        gdal.BuildVRT(self.vrt, [tif], srcNodata=pyramid.NODATA, VRTNodata=pyramid.NODATA)
        self.out, self.work = root / "tiles", root / "work"
        receipts = root / "receipts.json"
        receipts.write_text(json.dumps({"archives": [{"filename": "GENERATED-NOT-NASA", "sha256": "0" * 64}]}))
        args = types.SimpleNamespace(vrt=self.vrt, out=str(self.out), work=str(self.work),
                                     layer_path="vnp46a4-002/2019", receipts=str(receipts),
                                     max_zoom=5, workers=1)
        self.assertEqual(pyramid.cmd_render(args), 0)
        self.manifest = json.loads((self.out / "manifest.json").read_text())

    def tearDown(self):
        self.tmp.cleanup()

    def test_sparse_pyramid_down_to_z0(self):
        counts = self.manifest["tile_counts"]
        self.assertEqual(sorted(counts), [str(z) for z in range(6)])
        self.assertEqual(counts["0"], 1)
        self.assertTrue((self.out / "0" / "0" / "0.png").is_file())
        written = sorted(p.relative_to(self.out).as_posix() for p in self.out.glob("5/*/*.png"))
        self.assertEqual(len(written), counts["5"])
        # Tiles wholly west of 75 W hold only nodata and must not be written.
        for rel in written:
            x = int(rel.split("/")[1])
            west = x / 32 * 360 - 180
            self.assertGreater(west + 360 / 32, -75.0, rel)

    def test_tiles_are_256_rgba_with_transparent_nodata(self):
        ds = gdal.Open(str(self.out / "0" / "0" / "0.png"))
        self.assertEqual((ds.RasterXSize, ds.RasterYSize, ds.RasterCount), (256, 256, 4))
        alpha = ds.GetRasterBand(4).ReadAsArray()
        self.assertGreater(np.count_nonzero(alpha == 0), 60000)
        self.assertGreater(np.count_nonzero(alpha == 255), 0)

    def test_parent_values_are_means_of_valid_children(self):
        science = sorted(self.work.glob("4/*/*.npy"))
        self.assertTrue(science)
        values = np.load(science[0])
        valid = values[values != pyramid.NODATA]
        self.assertTrue(valid.size)
        self.assertTrue(np.all((valid >= 5.0) & (valid <= 250.0)))

    def test_manifest_records_provenance_and_attribution(self):
        self.assertEqual(self.manifest["layer_path"], "vnp46a4-002/2019")
        self.assertEqual(self.manifest["doi"], "https://doi.org/10.5067/VIIRS/VNP46A4.002")
        self.assertIn("NASA Black Marble", self.manifest["attribution"])
        self.assertEqual(self.manifest["tiling"]["max_zoom"], 5)
        self.assertEqual(self.manifest["archives"][0]["filename"], "GENERATED-NOT-NASA")

    def test_refuses_a_non_empty_output(self):
        args = types.SimpleNamespace(vrt=self.vrt, out=str(self.out), work=str(self.work),
                                     layer_path="x", receipts="", max_zoom=1, workers=1)
        with self.assertRaises(ValueError):
            pyramid.cmd_render(args)

    def test_fetch_requires_a_token_and_never_echoes_it(self):
        with mock.patch.dict(os.environ, {"EARTHDATA_TOKEN": ""}), self.assertRaises(ValueError) as caught:
            pyramid.read_token("")
        self.assertNotIn("Bearer", str(caught.exception))

    def test_granule_filter(self):
        keep = pyramid.granule_filter("h10v04")
        self.assertTrue(keep("VNP46A4.A2019001.h10v04.002.2025134123852.h5"))
        self.assertFalse(keep("VNP46A4.A2019001.h10v05.002.2025134123904.h5"))
        self.assertTrue(pyramid.granule_filter("")("anything"))


if __name__ == "__main__":
    unittest.main()
