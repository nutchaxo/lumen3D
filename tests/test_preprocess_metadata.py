"""Preprocessing pipeline — metadata, naming and publication (standard library only).

Covers:
  * the stage / embryo parser on the lab's real naming (E8-5, E10-5, E10.5, E95, E825,
    a trailing -Em3, an embryo number right after the stage);
  * re-processing a published volume keeps its curation (hidden stays hidden,
    orientation, display settings, hand-corrected stage, gallery, tracking block) while
    the measured facts are refreshed, and a hand-entered calibration survives a file
    that has none;
  * a dataset is published all or nothing: new = one rename, existing = swap with
    metadata.json last, a failure mid-swap restores the previous dataset, and an
    interrupted swap is finished or undone on the next run;
  * folder names are URL-safe without moving an already published dataset, and two
    inputs that would share a folder are detected;
  * atomic writes leave no temporary file; the worker pool respects Windows' cap.

Run: python -m unittest tests.test_preprocess_metadata
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
PRE = ROOT / "preprocess"
sys.path.insert(0, str(PRE))
import run_preprocess as rp  # noqa: E402


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(PRE / filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


catalog = _load("lumen_test_catalog", "4-catalog_generator.py")


class StageAndEmbryoParsing(unittest.TestCase):
    CASES = [
        # name                                                         stage    numeric embryo
        ("Egfl7eGFP-E8-5-Em1-x",                                       "E8.5",  8.5,  "Em1"),
        ("Dll4-E10.5-Em3",                                             "E10.5", 10.5, "Em3"),
        ("Dll4-E10-5-Em3",                                             "E10.5", 10.5, "Em3"),
        ("Foo-E12-5-a",                                                "E12.5", 12.5, None),
        ("Egfl7eGFP-E75-Em10-18112025-GFP555-Pecam1-10x-2xzoom-4avg",  "E7.5",  7.5,  "Em10"),
        ("Egfl7eGFP-E825-Em2-10122024-DAPI-Pecam1647-10x-07xzoom",     "E8.25", 8.25, "Em2"),
        ("Egfl7eGFP-E85-2-24032025-DAPI-Pecam1-BF-10x-08zoom",         "E8.5",  8.5,  "Em2"),
        ("Egfl7eGFP-E95-1-Pecam1-10x-3x3Tiles",                        "E9.5",  9.5,  "Em1"),
        ("Egfl7eGFP-Em1-E95-DAPI-Dll4647-25xs-3x3Tiles-4avg-3um",      "E9.5",  9.5,  "Em1"),
        ("Egfl7eGFP-Em2-E9-DAPI-Dll4647-25xs-3x3Tiles-4avg-3um",       "E9",    9.0,  "Em2"),
        ("Egfl7eGFP-E8-1-DAPI-Egfl7-Pecam1-10x-stack",                 "E8",    8.0,  "Em1"),
        ("Egfl7eGFP-E8-Em13-18112025-GFP555-Pecam1-10x-2xzoom-4avg",   "E8",    8.0,  "Em13"),
        ("Egfl7eGFP-E775-26112024-30min-30cycles-488laser-10x",        "E7.75", 7.75, None),
        ("Egfl7eGFP-Em3-Decidua-7hCulture-TS11c-10x-2x2-16062026",     "Unknown", 0.0, "Em3"),
        ("E105-sample",                                                "E10.5", 10.5, None),
        ("E80",                                                        "E8.0",  8.0,  None),
        ("Dll4-e8-25-Em4",                                             "E8.25", 8.25, "Em4"),
        ("sample-Em3",                                                 "Unknown", 0.0, "Em3"),
    ]

    def test_table(self):
        for name, stage, numeric, embryo in self.CASES:
            with self.subTest(name=name):
                self.assertEqual(catalog._parse_stage(name), (stage, numeric))
                self.assertEqual(catalog._parse_embryo(name), embryo)

    def test_photograph_importer_reads_the_same_stage(self):
        try:
            importer = _load("lumen_test_2d_importer", "2d_importer.py")
        except ImportError as exc:  # numpy / Pillow absent
            self.skipTest(str(exc))
        for series, stage, numeric in [("E8-5 x2 240312 1", "E8.5", 8.5),
                                       ("E8.5 x2 240312", "E8.5", 8.5),
                                       ("E10-5 x1.6 240312", "E10.5", 10.5),
                                       ("E10.5 x1.6 240312", "E10.5", 10.5),
                                       ("E8,25 x2 240312", "E8.25", 8.25),
                                       ("(E9) x2 240312", "E9", 9.0),
                                       ("x2 240312", None, None)]:
            with self.subTest(series=series):
                parsed = importer.parse_filename("DLL4xCD1.lif - " + series)
                self.assertEqual((parsed["stage"], parsed["stageNumeric"]), (stage, numeric))


def _fresh(**over):
    meta = {
        "id": "3d/ds", "name": "ds", "type": "3d", "stage": "E8.5", "stageNumeric": 8.5,
        "embryo": None, "dimensions": {"x": 100, "y": 80, "z": 20, "c": 2, "t": 1},
        "voxel_size": {"x": 0.5, "y": 0.5, "z": 2.0},
        "physicalSizeUm": {"x": 50.0, "y": 40.0, "z": 40.0},
        "calibrationStatus": "exact", "calibrationNote": "ok",
        "channels": [{"name": "DAPI", "color": "#00FF00", "min": 0.0, "max": 1.0, "gamma": 1.0},
                     {"name": "GFP", "color": "#00AAFF", "min": 0.0, "max": 1.0, "gamma": 1.0}],
        "created": "2026-10-05T10:00:00", "lastModified": "2026-10-05T10:00:00",
        "configured": True, "folderName": "ds", "description": "auto text",
        "thumbnail": "DATA_WEB/3d/ds/thumbnail.webp", "volumeSources": [{"kind": "bricks"}],
    }
    meta.update(over)
    return meta


class CuratedMerge(unittest.TestCase):
    def test_curation_survives_reprocessing(self):
        existing = _fresh(
            stage="TS11d", stageNumeric=8.0, embryo="Em5", description="hand written",
            hidden=True, orientation=[0, 0, 0.7071, 0.7071], upsideDown=True,
            orientationAxes={"labels": {"A": "Head"}}, exposure=1.4,
            gallery=[{"file": "a.png", "caption": "x"}], relatedIds=["3d/other"],
            created="2025-01-01T00:00:00",
            channels=[{"name": "Nuclei", "color": "#FF0000", "min": 0.1, "max": 0.8, "gamma": 1.3},
                      {"name": "GFP", "color": "#00AAFF", "min": 0.0, "max": 0.5, "gamma": 1.0}],
            tracking={"tracksPath": "tracks.json"}, registration={"transforms": []},
            dimensions={"x": 1, "y": 1, "z": 1, "c": 2, "t": 1})
        fresh = _fresh(dimensions={"x": 100, "y": 80, "z": 20, "c": 2, "t": 1},
                       lastModified="2026-10-05T12:00:00")
        merged = catalog.merge_volume_metadata(existing, fresh)
        self.assertIs(merged["hidden"], True)
        for key in ("stage", "stageNumeric", "embryo", "description", "orientation", "upsideDown",
                    "orientationAxes", "exposure", "gallery", "relatedIds", "created",
                    "tracking", "registration"):
            self.assertEqual(merged[key], existing[key], key)
        self.assertEqual(merged["channels"], existing["channels"])
        # measured facts come from the new run
        self.assertEqual(merged["dimensions"], fresh["dimensions"])
        self.assertEqual(merged["lastModified"], "2026-10-05T12:00:00")
        self.assertEqual(merged["volumeSources"], fresh["volumeSources"])

    def test_new_channel_set_starts_from_defaults(self):
        existing = _fresh(channels=[{"name": "only", "color": "#123456"}])
        merged = catalog.merge_volume_metadata(existing, _fresh())
        self.assertEqual(merged["channels"], _fresh()["channels"])

    def test_hand_calibration_kept_when_file_has_none(self):
        missing = _fresh(voxel_size={"x": 0.0, "y": 0.0, "z": 0.0}, calibrationStatus="metadata-missing",
                         physicalSizeUm={"x": 0.0, "y": 0.0, "z": 0.0})
        hand = _fresh(voxel_size={"x": 0.7, "y": 0.7, "z": 3.0}, calibrationStatus="exact")
        merged = catalog.merge_volume_metadata(hand, missing)
        self.assertEqual(merged["voxel_size"], hand["voxel_size"])
        self.assertEqual(merged["calibrationStatus"], "exact")
        # The 1/N placeholder an older version labelled "exact" is not a calibration.
        placeholder = _fresh(voxel_size={"x": 0.01, "y": 0.0125, "z": 0.05}, calibrationStatus="exact")
        merged = catalog.merge_volume_metadata(placeholder, missing)
        self.assertEqual(merged["calibrationStatus"], "metadata-missing")
        # A file that is calibrated always wins.
        merged = catalog.merge_volume_metadata(hand, _fresh())
        self.assertEqual(merged["voxel_size"], _fresh()["voxel_size"])

    def test_merge_is_idempotent(self):
        existing = _fresh(hidden=True, stage="TS12")
        once = catalog.merge_volume_metadata(existing, _fresh())
        self.assertEqual(catalog.merge_volume_metadata(existing, once), once)


def _mkdataset(root: Path, files: dict):
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")


def _snapshot(root: Path) -> dict:
    return {p.relative_to(root).as_posix(): p.read_text(encoding="utf-8")
            for p in sorted(root.rglob("*")) if p.is_file()}


class Publication(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen_publish_"))
        self.final = self.tmp / "DATA_WEB" / "3d" / "ds"
        self.stage = self.tmp / "temp" / "stage" / "3d" / "ds"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _stage(self, tag="new", meta=None):
        _mkdataset(self.stage, {"bricks/manifest.json": f"{tag}-manifest",
                                "bricks/lod0/c0/pack_00.bin": f"{tag}-pack",
                                "thumbnail.webp": f"{tag}-thumb"})
        (self.stage / "metadata.json").write_text(json.dumps(meta or _fresh(description=tag)),
                                                  encoding="utf-8")

    def test_new_dataset_appears_in_one_rename(self):
        self._stage()
        rp.publish_dataset(self.stage, self.final)
        self.assertFalse(self.stage.exists())
        self.assertEqual(_snapshot(self.final)["bricks/lod0/c0/pack_00.bin"], "new-pack")

    def test_swap_replaces_pipeline_entries_and_keeps_the_rest(self):
        _mkdataset(self.final, {"bricks/manifest.json": "old-manifest",
                                "bricks/lod0/c0/pack_00.bin": "old-pack",
                                "bricks/lod0/c0/pack_01.bin": "old-extra",
                                "thumbnail.webp": "old-thumb",
                                "download/ds.tif": "tif", "gallery/a.png": "png",
                                "metadata.json": json.dumps(_fresh(hidden=True, stage="TS11"))})
        self._stage()
        rp.publish_dataset(self.stage, self.final)
        snap = _snapshot(self.final)
        self.assertEqual(snap["bricks/lod0/c0/pack_00.bin"], "new-pack")
        self.assertNotIn("bricks/lod0/c0/pack_01.bin", snap)
        self.assertEqual(snap["thumbnail.webp"], "new-thumb")
        self.assertEqual(snap["download/ds.tif"], "tif")
        self.assertEqual(snap["gallery/a.png"], "png")
        meta = json.loads(snap["metadata.json"])
        self.assertIs(meta["hidden"], True)          # re-merged with the published file
        self.assertEqual(meta["stage"], "TS11")
        self.assertFalse(any(k.endswith(rp.SWAP_SUFFIX) or k.startswith(rp.SWAP_MARKER) for k in snap))

    def test_failure_before_commit_restores_previous_dataset(self):
        _mkdataset(self.final, {"bricks/manifest.json": "old-manifest", "thumbnail.webp": "old-thumb",
                                "metadata.json": json.dumps(_fresh(description="old"))})
        before = _snapshot(self.final)
        self._stage()
        real_replace = os.replace

        def failing_replace(src, dst):
            if Path(dst).name == "metadata.json" and Path(src).parent == self.stage:
                raise OSError("disk full")
            return real_replace(src, dst)

        with mock.patch.object(rp.os, "replace", failing_replace):
            with self.assertRaises(OSError):
                rp.publish_dataset(self.stage, self.final)
        self.assertEqual(_snapshot(self.final), before)
        self.assertEqual(_snapshot(self.stage)["bricks/manifest.json"], "new-manifest")

    def test_interrupted_swap_is_undone_or_finished(self):
        # Crash after the old entries moved aside and the new ones moved in, before the
        # metadata.json replace: the old dataset comes back.
        _mkdataset(self.final, {"bricks.pre-swap/manifest.json": "old", "bricks/manifest.json": "new",
                                "thumbnail.webp.pre-swap": "old-thumb",
                                "metadata.json": json.dumps({"v": "old"})})
        rp.atomic_write_json(self.final / rp.SWAP_MARKER,
                             {"metadataSha256": "0" * 64, "entries": ["bricks", "thumbnail.webp"]})
        rp.recover_interrupted_publish(self.final)
        snap = _snapshot(self.final)
        self.assertEqual(snap["bricks/manifest.json"], "old")
        self.assertEqual(snap["thumbnail.webp"], "old-thumb")
        self.assertEqual(set(snap), {"bricks/manifest.json", "thumbnail.webp", "metadata.json"})

        # Crash after the commit: only the old copies remain to be dropped.
        shutil.rmtree(self.final)
        _mkdataset(self.final, {"bricks.pre-swap/manifest.json": "old", "bricks/manifest.json": "new",
                                "metadata.json": json.dumps({"v": "new"})})
        rp.atomic_write_json(self.final / rp.SWAP_MARKER,
                             {"metadataSha256": rp._sha256_file(self.final / "metadata.json"),
                              "entries": ["bricks"]})
        rp.recover_interrupted_publish(self.final)
        self.assertEqual(set(_snapshot(self.final)), {"bricks/manifest.json", "metadata.json"})
        self.assertEqual(_snapshot(self.final)["bricks/manifest.json"], "new")

    def test_legacy_rollback_folder_is_restored(self):
        _mkdataset(self.final, {"bricks.rollback/manifest.json": "old", "metadata.json": "{}"})
        rp.recover_interrupted_publish(self.final)
        self.assertEqual(_snapshot(self.final)["bricks/manifest.json"], "old")

    def test_new_tracking_replaces_the_whole_previous_set(self):
        _mkdataset(self.final, {"bricks/manifest.json": "old", "tracks.json": "old-tracks",
                                "tracks.json.gz": "old-gz", "model.glb": "old-glb",
                                "metadata.json": json.dumps(_fresh())})
        self._stage()
        (self.stage / "tracks.json").write_text("new-tracks", encoding="utf-8")
        rp.publish_dataset(self.stage, self.final)
        snap = _snapshot(self.final)
        self.assertEqual(snap["tracks.json"], "new-tracks")
        self.assertNotIn("model.glb", snap)
        self.assertNotIn("tracks.json.gz", snap)

    def test_without_new_tracking_the_previous_one_stays(self):
        _mkdataset(self.final, {"bricks/manifest.json": "old", "tracks.json": "old-tracks",
                                "model.glb": "old-glb",
                                "metadata.json": json.dumps(_fresh(tracking={"tracksPath": "tracks.json"}))})
        self._stage()
        rp.publish_dataset(self.stage, self.final)
        snap = _snapshot(self.final)
        self.assertEqual(snap["tracks.json"], "old-tracks")
        self.assertEqual(snap["model.glb"], "old-glb")
        self.assertEqual(json.loads(snap["metadata.json"])["tracking"], {"tracksPath": "tracks.json"})


class NamingAndHelpers(unittest.TestCase):
    def test_folder_names(self):
        tmp = Path(tempfile.mkdtemp(prefix="lumen_names_"))
        try:
            self.assertEqual(rp.dataset_folder_name("Em1-E95#2 test%", tmp), "Em1-E95-2-test")
            self.assertEqual(rp.dataset_folder_name("plain-name_Stitch", tmp), "plain-name_Stitch")
            (tmp / "Old name+1").mkdir()
            self.assertEqual(rp.dataset_folder_name("Old name+1", tmp), "Old name+1")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_collisions(self):
        files = [Path("a/Embryo#1.ims"), Path("a/embryo-1.ims"), Path("a/other.ims")]
        clashes = rp._folder_collisions(files)
        self.assertEqual(clashes, {files[1]: files[0]})

    def test_atomic_write_leaves_no_temporary(self):
        tmp = Path(tempfile.mkdtemp(prefix="lumen_atomic_"))
        try:
            target = tmp / "metadata.json"
            target.write_text("old", encoding="utf-8")
            rp.atomic_write_json(target, {"a": 1}, separators=(",", ":"))
            self.assertEqual(target.read_text(encoding="utf-8"), '{"a":1}')
            self.assertEqual([p.name for p in tmp.iterdir()], ["metadata.json"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_worker_count(self):
        with mock.patch.object(rp.os, "cpu_count", return_value=128), \
                mock.patch.dict(os.environ, {"LUMEN_PREPROCESS_WORKERS": ""}):
            n = rp.worker_count()
            self.assertEqual(n, 61 if os.name == "nt" else 128)
        with mock.patch.dict(os.environ, {"LUMEN_PREPROCESS_WORKERS": "2"}):
            self.assertEqual(rp.worker_count(), min(2, os.cpu_count() or 1))


if __name__ == "__main__":
    unittest.main()
