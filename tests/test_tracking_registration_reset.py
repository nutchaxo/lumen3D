"""A re-imported tracking never inherits the registration of the analysis it replaces.

A timelapse first published with an analysis carrying raw coordinates holds a
`registration` block (`appliedToVolume: true`, per-timepoint transforms). Re-processing it
with an analysis that has neither raw coordinates nor declared transforms must leave no
such block behind: neither the importer itself, nor step 4's merge with the published
metadata, nor the publish-time re-merge may bring the old transforms back.

Run: python tests/test_tracking_registration_reset.py
"""
import gzip
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"
sys.path.insert(0, str(PRE))

try:
    import numpy  # noqa: F401
except ImportError:
    print("SKIP test_tracking_registration_reset: numpy is not installed")
    sys.exit(0)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


IMP = _load("lumen_test_reg_reset_importer", "5-tracking_importer.py")
RUN = _load("lumen_test_reg_reset_run", "run_preprocess.py")
CATALOG = _load("lumen_test_reg_reset_catalog", "4-catalog_generator.py")

EXTENT = {"min": [0.0, 0.0, 0.0], "max": [200.0, 200.0, 120.0]}
OLD_REGISTRATION = {
    "method": "kabsch-from-tracks",
    "appliedToVolume": True,
    "coordinateSpace": "stabilized",
    "transforms": [{"index": 0, "t": 1.0,
                    "matrix": [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}],
    "imageBoxUnionUm": {"min": [0, 0, 0], "max": [205, 200, 120], "basis": "acquisition"},
    "qcSummary": {"rigid": True, "timepointsSolved": 1, "timepointsTotal": 1,
                  "maxResidualUm": 0.0, "warnings": []},
}


def _cells(with_raw: bool):
    cells = []
    for i in range(6):
        x, y, z = 20.0 + 25 * i, 30.0 + 20 * i, 10.0 + 15 * i
        cell = {"id": i + 1, "track_id": 1000 + i, "region": "A", "color": "#ff0000",
                "t": [1, 2], "x": [x, x + 1], "y": [y, y + 1], "z": [z, z + 1]}
        if with_raw:
            cell.update({"x_raw": [x + 3, x + 4], "y_raw": [y, y + 1], "z_raw": [z, z + 1]})
        cells.append(cell)
    return cells


def _container(path: Path, with_raw: bool) -> Path:
    doc = {"signature": IMP.SIGNATURE, "dataset_name": "Embryo",
           "data": {"timepoints": [1, 2], "cells": _cells(with_raw)}}
    with gzip.open(str(path), "wb") as fh:
        fh.write(IMP.SIGNATURE.encode() + b"\n")
        fh.write(json.dumps(doc).encode("utf-8"))
    return path


def _viewer_accepts(reg) -> bool:
    """viewer.js `_dropMalformedBlocks`: a registration that fails this is logged as a
    malformed block and dropped."""
    if not isinstance(reg, dict):
        return False
    rows = reg.get("transforms")
    return rows is None or (isinstance(rows, list) and all(
        isinstance(r, dict) and isinstance(r.get("index"), int)
        and isinstance(r.get("matrix"), list) and len(r["matrix"]) == 16 for r in rows))


def _viewer_stabilises(reg) -> bool:
    """viewer.js `_initStabilization`: transforms present and applicable to the volume."""
    return bool(reg and reg.get("transforms") and reg.get("appliedToVolume"))


def _published_metadata(name: str) -> dict:
    return {"type": "live", "id": "live/" + name, "name": name,
            "acquisitionExtentUm": EXTENT,
            "dimensions": {"x": 64, "y": 64, "z": 32, "c": 1, "t": 2},
            "tracking": {"schema": "iribhm-tracks-v1", "source": "Old.imaris_track",
                         "tracksPath": "tracks.json", "hasRawCoordinates": True},
            "registration": OLD_REGISTRATION}


class RegistrationReset(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _dataset(self, name="ds") -> Path:
        ds = self.base / name
        ds.mkdir()
        (ds / "metadata.json").write_text(json.dumps(_published_metadata(name)),
                                          encoding="utf-8")
        return ds

    def test_analysis_without_raw_coordinates_clears_the_old_registration(self):
        ds = self._dataset()
        meta = IMP.import_tracking(_container(self.base / "New.imaris_track", False), ds,
                                   write_gzip=False, build_surface=False)
        self.assertIn("registration", meta)
        self.assertEqual(meta["registration"], IMP.no_registration())
        on_disk = json.loads((ds / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk["registration"], IMP.no_registration())
        self.assertTrue(_viewer_accepts(on_disk["registration"]))
        self.assertFalse(_viewer_stabilises(on_disk["registration"]))
        self.assertEqual(on_disk["tracking"]["source"], "New.imaris_track")
        self.assertFalse(on_disk["tracking"]["hasRawCoordinates"])

    def test_analysis_with_raw_coordinates_replaces_the_old_registration(self):
        ds = self._dataset()
        meta = IMP.import_tracking(_container(self.base / "New.imaris_track", True), ds,
                                   write_gzip=False, build_surface=False)
        reg = meta["registration"]
        self.assertIsInstance(reg, dict)
        self.assertNotEqual(reg.get("transforms"), OLD_REGISTRATION["transforms"])
        self.assertEqual(len(reg["transforms"]), 2)

    def test_reprocessing_merges_keep_the_cleared_registration(self):
        # Step 4 of the re-run: the published file is merged into the freshly measured one.
        published = _published_metadata("ds")
        fresh = {k: v for k, v in published.items() if k not in ("tracking", "registration")}
        staged = CATALOG.merge_volume_metadata(published, fresh)
        self.assertEqual(staged["registration"], OLD_REGISTRATION)

        # Step 6 imports the new analysis into the staged tree.
        stage_dir = self.base / "stage"
        stage_dir.mkdir()
        (stage_dir / "metadata.json").write_text(json.dumps(staged), encoding="utf-8")
        IMP.import_tracking(_container(self.base / "New.imaris_track", False), stage_dir,
                            write_gzip=False, build_surface=False)

        # Publish re-merges the published file into the staged one at the last moment.
        final_dir = self._dataset("final")
        RUN._merge_with_published(stage_dir, final_dir)
        result = json.loads((stage_dir / "metadata.json").read_text(encoding="utf-8"))
        self.assertIn("registration", result)
        self.assertEqual(result["registration"], IMP.no_registration())
        self.assertEqual(result["tracking"]["source"], "New.imaris_track")


if __name__ == "__main__":
    unittest.main(verbosity=2)
