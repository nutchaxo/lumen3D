"""Every tracking source yields the same tracks.json AND a model.glb surface.

Synthetic population (a dome of cells drifting over three frames) attached through the
three routes of tracking_sources / 5-tracking_importer:
  * Scene8 Spots/Tracks inside the .ims          (resolve -> container + rebuilt .glb)
  * the Imaris statistics workbook beside it     (resolve -> container + rebuilt .glb)
  * an .imaris_track container exported without its .glb (importer rebuilds model.glb)
and checks that tracks.json is identical, that each dataset gets a model.glb in the layout
the tracking-surface plugin reads (stab_/raw_ [_interp] _tp_<t> nodes, _DENSITY), that the
three surfaces are byte-identical meshes (deterministic reconstruction), that a container's
own exported .glb is still copied as is, and that a Scene8 object stored in mm gives the
same tracks as the one stored in um.

Needs pandas (the lab's Analysis.py). Run: python tests/test_v3_track_surfaces.py
"""
import importlib.util
import json
import os
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"
sys.path.insert(0, str(PRE))
sys.path.insert(0, str(ROOT / "tests"))

try:
    import pandas  # noqa: F401
except ImportError:
    print("SKIP test_v3_track_surfaces: pandas is not installed (the tracking analysis needs it)")
    sys.exit(0)

os.environ.setdefault("LUMEN3D_TRACKING_WORKERS", "2")

import tracking_sources as ts  # noqa: E402
from test_v3_track_units import population, workbook_rows, write_scene8  # noqa: E402


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


IMP = _load("v3_track_importer_surf", "5-tracking_importer.py")


def read_glb(path):
    blob = Path(path).read_bytes()
    magic, version, total = struct.unpack_from("<4sII", blob, 0)
    assert magic == b"glTF" and version == 2 and total == len(blob)
    jlen, jtype = struct.unpack_from("<I4s", blob, 12)
    assert jtype == b"JSON"
    gltf = json.loads(blob[20:20 + jlen])
    blen, btype = struct.unpack_from("<I4s", blob, 20 + jlen)
    assert btype == b"BIN\x00"
    return gltf, blob[28 + jlen:28 + jlen + blen]


def make_dataset(root: Path) -> Path:
    root.mkdir(parents=True)
    (root / "metadata.json").write_text(json.dumps({
        "type": "live", "id": "live/" + root.name,
        "acquisitionExtentUm": {"min": [0.0, 0.0, 0.0], "max": [200.0, 200.0, 120.0]},
    }), encoding="utf-8")
    return root


def tracks_core(dataset: Path) -> dict:
    doc = json.loads((dataset / "tracks.json").read_text(encoding="utf-8"))
    return {"timepoints": doc["timepoints"], "cells": doc["cells"], "layout": doc.get("layout")}


class ThreeRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        cls.rows = population(n_cells=40, n_frames=3)
        out = {}

        # 1. Scene8 inside the volume
        d1 = base / "scene8"
        d1.mkdir()
        ims1 = write_scene8(d1 / "Embryo.ims", cls.rows)
        container, source, glb = ts.resolve(ims1, d1 / "work", "Embryo", verbose=False)
        assert source.kind == "scene8" and glb is not None
        out["scene8"] = IMP.import_tracking(container, make_dataset(base / "ds_scene8"))

        # 2. the statistics workbook beside a volume without Scene8 objects
        d2 = base / "excel"
        d2.mkdir()
        import h5py
        with h5py.File(d2 / "Embryo.ims", "w") as f:
            f.create_group("DataSetInfo/Image").attrs["Unit"] = b"um"
        (d2 / "Embryo.xlsx").write_bytes(b"")
        sheet = workbook_rows(cls.rows)
        with mock.patch.object(ts, "_read_workbook", lambda p: iter([("Position", sheet)])):
            container, source, glb = ts.resolve(d2 / "Embryo.ims", d2 / "work", "Embryo",
                                                verbose=False)
        assert source.kind == "excel" and glb is not None
        out["excel"] = IMP.import_tracking(container, make_dataset(base / "ds_excel"))

        # 3. a container exported without its .glb
        d3 = base / "container"
        d3.mkdir()
        doc = ts.build_container(ts.read_scene8(ims1), "Embryo", verbose=False)
        doc["data"].pop("provenance")  # as the tracking pipeline writes it
        container = ts.write_container(doc, d3 / "Embryo.imaris_track")
        out["container"] = IMP.import_tracking(container, make_dataset(base / "ds_container"))

        cls.base, cls.meta = base, out

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def ds(self, route):
        return self.base / f"ds_{route}"

    def test_tracks_are_identical(self):
        ref = tracks_core(self.ds("scene8"))
        self.assertEqual(len(ref["cells"]), 40)
        self.assertEqual(ref["timepoints"], [1.0, 2.0, 3.0])
        for route in ("excel", "container"):
            self.assertEqual(tracks_core(self.ds(route)), ref, route)
        regions = {c["region"] for c in ref["cells"].values()}
        self.assertEqual(regions, {"Anterior", "Posterior"})

    def test_every_route_has_a_surface(self):
        for route, meta in self.meta.items():
            with self.subTest(route=route):
                self.assertEqual(meta["tracking"]["surfacePath"], "model.glb")
                self.assertEqual(meta["tracking"]["surfaceOrigin"], "reconstructed")
                gltf, _ = read_glb(self.ds(route) / "model.glb")
                names = {n["name"] for n in gltf["nodes"]}
                for t in ("1_0", "2_0", "3_0"):
                    self.assertIn(f"stab_tp_{t}", names)
                    self.assertIn(f"raw_tp_{t}", names)
                self.assertTrue(any(n.startswith("stab_interp_tp_") for n in names))
                self.assertTrue(all("_DENSITY" in m["primitives"][0]["attributes"]
                                    for m in gltf["meshes"]))
                self.assertEqual(gltf["scenes"][0]["extras"]["track_data"]["signature"],
                                 "IMARIS_TRACKER_V1")
                self.assertTrue(meta["tracking"]["alignment"]["aligned"])

    def test_surfaces_are_deterministic_and_route_independent(self):
        ref_json, ref_bin = read_glb(self.ds("scene8") / "model.glb")
        for route in ("excel", "container"):
            gltf, binary = read_glb(self.ds(route) / "model.glb")
            self.assertEqual(binary, ref_bin, route)
            self.assertEqual([n["name"] for n in gltf["nodes"]],
                             [n["name"] for n in ref_json["nodes"]])
            self.assertEqual(gltf["accessors"], ref_json["accessors"])

    def test_raw_and_stabilised_meshes_follow_their_coordinates(self):
        gltf, _ = read_glb(self.ds("scene8") / "model.glb")
        tracks = json.loads((self.ds("scene8") / "tracks.json").read_text(encoding="utf-8"))
        for node in gltf["nodes"]:
            if node["name"] not in ("raw_tp_3_0", "stab_tp_3_0"):
                continue
            key = "raw_positions" if node["name"].startswith("raw") else "positions"
            pts = [c[key]["3"] for c in tracks["cells"].values() if "3" in c[key]]
            acc = gltf["accessors"][gltf["meshes"][node["mesh"]]["primitives"][0]["attributes"]["POSITION"]]
            for axis in range(3):
                lo = min(p[axis] for p in pts)
                hi = max(p[axis] for p in pts)
                # mesh vertices are cell positions (plus midpoints): inside the cells' box
                self.assertGreaterEqual(acc["min"][axis], lo - 1e-3)
                self.assertLessEqual(acc["max"][axis], hi + 1e-3)

    def test_exported_glb_is_copied_untouched(self):
        d4 = self.base / "exported"
        d4.mkdir()
        doc = ts.load_document(self.base / "container" / "Embryo.imaris_track")
        container = ts.write_container(doc, d4 / "Embryo.imaris_track")
        shutil.copy2(self.ds("scene8") / "model.glb", d4 / "Embryo.glb")
        meta = IMP.import_tracking(container, make_dataset(self.base / "ds_exported"))
        self.assertEqual(meta["tracking"]["surfaceOrigin"], "exported")
        self.assertEqual((self.base / "ds_exported" / "model.glb").read_bytes(),
                         (d4 / "Embryo.glb").read_bytes())

    def test_mm_object_gives_the_same_tracks(self):
        d5 = self.base / "mm"
        d5.mkdir()
        ims = write_scene8(d5 / "Embryo.ims", self.rows, factor=1e3, object_unit="mm",
                           image_unit="mm")
        doc_mm = ts.build_container(ts.read_scene8(ims), "Embryo", verbose=False)
        doc_um = ts.build_container(ts.read_scene8(self.base / "scene8" / "Embryo.ims"),
                                    "Embryo", verbose=False)
        self.assertEqual(doc_mm["data"]["provenance"]["unit"]["status"], "converted")
        cells_mm = {c["id"]: c for c in doc_mm["data"]["cells"]}
        self.assertEqual(len(cells_mm), len(doc_um["data"]["cells"]))
        for c in doc_um["data"]["cells"]:
            m = cells_mm[c["id"]]
            self.assertEqual(m["t"], c["t"])
            for key in ("x", "y", "z", "x_raw", "y_raw", "z_raw"):
                for a, b in zip(m[key], c[key]):
                    self.assertAlmostEqual(a, b, delta=1e-3)


class CellIdentity(unittest.TestCase):
    def test_count_more_than_doubling_in_one_frame(self):
        """1 cell then 3 spots on the same track: one division plus one parentless newcomer
        (this used to raise TypeError and drop the whole tracking)."""
        rows = [{"cell_id": 1, "timepoint": 1.0, "x": 10.0, "y": 10.0, "z": 10.0, "track_id": 7, "region": "A"},
                {"cell_id": 2, "timepoint": 2.0, "x": 11.0, "y": 10.0, "z": 10.0, "track_id": 7, "region": "A"},
                {"cell_id": 3, "timepoint": 2.0, "x": 13.0, "y": 10.0, "z": 10.0, "track_id": 7, "region": "A"},
                {"cell_id": 4, "timepoint": 2.0, "x": 40.0, "y": 10.0, "z": 10.0, "track_id": 7, "region": "A"}]
        doc = ts.build_container({"rows": rows, "provenance": {}}, "x", verbose=False)
        cells = {c["id"]: c for c in doc["data"]["cells"]}
        self.assertEqual(len(cells), 4)
        mother = next(c for c in cells.values() if c["daughter_cells"])
        self.assertEqual(len(mother["daughter_cells"].split("/")), 2)
        orphans = [c for c in cells.values() if c["t"] == [2.0] and not c["parent_cell"]]
        self.assertEqual(len(orphans), 1)


if __name__ == "__main__":
    unittest.main()
