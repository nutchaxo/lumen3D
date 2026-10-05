"""Import journal: append-only chunk log + file table, both backends (web 1.59.0).

Pins the shared on-disk format of upload_staging.py and api/_upload_lib.php:
  * a chunk sent with the plan's `fileId` appends ONE 16-byte record and never
    rewrites the JSON journal (the per-chunk whole-journal rewrite was the cost);
  * the log folds into the journal at plan / file completion and on every read,
    under either backend: an import started under Python resumes under PHP and
    the other way round, mid-file;
  * a torn tail or a corrupted record is ignored, a record naming a retired id
    (the file was reset or dropped) never marks the new incarnation;
  * the two backends write byte-identical log records and file tables.

Run: python tests/test_v3_minor_upload_log.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import upload_staging as us  # noqa: E402

DRIVER = ROOT / "tests" / "v3_minor_php_driver.php"
CS = us.MIN_CHUNK_SIZE


def find_php():
    for cand in ("php", r"C:\php-portable\php.exe"):
        found = shutil.which(cand) or (cand if os.path.isfile(cand) else None)
        if found:
            return found
    return None


PHP = find_php()


def sha(b):
    return hashlib.sha256(b).hexdigest()


def hx(b):
    return {"__hex": b.hex()}


class LogCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-v3log-"))
        (self.tmp / "api").mkdir()
        (self.tmp / "changelog").mkdir()
        (self.tmp / "changelog" / "changelog_1.59.0.md").write_text("x")
        for lib in ("_admin_lib.php", "_upload_lib.php"):
            shutil.copy(ROOT / "api" / lib, self.tmp / "api" / lib)
        us.configure(self.tmp)
        us.ensure_dirs()
        self.blob = bytes((i * 7) & 0xFF for i in range(CS * 2 + 1234))   # 3 chunks

    def tearDown(self):
        us.configure(ROOT)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def php(self, *ops):
        if not PHP:
            self.skipTest("no php interpreter")
        r = subprocess.run([PHP, str(DRIVER), str(self.tmp), "_upload_lib.php"],
                           input=json.dumps(list(ops)), capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out = json.loads(r.stdout)
        for o in out:
            self.assertNotIn("error", o, o)
        return [o["ok"] for o in out]

    def chunk(self, i):
        return self.blob[i * CS:(i + 1) * CS]

    def plan_py(self, folder="DS", extra=()):
        files = [{"path": "bricks/lod0/c0/pack_00.bin", "size": len(self.blob)}, *extra]
        res = us.plan([{"type": "3d", "folder": folder, "files": files}], CS)
        return res["datasets"][0]["files"]

    # ── format ────────────────────────────────────────────────────────────────
    def test_records_and_table_are_byte_identical(self):
        files = self.plan_py(extra=[{"path": "bricks/manifest.json", "size": 10}])
        journal = us.load_journal("3d", "DS")
        table_py = us.table_path("3d", "DS").read_bytes()
        rec_py = us._log_record(5, 77)
        (php_rec,) = self.php({"fn": "lumen_up_log_record", "args": [5, 77]})
        self.assertEqual(bytes.fromhex(php_rec["__hex"]), rec_py)
        us.table_path("3d", "DS").unlink()
        self.php({"fn": "lumen_up_write_table", "args": [journal]})
        self.assertEqual(us.table_path("3d", "DS").read_bytes(), table_py)
        self.assertEqual(len(table_py), 16 + 32 * journal["nextId"])
        self.assertEqual({f["path"]: f["fileId"] for f in files},
                         {rel: e["id"] for rel, e in journal["files"].items()})

    def test_fast_chunk_appends_one_record_and_never_touches_the_journal(self):
        (f,) = self.plan_py()
        jp = us.journal_path("3d", "DS")
        before = (jp.read_bytes(), jp.stat().st_mtime_ns)
        time.sleep(0.02)
        st, pl = us.write_chunk("3d", "DS", f["path"], 0, self.chunk(0), sha(self.chunk(0)), f["fileId"])
        self.assertEqual(st, 200, pl)
        self.assertEqual((jp.read_bytes(), jp.stat().st_mtime_ns), before)
        self.assertEqual(us.log_path("3d", "DS").stat().st_size, 16)
        self.assertEqual(us.read_log("3d", "DS"), [(f["fileId"], 0)])
        # Every reader sees the chunk, before any compaction.
        self.assertEqual(us.describe("3d", "DS")["receivedBytes"], CS)

    def test_cross_backend_resume_mid_file(self):
        (f,) = self.plan_py()
        rel, fid = f["path"], f["fileId"]
        st, _ = us.write_chunk("3d", "DS", rel, 0, self.chunk(0), sha(self.chunk(0)), fid)
        self.assertEqual(st, 200)
        # PHP continues the same file on the Python plan, then Python finishes it.
        (r,) = self.php({"fn": "lumen_up_write_chunk",
                         "args": ["3d", "DS", rel, 1, hx(self.chunk(1)), sha(self.chunk(1)), fid]})
        self.assertEqual(r[0], 200, r)
        self.assertEqual(us.missing_chunks(us.load_journal("3d", "DS")["files"][rel]), [2])
        (desc,) = self.php({"fn": "lumen_up_describe", "args": ["3d", "DS"]})
        self.assertEqual(desc["receivedBytes"], 2 * CS)
        st, _ = us.write_chunk("3d", "DS", rel, 2, self.chunk(2), sha(self.chunk(2)), fid)
        self.assertEqual(st, 200)
        (fin,) = self.php({"fn": "lumen_up_finalize", "args": ["3d", "DS", rel, None]})
        self.assertEqual(fin[0], 200, fin)
        self.assertFalse(us.log_path("3d", "DS").exists(), "file completion compacts the log")
        self.assertTrue(json.loads(us.journal_path("3d", "DS").read_text())["files"][rel]["done"])
        self.assertEqual((us.STAGING_DIR / "3d/DS" / rel).read_bytes(), self.blob)

    def test_php_plan_resumes_under_python(self):
        (plan,) = self.php({"fn": "lumen_up_plan", "args": [[{"type": "3d", "folder": "PH", "files": [
            {"path": "bricks/lod0/c0/pack_00.bin", "size": len(self.blob)}]}], CS]})
        f = plan["datasets"][0]["files"][0]
        for i in range(3):
            (r,) = self.php({"fn": "lumen_up_write_chunk", "args": [
                "3d", "PH", f["path"], i, hx(self.chunk(i)), sha(self.chunk(i)), f["fileId"]]}) if i < 2 else (None,)
            if i == 2:
                st, pl = us.write_chunk("3d", "PH", f["path"], 2, self.chunk(2), sha(self.chunk(2)), f["fileId"])
                self.assertEqual(st, 200, pl)
            else:
                self.assertEqual(r[0], 200, r)
        st, pl = us.finalize_file("3d", "PH", f["path"], None)
        self.assertEqual(st, 200, pl)
        self.assertEqual(us.dataset_state("3d", "PH"), us.STATE_STAGED)

    # ── crash safety ──────────────────────────────────────────────────────────
    def test_torn_tail_and_corrupt_records_are_ignored(self):
        (f,) = self.plan_py()
        us.write_chunk("3d", "DS", f["path"], 0, self.chunk(0), sha(self.chunk(0)), f["fileId"])
        lp = us.log_path("3d", "DS")
        bad = bytearray(us._log_record(f["fileId"], 1))
        bad[4] ^= 0xFF                                     # index flipped, CRC no longer matches
        with open(lp, "ab") as fh:
            fh.write(bytes(bad))
            fh.write(us._log_record(f["fileId"], 2)[:9])   # torn write
        self.assertEqual(us.read_log("3d", "DS"), [(f["fileId"], 0)])
        (php_log,) = self.php({"fn": "lumen_up_read_log", "args": ["3d", "DS"]})
        self.assertEqual(php_log, [[f["fileId"], 0]])
        self.assertEqual(us.missing_chunks(us.load_journal("3d", "DS")["files"][f["path"]]), [1, 2])

    def test_a_record_of_a_retired_id_never_marks_the_new_file(self):
        (f,) = self.plan_py()
        old = f["fileId"]
        us.write_chunk("3d", "DS", f["path"], 0, self.chunk(0), sha(self.chunk(0)), old)
        # Re-run of the pipeline: same path, another size -> new incarnation.
        self.blob = self.blob + b"!"
        (g,) = self.plan_py()
        self.assertNotEqual(g["fileId"], old)
        self.assertEqual(g["missing"], [0, 1, 2])
        # A late chunk of the OLD incarnation is refused, not logged against the new.
        st, pl = us.write_chunk("3d", "DS", f["path"], 1, self.chunk(1), sha(self.chunk(1)), old)
        self.assertEqual(st, 409, pl)
        (r,) = self.php({"fn": "lumen_up_write_chunk", "args": [
            "3d", "DS", f["path"], 1, hx(self.chunk(1)), sha(self.chunk(1)), old]})
        self.assertEqual(r[0], 409, r)
        # And a stale record surviving a crash between journal write and log unlink.
        with open(us.log_path("3d", "DS"), "ab") as fh:
            fh.write(us._log_record(old, 0))
        self.assertEqual(us.missing_chunks(us.load_journal("3d", "DS")["files"][f["path"]]), [0, 1, 2])

    def test_size_mismatch_reset_retires_the_id(self):
        (f,) = self.plan_py()
        for i in range(3):
            us.write_chunk("3d", "DS", f["path"], i, self.chunk(i), sha(self.chunk(i)), f["fileId"])
        dest = us.STAGING_DIR / "3d/DS" / f["path"]
        with open(dest, "ab") as fh:
            fh.write(b"extra")
        st, pl = us.finalize_file("3d", "DS", f["path"], None)
        self.assertEqual(st, 409)
        self.assertEqual(pl["error"], "size_mismatch")
        entry = us.load_journal("3d", "DS")["files"][f["path"]]
        self.assertNotEqual(entry["id"], f["fileId"])
        self.assertIsNone(us.read_table_record("3d", "DS", f["fileId"]))
        st, _ = us.write_chunk("3d", "DS", f["path"], 0, self.chunk(0), sha(self.chunk(0)), f["fileId"])
        self.assertEqual(st, 409)

    def test_a_fid_naming_another_path_is_refused(self):
        files = self.plan_py(extra=[{"path": "bricks/lod1/c0/pack_00.bin", "size": 7}])
        by = {f["path"]: f for f in files}
        wrong = by["bricks/lod1/c0/pack_00.bin"]["fileId"]
        st, pl = us.write_chunk("3d", "DS", "bricks/lod0/c0/pack_00.bin", 0, self.chunk(0),
                                sha(self.chunk(0)), wrong)
        self.assertEqual((st, pl["error"]), (409, "file_not_planned"))
        (r,) = self.php({"fn": "lumen_up_write_chunk", "args": [
            "3d", "DS", "bricks/lod0/c0/pack_00.bin", 0, hx(self.chunk(0)), sha(self.chunk(0)), wrong]})
        self.assertEqual(r[0], 409, r)
        # Without a fid (an older client) the journal path still answers, exactly.
        st, pl = us.write_chunk("3d", "DS", "bricks/lod0/c0/pack_00.bin", 0, self.chunk(0), sha(self.chunk(0)))
        self.assertEqual((st, pl["have"]), (200, 1))
        self.assertEqual(us.missing_chunks(us.load_journal("3d", "DS")["files"]["bricks/lod0/c0/pack_00.bin"]),
                         [1, 2])

    def test_legacy_journal_without_ids_is_numbered_once(self):
        (f,) = self.plan_py()
        jp = us.journal_path("3d", "DS")
        doc = json.loads(jp.read_text())
        for e in doc["files"].values():
            e.pop("id")
        doc.pop("nextId")
        jp.write_text(json.dumps(doc))
        us.table_path("3d", "DS").unlink()
        st, pl = us.write_chunk("3d", "DS", f["path"], 0, self.chunk(0), sha(self.chunk(0)))
        self.assertEqual(st, 200, pl)
        doc = json.loads(jp.read_text())
        self.assertIsInstance(doc["files"][f["path"]]["id"], int)
        self.assertEqual(us.missing_chunks(us.load_journal("3d", "DS")["files"][f["path"]]), [1, 2])

    def test_metadata_edit_lock_survives_the_fast_path(self):
        meta = json.dumps({"id": "3d/DS", "name": "DS", "type": "3d",
                           "dimensions": {"x": 64, "y": 64, "z": 64, "c": 1},
                           "channels": [{"name": "c0"}]}).encode()
        files = self.plan_py(extra=[{"path": "metadata.json", "size": len(meta)}])
        fm = next(f for f in files if f["path"] == "metadata.json")
        us.write_chunk("3d", "DS", "metadata.json", 0, meta, sha(meta), fm["fileId"])
        us.finalize_file("3d", "DS", "metadata.json", None)
        st, _ = us.write_staged_metadata("3d", "DS", {"name": "Edited"})
        self.assertEqual(st, 200)
        st, pl = us.write_chunk("3d", "DS", "metadata.json", 0, meta, sha(meta), fm["fileId"])
        self.assertEqual((st, pl.get("skipped")), (200, "locked"))
        self.assertEqual(us.read_staged_metadata("3d", "DS")["name"], "Edited")

    def test_list_does_not_walk_twice_and_counts_log_activity(self):
        (f,) = self.plan_py()
        us.write_chunk("3d", "DS", f["path"], 0, self.chunk(0), sha(self.chunk(0)), f["fileId"])
        res, kept = us.gc_and_list()
        self.assertEqual(res["removed"], [])
        self.assertEqual([k["key"] for k in kept], ["3d/DS"])
        self.assertIsNotNone(kept[0]["lastActivityAt"])
        (php,) = self.php({"fn": "lumen_up_gc_and_list", "args": []})
        self.assertEqual([k["key"] for k in php[1]], ["3d/DS"])
        self.assertEqual(php[1][0]["receivedBytes"], kept[0]["receivedBytes"])

    def test_chunk_cost_does_not_grow_with_the_file_count(self):
        """20 000 planned files: a fast chunk must stay a constant-size operation."""
        extra = [{"path": f"bricks/lod1/c{c}/pack_{i:04d}.bin", "size": 5}
                 for c in range(10) for i in range(2000)]
        files = self.plan_py(extra=extra)
        f = next(x for x in files if x["path"] == "bricks/lod0/c0/pack_00.bin")
        jp = us.journal_path("3d", "DS")
        size_before = jp.stat().st_size
        self.assertGreater(size_before, 1_000_000)
        t0 = time.perf_counter()
        for _ in range(20):
            st, _ = us.write_chunk("3d", "DS", f["path"], 0, self.chunk(0), sha(self.chunk(0)), f["fileId"])
            self.assertEqual(st, 200)
        per_chunk = (time.perf_counter() - t0) / 20
        print(f"  fast chunk with 20k planned files: {per_chunk * 1000:.1f} ms (incl. sha256 + fsync of 256 KiB)")
        self.assertEqual(jp.stat().st_size, size_before)
        self.assertEqual(us.log_path("3d", "DS").stat().st_size, 20 * 16)


if __name__ == "__main__":
    unittest.main(verbosity=2)
