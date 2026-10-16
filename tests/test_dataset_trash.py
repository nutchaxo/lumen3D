"""Unit tests for the dataset trash (the admin Delete button).

A delete moves the folder to uploads/trash/ for 60 days; the same name can be deleted,
re-uploaded and deleted again, every deletion being its own entry.

Run: py tests/test_dataset_trash.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dataset_trash as trash  # noqa: E402


class TrashCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.web = self.tmp / "DATA_WEB"
        self.up = self.tmp / "uploads"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make(self, type_dir="3d", folder="demo", name="Demo", payload=b"x" * 10):
        d = self.web / type_dir / folder
        (d / "bricks").mkdir(parents=True)
        (d / "bricks" / "p.bin").write_bytes(payload)
        (d / "metadata.json").write_text(
            json.dumps({"name": name, "type": type_dir, "id": f"{type_dir}/{folder}"}), encoding="utf-8")
        return d

    def test_delete_moves_and_records(self):
        d = self.make(payload=b"x" * 123)
        st, pl = trash.move_to_trash(self.web, self.up, "3d/demo")
        self.assertEqual(st, 200)
        self.assertFalse(d.exists())
        rows = trash.list_entries(self.up)["entries"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "3d/demo")
        self.assertEqual(rows[0]["name"], "Demo")
        self.assertEqual(rows[0]["daysLeft"], 60)
        self.assertGreaterEqual(rows[0]["bytes"], 123)

    def test_same_name_many_times(self):
        ids = []
        for i in range(3):
            self.make(name=f"v{i}", payload=bytes([i]) * 4)
            st, pl = trash.move_to_trash(self.web, self.up, "3d/demo")
            self.assertEqual(st, 200)
            ids.append(pl["trashId"])
        self.assertEqual(len(set(ids)), 3)
        rows = trash.list_entries(self.up)["entries"]
        self.assertEqual(sorted(r["name"] for r in rows), ["v0", "v1", "v2"])
        # Each entry restores to ITS OWN bytes.
        st, pl = trash.restore(self.web, self.up, ids[1])
        self.assertEqual((st, pl["id"]), (200, "3d/demo"))
        self.assertEqual((self.web / "3d" / "demo" / "bricks" / "p.bin").read_bytes(), bytes([1]) * 4)

    def test_restore_conflict_suggests_free_name(self):
        self.make(name="old")
        _, pl = trash.move_to_trash(self.web, self.up, "3d/demo")
        self.make(name="reuploaded")
        st, err = trash.restore(self.web, self.up, pl["trashId"])
        self.assertEqual((st, err["error"], err["suggested"]), (409, "exists", "demo-restored"))
        # Nothing was touched by the refusal.
        self.assertEqual(len(trash.list_entries(self.up)["entries"]), 1)
        st, ok = trash.restore(self.web, self.up, pl["trashId"], "demo-restored")
        self.assertEqual((st, ok["id"]), (200, "3d/demo-restored"))
        meta = json.loads((self.web / "3d" / "demo-restored" / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["id"], "3d/demo-restored")
        self.assertEqual(json.loads((self.web / "3d" / "demo" / "metadata.json").read_text(encoding="utf-8"))["name"], "reuploaded")
        self.assertEqual(trash.list_entries(self.up)["entries"], [])

    def test_expiry_after_60_days(self):
        self.make()
        _, pl = trash.move_to_trash(self.web, self.up, "3d/demo")
        edir = self.up / "trash" / pl["trashId"]
        soon = trash._now() + timedelta(days=59)
        self.assertEqual(trash.purge_expired(self.up, soon), [])
        late = trash._now() + timedelta(days=61)
        self.assertEqual(trash.purge_expired(self.up, late), [pl["trashId"]])
        self.assertFalse(edir.exists())

    def test_purge_and_empty(self):
        self.make(folder="a")
        self.make(folder="b")
        _, pa = trash.move_to_trash(self.web, self.up, "3d/a")
        trash.move_to_trash(self.web, self.up, "3d/b")
        self.assertEqual(trash.purge(self.up, pa["trashId"])[0], 200)
        self.assertEqual(len(trash.list_entries(self.up)["entries"]), 1)
        self.assertEqual(trash.empty(self.up), (200, {"ok": True, "removed": 1}))
        self.assertEqual(trash.purge(self.up, pa["trashId"])[0], 404)

    def test_rejects_bad_ids(self):
        self.make()
        for bad in ("../x", "3d/..", "3d/a/b", "tracking/x", "3d/", "", None, 5):
            self.assertEqual(trash.move_to_trash(self.web, self.up, bad)[0], 400, bad)
        self.assertEqual(trash.move_to_trash(self.web, self.up, "3d/missing")[0], 404)
        for bad in ("../x", "a/b", "..", ".hidden", "", None):
            self.assertEqual(trash.restore(self.web, self.up, bad)[0], 404, bad)
            self.assertEqual(trash.purge(self.up, bad)[0], 404, bad)
        _, pl = trash.move_to_trash(self.web, self.up, "3d/demo")
        self.assertEqual(trash.restore(self.web, self.up, pl["trashId"], "../evil")[0], 400)

    def test_half_entry_is_reclaimed_but_not_listed(self):
        orphan = self.up / "trash" / "3d__x__20200101T000000Z-abcdef"
        orphan.mkdir(parents=True)
        (orphan / "entry.json").write_text("{}", encoding="utf-8")
        self.assertEqual(trash.list_entries(self.up)["entries"], [])
        self.assertTrue(orphan.exists())          # young: could be a delete in flight
        old = trash._now() + timedelta(hours=3)
        self.assertEqual(trash.purge_expired(self.up, old), [orphan.name])


class HttpCase(unittest.TestCase):
    """The real handler: auth, CSRF, catalog rebuild and the whole delete → restore trip."""

    @classmethod
    def setUpClass(cls):
        import threading
        import urllib.request
        import dev_server
        cls.dev, cls.rq = dev_server, urllib.request
        cls.tmp = Path(tempfile.mkdtemp())
        cls._saved = (dev_server.DATA_WEB, dev_server.UPLOADS_DIR)
        dev_server.DATA_WEB = cls.tmp / "DATA_WEB"
        dev_server.UPLOADS_DIR = cls.tmp / "uploads"
        d = dev_server.DATA_WEB / "3d" / "demo"
        d.mkdir(parents=True)
        (d / "metadata.json").write_text(
            json.dumps({"name": "Demo", "type": "3d", "id": "3d/demo", "configured": True}), encoding="utf-8")
        cls.token = dev_server._new_session("admin")
        cls.csrf = dev_server._SESSIONS[cls.token]["csrf"]
        cls.httpd = dev_server._QuietServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.dev._SESSIONS.pop(cls.token, None)
        cls.dev.DATA_WEB, cls.dev.UPLOADS_DIR = cls._saved
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, action, method="POST", body=None, query="", csrf=True):
        headers = {"Cookie": f"admpan_token={self.token}", "Content-Type": "application/json"}
        if csrf:
            headers["X-CSRF-Token"] = self.csrf
        req = self.rq.Request(f"http://127.0.0.1:{self.port}/api/datasets.php?action={action}{query}",
                              data=json.dumps(body or {}).encode() if method == "POST" else None,
                              headers=headers, method=method)
        try:
            with self.rq.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except self.rq.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_round_trip(self):
        self.assertEqual(self.call("delete", query="&id=3d/demo", csrf=False)[0], 403)
        self.assertEqual(self.call("delete", method="GET", query="&id=3d/demo")[0], 405)
        self.assertEqual(self.call("delete", query="&id=staging:3d/x")[0], 409)
        st, pl = self.call("delete", query="&id=3d/demo")
        self.assertEqual(st, 200, pl)
        listing = self.call("list", method="GET")[1]["datasets"]
        self.assertNotIn("3d/demo", [d["id"] for d in listing])
        entries = self.call("trash_list", method="GET")[1]["entries"]
        self.assertEqual([e["id"] for e in entries], ["3d/demo"])
        st, pl = self.call("trash_restore", body={"trashId": entries[0]["trashId"]})
        self.assertEqual((st, pl["id"]), (200, "3d/demo"))
        self.assertIn("3d/demo", [d["id"] for d in self.call("list", method="GET")[1]["datasets"]])
        self.assertEqual(self.call("trash_purge", body={"trashId": entries[0]["trashId"]})[0], 404)


if __name__ == "__main__":
    unittest.main()
