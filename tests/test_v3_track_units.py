"""Tracking positions are brought to micrometres exactly like the volume extent.

Covers (numpy + h5py only, no pandas):
  * tracking_sources uses the very UNIT_TO_UM table of 1-ims_metadata.py;
  * Scene8 spots in um / mm / nm / m are converted (p_um = p_file * factor), the
    object's own Unit wins over the image's, an absent Unit is assumed um (as the
    extent is) and an unknown one is left unconverted and reported;
  * the statistics workbook: per-row Unit column (um, µm, mm, nm, m, unknown, mixed),
    a sheet without one takes the volume's unit, else is assumed um;
  * the importer's alignment check finds tracks that do not sit in the acquisition box
    and names the unit that would put them there.

Run: python -m unittest tests.test_v3_track_units
"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    import numpy as np
    import h5py  # noqa: F401  (tracking_sources reads .ims through it)
except ImportError as exc:  # the pipeline's own Python has them; CI installs them
    print(f"SKIP test_v3_track_units: {exc}")
    sys.exit(0)

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"
sys.path.insert(0, str(PRE))
import tracking_sources as ts  # noqa: E402


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


IMP = _load("v3_track_importer", "5-tracking_importer.py")


def _attr(text):
    return np.array([bytes([b]) for b in str(text).encode("utf-8")], dtype="S1")


def population(n_cells=12, n_frames=2):
    """Spots of a dome-shaped population (um), one track per cell, on a 1/64 um grid so
    float32 storage is exact."""
    rng = np.random.default_rng(7)
    theta = rng.uniform(0, 2 * np.pi, n_cells)
    phi = rng.uniform(0.1, 1.2, n_cells)
    base = np.stack([100 + 60 * np.sin(phi) * np.cos(theta),
                     100 + 60 * np.sin(phi) * np.sin(theta),
                     20 + 60 * np.cos(phi)], axis=1)
    rows = []
    for t in range(n_frames):
        for i in range(n_cells):
            p = np.round((base[i] + [2.0 * t, -1.0 * t, 0.5 * t]) * 64) / 64
            rows.append({"spot": 1 + t * 1000 + i, "frame": t, "track": 1_000_000_001 + i,
                         "x": float(p[0]), "y": float(p[1]), "z": float(p[2]),
                         "region": "Anterior" if i % 2 else "Posterior"})
    return rows


def write_scene8(path, rows, factor=1.0, object_unit="um", image_unit="um", radius_um=3.0):
    """A Scene8 Spots object in Imaris' own layout, positions stored as p_um / factor."""
    import h5py
    rows = sorted(rows, key=lambda r: (r["frame"], r["spot"]))
    frames = sorted({r["frame"] for r in rows})
    tracks = sorted({r["track"] for r in rows})
    with h5py.File(path, "w") as f:
        img = f.create_group("DataSetInfo/Image")
        if image_unit is not None:
            img.attrs["Unit"] = _attr(image_unit)
        g = f.create_group("Scene8/Content/Points0")
        g.attrs["Name"] = _attr("Spots 1")
        if object_unit is not None:
            g.attrs["Unit"] = _attr(object_unit)
        spot_dt = np.dtype([("ID", "<i8"), ("PositionX", "<f4"), ("PositionY", "<f4"),
                            ("PositionZ", "<f4"), ("Radius", "<f4")])
        g.create_dataset("Spot", data=np.array(
            [(r["spot"], r["x"] / factor, r["y"] / factor, r["z"] / factor, radius_um / factor)
             for r in rows], dtype=spot_dt))
        off_dt = np.dtype([("ID", "<i8"), ("IndexBegin", "<i8"), ("IndexEnd", "<i8")])
        offsets, begin = [], 0
        for fr in frames:
            n = sum(1 for r in rows if r["frame"] == fr)
            offsets.append((fr, begin, begin + n))
            begin += n
        g.create_dataset("SpotTimeOffset", data=np.array(offsets, dtype=off_dt))
        tr_dt = np.dtype([("ID", "<i8"), ("IndexTrackObjectBegin", "<i8"),
                          ("IndexTrackObjectEnd", "<i8"), ("IndexTrackEdgeBegin", "<i8"),
                          ("IndexTrackEdgeEnd", "<i8")])
        objs, track_rows = [], []
        for tid in tracks:
            members = [r["spot"] for r in rows if r["track"] == tid]
            track_rows.append((tid, len(objs), len(objs) + len(members), 0, 0))
            objs.extend(members)
        g.create_dataset("Track0", data=np.array(track_rows, dtype=tr_dt))
        g.create_dataset("TrackObject0", data=np.array([(o,) for o in objs],
                                                       dtype=[("ID_Object", "<i8")]))
        g.create_dataset("TrackEdge0", data=np.zeros(0, dtype=[("ID_ObjectA", "<i8"),
                                                               ("ID_ObjectB", "<i8")]))
        g.create_dataset("MainTrackTable", data=np.array(
            [(b"0", b"Track0", b"TrackObject0", b"TrackEdge0")],
            dtype=[("ObjectsName", "S256"), ("TrackName", "S256"),
                   ("TrackObjectName", "S256"), ("TrackEdgeName", "S256")]))
        # Spot-level classification "Point Locations": label 0 / 1.
        labels = sorted({r["region"] for r in rows})
        g.create_dataset("LabelValues", data=np.array([(v.encode(),) for v in labels],
                                                      dtype=[("LabelValue", "S256")]))
        g.create_dataset("LabelGroupNames", data=np.array(
            [(b"Point Locations", len(labels))],
            dtype=[("LabelGroupName", "S256"), ("EndLabelValue", "<i8")]))
        g.create_dataset("LabelSetLabelIDs", data=np.array([(i,) for i in range(len(labels))],
                                                           dtype=[("IDLabel", "<i8")]))
        obj_ids, sets, end = [], [], 0
        for i, v in enumerate(labels):
            members = [r["spot"] for r in rows if r["region"] == v]
            obj_ids.extend(members)
            end += len(members)
            sets.append((i + 1, end))
        g.create_dataset("LabelSetObjectIDs", data=np.array([(o,) for o in obj_ids],
                                                            dtype=[("IDObject", "<i8")]))
        g.create_dataset("LabelSets", data=np.array(
            sets, dtype=[("EndLabelIDs", "<i8"), ("EndObjectIDs", "<i8")]))
    return Path(path)


def workbook_rows(rows, unit_of_row=None, with_unit=True, factor=1.0):
    """The Position sheet as Imaris exports it: a title line, then the header."""
    header = ["Position X", "Position Y", "Position Z"] + (["Unit"] if with_unit else []) + \
             ["Category", "Collection", "Time", "TrackID", "ID", "Point Locations"]
    out = [["Position"], header]
    for r in sorted(rows, key=lambda r: (r["frame"], r["spot"])):
        unit = unit_of_row(r) if unit_of_row else "um"
        f = factor(r) if callable(factor) else factor
        line = [r["x"] / f, r["y"] / f, r["z"] / f]
        if with_unit:
            line.append(unit)
        line += ["Spot", "Position", r["frame"] + 1, r["track"], r["spot"], r["region"]]
        out.append(line)
    return out


class UnitTable(unittest.TestCase):
    def test_same_table_as_the_extent_conversion(self):
        md = _load("v3_ims_metadata", "1-ims_metadata.py")
        self.assertEqual(ts._ims_metadata_module().UNIT_TO_UM, md.UNIT_TO_UM)
        for label, factor in (("um", 1.0), ("µm", 1.0), ("mm", 1e3), ("nm", 1e-3), ("m", 1e6),
                              ("MM", 1e3), (" um ", 1.0)):
            self.assertEqual(ts.unit_factor(label)[0], factor, label)
        self.assertEqual(ts.unit_factor(None), (1.0, "um"))
        self.assertEqual(ts.unit_factor(""), (1.0, "um"))
        self.assertIsNone(ts.unit_factor("pixel")[0])


class Scene8Units(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.rows = population()

    def tearDown(self):
        self.tmp.cleanup()

    def _read(self, **kw):
        return ts.read_scene8(write_scene8(self.dir / "v.ims", self.rows, **kw))

    def _assert_positions(self, table, factor_tol=0.0):
        got = {r["cell_id"]: (r["x"], r["y"], r["z"]) for r in table["rows"]}
        for r in self.rows:
            for a, b in zip(got[r["spot"]], (r["x"], r["y"], r["z"])):
                self.assertLessEqual(abs(a - b), factor_tol, (r["spot"], a, b))

    def test_um_is_native_and_exact(self):
        table = self._read()
        self._assert_positions(table)
        self.assertEqual(table["provenance"]["unit"], {"declared": "um", "toUm": 1.0, "status": "native"})
        self.assertEqual(table["provenance"]["spotRadiusUm"]["median"], 3.0)
        self.assertEqual(table["warnings"], [])

    def test_mm_nm_m_are_converted(self):
        for unit, factor in (("mm", 1e3), ("nm", 1e-3), ("m", 1e6)):
            with self.subTest(unit=unit):
                table = self._read(factor=factor, object_unit=unit, image_unit=unit)
                # float32 storage of p/factor: relative error <= 2^-24 of a <= 200 um value
                self._assert_positions(table, factor_tol=200 * 2 ** -23)
                self.assertEqual(table["provenance"]["unit"]["status"], "converted")
                self.assertEqual(table["provenance"]["unit"]["toUm"], factor)
                self.assertAlmostEqual(table["provenance"]["spotRadiusUm"]["median"], 3.0, places=5)

    def test_object_unit_wins_over_image_unit(self):
        table = self._read(factor=1e3, object_unit="mm", image_unit="um")
        self._assert_positions(table, factor_tol=200 * 2 ** -23)
        table = self._read(factor=1e3, object_unit=None, image_unit="mm")
        self._assert_positions(table, factor_tol=200 * 2 ** -23)
        self.assertEqual(table["provenance"]["unit"]["declared"], "mm")

    def test_absent_unit_is_assumed_um(self):
        table = self._read(object_unit=None, image_unit=None)
        self._assert_positions(table)
        self.assertEqual(table["provenance"]["unit"]["status"], "assumed")

    def test_unknown_unit_is_kept_and_reported(self):
        table = self._read(factor=2.0, object_unit="furlong", image_unit="furlong")
        self.assertEqual(table["provenance"]["unit"], {"declared": "furlong", "toUm": None, "status": "unknown"})
        r0 = next(r for r in table["rows"] if r["cell_id"] == self.rows[0]["spot"])
        self.assertEqual(r0["x"], np.float32(self.rows[0]["x"] / 2.0))
        self.assertTrue(any("furlong" in w for w in table["warnings"]))


class WorkbookUnits(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.rows = population()
        self.path = self.dir / "v.xlsx"
        self.path.write_bytes(b"")

    def tearDown(self):
        self.tmp.cleanup()

    def _read(self, sheet, default_unit=None):
        with mock.patch.object(ts, "_read_workbook", lambda p: iter([("Position", sheet)])):
            return ts.read_excel(self.path, default_unit=default_unit)

    def _assert_positions(self, table, tol=1e-9):
        got = {int(r["cell_id"]): (r["x"], r["y"], r["z"]) for r in table["rows"]}
        for r in self.rows:
            for a, b in zip(got[r["spot"]], (r["x"], r["y"], r["z"])):
                self.assertLessEqual(abs(a - b), tol * max(1.0, abs(b)))

    def test_per_row_units(self):
        for unit, factor in (("um", 1.0), ("µm", 1.0), ("mm", 1e3), ("nm", 1e-3), ("m", 1e6)):
            with self.subTest(unit=unit):
                table = self._read(workbook_rows(self.rows, lambda r: unit, factor=factor))
                self._assert_positions(table)
                self.assertEqual(table["provenance"]["unit"]["toUm"], factor)
                self.assertEqual(table["provenance"]["unit"]["status"],
                                 "native" if factor == 1.0 else "converted")

    def test_mixed_units_convert_row_by_row(self):
        pick = lambda r: "mm" if r["spot"] % 2 else "nm"  # noqa: E731
        fac = lambda r: 1e3 if r["spot"] % 2 else 1e-3  # noqa: E731
        table = self._read(workbook_rows(self.rows, pick, factor=fac))
        self._assert_positions(table)
        self.assertEqual(table["provenance"]["unit"]["status"], "converted")
        self.assertEqual(table["provenance"]["unit"]["declared"], ["mm", "nm"])

    def test_unknown_unit_is_kept_and_reported(self):
        table = self._read(workbook_rows(self.rows, lambda r: "parsec", factor=1.0))
        self._assert_positions(table)  # unconverted: the values as written
        self.assertEqual(table["provenance"]["unit"]["status"], "unknown")
        self.assertTrue(any("parsec" in w for w in table["warnings"]))

    def test_no_unit_column_takes_the_volume_unit(self):
        table = self._read(workbook_rows(self.rows, with_unit=False, factor=1e3), default_unit="mm")
        self._assert_positions(table)
        self.assertEqual(table["provenance"]["unit"]["status"], "converted")
        self.assertEqual(table["provenance"]["unit"]["from"], "volume")

    def test_no_unit_column_no_volume_is_assumed_um(self):
        table = self._read(workbook_rows(self.rows, with_unit=False))
        self._assert_positions(table)
        self.assertEqual(table["provenance"]["unit"]["status"], "assumed")

    def test_volume_unit_found_beside_the_workbook(self):
        write_scene8(self.dir / "v.ims", self.rows, factor=1e3, object_unit="mm", image_unit="mm")
        self.assertEqual(ts._volume_unit(ts._ims_beside(self.path)), "mm")
        nested = self.dir / "v" / "v_analysis.xlsx"
        nested.parent.mkdir()
        self.assertEqual(ts._ims_beside(nested), self.dir / "v.ims")


class Alignment(unittest.TestCase):
    EXTENT = {"min": [0.0, 0.0, 0.0], "max": [192.0, 192.0, 96.0]}

    def test_aligned(self):
        pts = [[r["x"], r["y"], min(r["z"], 90.0)] for r in population()]
        out = IMP.check_alignment(pts, self.EXTENT)
        self.assertTrue(out["aligned"])
        self.assertNotIn("probableUnit", out)

    def test_mm_positions_are_detected(self):
        # inside the box (it starts at 0) but a thousand times too small
        pts = [[r["x"] / 1e3, r["y"] / 1e3, min(r["z"], 90.0) / 1e3] for r in population()]
        out = IMP.check_alignment(pts, self.EXTENT)
        self.assertEqual(out["insideAcquisitionBox"], 1.0)
        self.assertFalse(out["aligned"])
        self.assertEqual(out["probableUnit"]["unit"], "mm")
        self.assertEqual(out["probableUnit"]["toUm"], 1e3)

    def test_nm_positions_are_detected(self):
        pts = [[r["x"] * 1e3, r["y"] * 1e3, min(r["z"], 90.0) * 1e3] for r in population()]
        out = IMP.check_alignment(pts, self.EXTENT)
        self.assertEqual(out["probableUnit"]["unit"], "nm")

    def test_no_extent_no_verdict(self):
        self.assertIsNone(IMP.check_alignment([[1, 2, 3]], None))


if __name__ == "__main__":
    unittest.main()
