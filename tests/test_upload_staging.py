"""Unit tests for the dataset import staging store (upload_staging.py).

Covers the three things that make an import safe to accept from a browser:

  * the CLOSED path allowlist — anything the pipeline does not emit is refused
    before a byte is written, so no .php/.js/.htaccess can reach the staging tree
    or, later, DATA_WEB;
  * per-chunk integrity — a tampered, short or misplaced chunk never lands, and a
    partially received file resumes from an exact missing-chunk list;
  * whole-dataset validation — the manifest's brickToPack index must resolve
    inside the packs that actually arrived, and publishing is refused otherwise.

Plus the two behaviours the operator was promised: a dataset becomes editable as
soon as its coarse LOD is in, and an edit made while the upload is still running
is never overwritten by the rest of the transfer.

Run: py tests/test_upload_staging.py
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import upload_staging as us  # noqa: E402


def sha(b):
    return hashlib.sha256(b).hexdigest()


META = {
    "id": "DS", "name": "DS", "type": "fixed",
    "dimensions": {"x": 64, "y": 64, "z": 64, "c": 1},
    "channels": [{"name": "c0"}],
}
MANIFEST = {
    "version": 2, "levels": [{"level": 0}],
    "brickTransport": {"brickToPack": {
        "b": {"url": "lod0/c0/pack_00.bin", "offset": 0, "length": 10}}},
}


class StagingCase(unittest.TestCase):
    """Redirects the whole store into a throwaway root for each test."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-upload-"))
        us.configure(self.tmp)
        us.ensure_dirs()

    def tearDown(self):
        us.configure(Path(ROOT))
        shutil.rmtree(self.tmp, ignore_errors=True)

    def send(self, folder, rel, data, type_dir="fixed"):
        """Plan-free single-chunk send + finalize, for files below the chunk size."""
        st, pl = us.write_chunk(type_dir, folder, rel, 0, data, sha(data))
        self.assertEqual(st, 200, pl)
        st, pl = us.finalize_file(type_dir, folder, rel, None)
        self.assertEqual(st, 200, pl)
        return pl

    def stage_complete(self, folder="DS"):
        mb = json.dumps(META).encode()
        nb = json.dumps(MANIFEST).encode()
        pack = b"X" * 10
        thumb = b"RIFF" + b"0" * 20
        us.plan([{"type": "fixed", "folder": folder, "files": [
            {"path": "metadata.json", "size": len(mb)},
            {"path": "bricks/manifest.json", "size": len(nb)},
            {"path": "bricks/lod0/c0/pack_00.bin", "size": len(pack)},
            {"path": "thumbnail.webp", "size": len(thumb)},
        ]}])
        for rel, blob in (("metadata.json", mb), ("bricks/manifest.json", nb),
                          ("bricks/lod0/c0/pack_00.bin", pack), ("thumbnail.webp", thumb)):
            self.send(folder, rel, blob)


class TestAllowlist(StagingCase):
    def test_accepts_what_the_pipeline_emits(self):
        for type_dir, rel in (
            ("fixed", "metadata.json"),
            ("fixed", "thumbnail.webp"),
            ("fixed", "bricks/manifest.json"),
            ("fixed", "bricks/lod0/c0/pack_00.bin"),
            ("fixed", "bricks/lod3/rgba/pack_12.bin"),
            ("fixed", "download/original.ims"),
            ("fixed", "download/scan.ome.tif"),
            ("live", "bricks/t000/lod2/c0/pack_00.bin"),
            ("live", "model.glb"),
            ("live", "tracks.json.gz"),
        ):
            self.assertIsNotNone(us.classify_path(type_dir, rel), f"should allow: {rel}")

    def test_refuses_everything_else(self):
        for type_dir, rel in (
            ("fixed", "evil.php"),
            ("fixed", ".htaccess"),
            ("fixed", "index.html"),
            ("fixed", "bricks/lod0/c0/pack_00.bin.php"),
            ("fixed", "../../api/admin_credential.json"),
            ("fixed", "bricks/../../evil.js"),
            ("fixed", "/etc/passwd"),
            ("fixed", "download/evil.php"),
            ("fixed", "download/nested/dir.ims"),
            ("fixed", "bricks/lod0/c0/.hidden.bin"),
            ("fixed", "bricks/t000/lod0/c0/pack_00.bin"),   # timepoints: live/tracking only
            ("fixed", "config/instance.json"),
            ("fixed", "a/b/c/d/e/f/g/h/i/j/k/l/m/deep.bin"),
            ("bogus", "metadata.json"),
        ):
            self.assertIsNone(us.classify_path(type_dir, rel), f"should refuse: {rel}")

    def test_plan_reports_refusals_without_accepting_them(self):
        p = us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "metadata.json", "size": 10},
            {"path": "evil.php", "size": 10},
            {"path": "../../../api/admin_credential.json", "size": 10},
        ]}])
        d = p["datasets"][0]
        self.assertEqual([f["path"] for f in d["files"]], ["metadata.json"])
        self.assertEqual({r["path"] for r in d["rejected"]},
                         {"evil.php", "../../../api/admin_credential.json"})

    def test_chunk_endpoint_refuses_traversal_even_when_planned(self):
        us.plan([{"type": "fixed", "folder": "DS", "files": [{"path": "metadata.json", "size": 3}]}])
        for bad in ("../../../api/admin_credential.json", "bricks/../../evil.php",
                    "/etc/passwd", "x.php", "../uploads/state/fixed__DS.json"):
            st, pl = us.write_chunk("fixed", "DS", bad, 0, b"xxx", sha(b"xxx"))
            self.assertEqual(st, 400, f"{bad} -> {pl}")
            self.assertEqual(pl["error"], "path_not_allowed")


class TestTiering(StagingCase):
    def test_coarsest_lod_is_the_preview_tier(self):
        files = [
            {"path": "metadata.json", "size": 1, "kind": "metadata", "tier": 0},
            {"path": "bricks/lod0/c0/pack_00.bin", "size": 1, "kind": "pack", "tier": 3},
            {"path": "bricks/lod2/c0/pack_00.bin", "size": 1, "kind": "pack", "tier": 2},
            {"path": "bricks/lod4/c0/pack_00.bin", "size": 1, "kind": "pack", "tier": 2},
        ]
        us.assign_tiers(files)
        tier = {f["path"]: f["tier"] for f in files}
        self.assertEqual(tier["bricks/lod4/c0/pack_00.bin"], us.TIER_PREVIEW)
        self.assertEqual(tier["bricks/lod2/c0/pack_00.bin"], us.TIER_MID)
        self.assertEqual(tier["bricks/lod0/c0/pack_00.bin"], us.TIER_FULL)

    def test_later_timepoints_never_gate_the_first_open(self):
        files = [
            {"path": "bricks/t000/lod2/c0/pack_00.bin", "size": 1, "kind": "pack", "tier": 2},
            {"path": "bricks/t007/lod2/c0/pack_00.bin", "size": 1, "kind": "pack", "tier": 3},
        ]
        us.assign_tiers(files)
        self.assertEqual(files[0]["tier"], us.TIER_PREVIEW)
        self.assertEqual(files[1]["tier"], us.TIER_FULL)


class TestIntegrity(StagingCase):
    def setUp(self):
        super().setUp()
        self.cs = us.MIN_CHUNK_SIZE
        self.size = int(self.cs * 2.5)          # a partial tail chunk
        self.whole = b"B" * self.size
        us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "bricks/lod0/c0/pack_00.bin", "size": self.size}]}], self.cs)

    def part(self, i):
        return self.whole[i * self.cs:(i + 1) * self.cs]

    def test_tampered_chunk_never_lands(self):
        st, pl = us.write_chunk("fixed", "DS", "bricks/lod0/c0/pack_00.bin", 0,
                                self.part(0), "0" * 64)
        self.assertEqual(st, 422)
        self.assertEqual(pl["error"], "checksum_mismatch")
        self.assertFalse((us.STAGING_DIR / "fixed/DS/bricks/lod0/c0/pack_00.bin").exists())

    def test_wrong_length_refused(self):
        blob = self.part(0)[:100]
        st, pl = us.write_chunk("fixed", "DS", "bricks/lod0/c0/pack_00.bin", 0, blob, sha(blob))
        self.assertEqual(st, 400)
        self.assertEqual(pl["error"], "bad_chunk_length")

    def test_index_out_of_range_refused(self):
        blob = self.part(0)
        st, pl = us.write_chunk("fixed", "DS", "bricks/lod0/c0/pack_00.bin", 99, blob, sha(blob))
        self.assertEqual(st, 400)
        self.assertEqual(pl["error"], "index_out_of_range")

    def test_out_of_order_then_resume_reassembles_exactly(self):
        for i in (2, 0):
            st, _ = us.write_chunk("fixed", "DS", "bricks/lod0/c0/pack_00.bin", i,
                                   self.part(i), sha(self.part(i)))
            self.assertEqual(st, 200)
        st, _ = us.finalize_file("fixed", "DS", "bricks/lod0/c0/pack_00.bin", None)
        self.assertEqual(st, 409, "an incomplete file must not finalize")

        replan = us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "bricks/lod0/c0/pack_00.bin", "size": self.size}]}], self.cs)
        f = replan["datasets"][0]["files"][0]
        self.assertEqual(f["missing"], [1])
        self.assertEqual(f["received"], self.cs + (self.size - 2 * self.cs))

        us.write_chunk("fixed", "DS", "bricks/lod0/c0/pack_00.bin", 1,
                       self.part(1), sha(self.part(1)))
        st, _ = us.finalize_file("fixed", "DS", "bricks/lod0/c0/pack_00.bin", None)
        self.assertEqual(st, 200)
        self.assertEqual((us.STAGING_DIR / "fixed/DS/bricks/lod0/c0/pack_00.bin").read_bytes(),
                         self.whole)

    def test_replaying_a_chunk_is_idempotent(self):
        for _ in range(3):
            st, _ = us.write_chunk("fixed", "DS", "bricks/lod0/c0/pack_00.bin", 0,
                                   self.part(0), sha(self.part(0)))
            self.assertEqual(st, 200)
        entry = us.load_journal("fixed", "DS")["files"]["bricks/lod0/c0/pack_00.bin"]
        self.assertEqual(us.received_bytes(entry), self.cs)


class TestContentValidation(StagingCase):
    def test_malformed_metadata_is_refused_at_finalize(self):
        bad = b'{"type":"fixed","dimensions":{"x":0,"y":1,"z":1,"c":1},"channels":[{}]}'
        us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "metadata.json", "size": len(bad)}]}])
        us.write_chunk("fixed", "DS", "metadata.json", 0, bad, sha(bad))
        st, pl = us.finalize_file("fixed", "DS", "metadata.json", None)
        self.assertEqual(st, 422)
        self.assertEqual(pl["reason"], "metadata_bad_dimensions")

    def test_metadata_type_must_match_its_folder(self):
        bad = json.dumps({**META, "type": "live"}).encode()
        us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "metadata.json", "size": len(bad)}]}])
        us.write_chunk("fixed", "DS", "metadata.json", 0, bad, sha(bad))
        st, pl = us.finalize_file("fixed", "DS", "metadata.json", None)
        self.assertEqual(st, 422)
        self.assertEqual(pl["reason"], "metadata_type_mismatch")

    def test_thumbnail_must_be_a_real_image(self):
        blob = b"<?php system($_GET[0]); ?>"
        us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "thumbnail.webp", "size": len(blob)}]}])
        us.write_chunk("fixed", "DS", "thumbnail.webp", 0, blob, sha(blob))
        st, pl = us.finalize_file("fixed", "DS", "thumbnail.webp", None)
        self.assertEqual(st, 422)
        self.assertEqual(pl["reason"], "thumbnail_not_image")

    def test_truncated_pack_blocks_the_publish(self):
        mb = json.dumps(META).encode()
        nb = json.dumps(MANIFEST).encode()
        pack = b"X" * 4                      # manifest claims 10 bytes
        us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "metadata.json", "size": len(mb)},
            {"path": "bricks/manifest.json", "size": len(nb)},
            {"path": "bricks/lod0/c0/pack_00.bin", "size": len(pack)},
        ]}])
        for rel, blob in (("metadata.json", mb), ("bricks/manifest.json", nb),
                          ("bricks/lod0/c0/pack_00.bin", pack)):
            self.send("DS", rel, blob)
        v = us.validate_dataset("fixed", "DS")
        self.assertFalse(v["ok"])
        self.assertIn("truncated_pack:lod0/c0/pack_00.bin", v["errors"])
        st, _ = us.publish_dataset("fixed", "DS")
        self.assertEqual(st, 409)

    def test_a_file_written_out_of_band_blocks_the_publish(self):
        self.stage_complete()
        (us.STAGING_DIR / "fixed/DS/shell.php").write_bytes(b"<?php ?>")
        v = us.validate_dataset("fixed", "DS")
        self.assertFalse(v["ok"])
        self.assertIn("stray_files", v["errors"])
        st, _ = us.publish_dataset("fixed", "DS")
        self.assertEqual(st, 409)


class TestStateMachine(StagingCase):
    def test_editable_once_metadata_manifest_and_coarse_lod_are_in(self):
        mb = json.dumps(META).encode()
        nb = json.dumps(MANIFEST).encode()
        coarse, native = b"C" * 6, b"N" * 10
        us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "metadata.json", "size": len(mb)},
            {"path": "bricks/manifest.json", "size": len(nb)},
            {"path": "bricks/lod4/c0/pack_00.bin", "size": len(coarse)},
            {"path": "bricks/lod0/c0/pack_00.bin", "size": len(native)},
        ]}])
        self.send("DS", "metadata.json", mb)
        self.assertEqual(us.dataset_state("fixed", "DS"), us.STATE_UPLOADING)
        self.send("DS", "bricks/manifest.json", nb)
        self.assertEqual(us.dataset_state("fixed", "DS"), us.STATE_UPLOADING)
        self.send("DS", "bricks/lod4/c0/pack_00.bin", coarse)
        self.assertEqual(us.dataset_state("fixed", "DS"), us.STATE_EDITABLE,
                         "coarse LOD in -> openable and editable while lod0 streams")
        self.send("DS", "bricks/lod0/c0/pack_00.bin", native)
        self.assertEqual(us.dataset_state("fixed", "DS"), us.STATE_STAGED)

    def test_stalled_after_the_grace_period(self):
        self.stage_complete()
        j = us.load_journal("fixed", "DS")
        j["files"]["bricks/lod0/c0/pack_00.bin"]["done"] = False
        j["lastChunkAt"] = "2020-01-01T00:00:00+00:00"
        us.save_journal(j)
        self.assertEqual(us.dataset_state("fixed", "DS"), us.STATE_STALLED)

    def test_gc_reclaims_only_expired_imports(self):
        self.stage_complete("FRESH")
        self.stage_complete("OLD")
        j = us.load_journal("fixed", "OLD")
        j["updatedAt"] = "2020-01-01T00:00:00+00:00"
        us.save_journal(j)
        # save_journal stamps updatedAt itself, so write the stale value directly.
        p = us.journal_path("fixed", "OLD")
        doc = json.loads(p.read_text())
        doc["updatedAt"] = "2020-01-01T00:00:00+00:00"
        p.write_text(json.dumps(doc))

        result = us.gc()
        self.assertEqual(result["removed"], ["fixed/OLD"])
        self.assertFalse((us.STAGING_DIR / "fixed/OLD").exists())
        self.assertTrue((us.STAGING_DIR / "fixed/FRESH").exists())


class TestOperatorEdits(StagingCase):
    def test_an_edit_survives_a_re_drop_of_the_same_folder(self):
        self.stage_complete()
        st, _ = us.write_staged_metadata("fixed", "DS", {"name": "Renamed by operator"})
        self.assertEqual(st, 200)

        mb = json.dumps(META).encode()
        replan = us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "metadata.json", "size": len(mb)}]}])
        self.assertEqual(replan["datasets"][0]["files"][0].get("skip"), "locked")

        # Even a client that ignores the plan and re-sends the chunk is a no-op.
        st, pl = us.write_chunk("fixed", "DS", "metadata.json", 0, mb, sha(mb))
        self.assertEqual(st, 200)
        self.assertEqual(pl.get("skipped"), "locked")
        self.assertEqual(us.read_staged_metadata("fixed", "DS")["name"], "Renamed by operator")

    def test_an_edit_cannot_make_the_metadata_invalid(self):
        self.stage_complete()
        st, pl = us.write_staged_metadata("fixed", "DS", {"channels": []})
        self.assertEqual(st, 400)
        self.assertEqual(pl["error"], "metadata_no_channels")

    def test_computed_view_fields_never_reach_metadata_json(self):
        """The editor round-trips whatever `get` handed it, including the fields the
        server computed for the view. Persisting those would leave a PUBLISHED
        dataset permanently flagged "staging" once the file is moved into DATA_WEB."""
        self.stage_complete()
        us.write_staged_metadata("fixed", "DS", {
            "name": "Edited", "staging": True, "stagingState": "editable",
            "stagingEditable": True, "path": "staging:fixed/DS",
            "totalBytes": 999, "receivedBytes": 999, "publishedExists": False,
            "expiresInS": 42, "key": "fixed/DS",
        })
        on_disk = json.loads((us.STAGING_DIR / "fixed/DS/metadata.json").read_text())
        self.assertEqual(on_disk["name"], "Edited")
        for leaked in ("staging", "stagingState", "stagingEditable", "path", "key",
                       "totalBytes", "receivedBytes", "publishedExists", "expiresInS"):
            self.assertNotIn(leaked, on_disk, f"{leaked} must not be persisted")

        us.publish_dataset("fixed", "DS")
        published = json.loads((self.tmp / "DATA_WEB/fixed/DS/metadata.json").read_text())
        self.assertNotIn("staging", published)

    def test_an_edit_cannot_retype_or_rehome_the_dataset(self):
        self.stage_complete()
        us.write_staged_metadata("fixed", "DS", {"type": "live", "folderName": "../evil", "id": "../evil"})
        meta = us.read_staged_metadata("fixed", "DS")
        self.assertEqual(meta["type"], "fixed")
        self.assertEqual(meta["folderName"], "DS")
        self.assertEqual(meta["id"], "DS")


class TestPublish(StagingCase):
    def test_publish_moves_and_hides_by_default(self):
        self.stage_complete()
        st, pl = us.publish_dataset("fixed", "DS")
        self.assertEqual(st, 200, pl)
        published = self.tmp / "DATA_WEB/fixed/DS/metadata.json"
        self.assertTrue(published.exists())
        self.assertTrue(json.loads(published.read_text())["hidden"],
                        "a fresh import must not appear in the public explorer unasked")
        self.assertFalse((us.STAGING_DIR / "fixed/DS").exists())
        self.assertIsNone(us.load_journal("fixed", "DS"))

    def test_publish_refuses_to_clobber_without_overwrite(self):
        self.stage_complete()
        us.publish_dataset("fixed", "DS")
        self.stage_complete()
        st, pl = us.publish_dataset("fixed", "DS")
        self.assertEqual(st, 409)
        self.assertEqual(pl["error"], "already_exists")

    def test_publish_with_overwrite_replaces_atomically(self):
        self.stage_complete()
        us.publish_dataset("fixed", "DS")
        self.stage_complete()
        us.write_staged_metadata("fixed", "DS", {"name": "Second import"})
        st, _ = us.publish_dataset("fixed", "DS", overwrite=True)
        self.assertEqual(st, 200)
        meta = json.loads((self.tmp / "DATA_WEB/fixed/DS/metadata.json").read_text())
        self.assertEqual(meta["name"], "Second import")
        # No leftover scaffolding from the swap.
        leftovers = [p.name for p in (self.tmp / "DATA_WEB/fixed").iterdir() if p.name.startswith(".")]
        self.assertEqual(leftovers, [])

    def test_replan_sees_an_already_published_dataset(self):
        self.stage_complete()
        us.publish_dataset("fixed", "DS")
        p = us.plan([{"type": "fixed", "folder": "DS", "files": [
            {"path": "metadata.json", "size": 10}]}])
        self.assertTrue(p["datasets"][0]["published"],
                        "a resume must know the dataset already went live")

    def test_discard_removes_payload_and_journal(self):
        self.stage_complete()
        us.discard_dataset("fixed", "DS")
        self.assertFalse((us.STAGING_DIR / "fixed/DS").exists())
        self.assertIsNone(us.load_journal("fixed", "DS"))


class TestServerWiring(unittest.TestCase):
    """The staging root must be unreachable as a static path, on every backend."""

    def test_uploads_is_a_forbidden_static_root(self):
        import dev_server
        for p in ("uploads", "uploads/", "uploads/staging/fixed/DS/metadata.json",
                  "UPLOADS/staging/x.bin", "uploads\\staging\\x.bin",
                  "x/../uploads/state/fixed__DS.json", "%75ploads/staging/x.bin"):
            self.assertTrue(dev_server._is_forbidden_static(p), f"must block: {p!r}")

    def test_uploads_is_protected_from_the_self_updater(self):
        import dev_server
        self.assertTrue(dev_server._is_protected_rel("uploads/staging/fixed/DS/metadata.json"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
