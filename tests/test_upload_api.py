"""End-to-end HTTP tests for the dataset import API (/api/upload.php).

The unit tests in test_upload_staging.py prove the staging ENGINE. These prove the
wire contract the browser actually speaks, which is where a different class of bug
lives: routing, the raw-octet chunk body (a chunk is NOT base64 inside JSON — that
is the whole throughput decision), the auth and CSRF gates on every action, and
the authenticated blob proxy that lets the admin preview mount a dataset whose
bytes are deliberately unreachable at a URL.

Runs a real ThreadingHTTPServer against a throwaway web root.

Run: py tests/test_upload_api.py
"""
import hashlib
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402
import upload_staging as us  # noqa: E402

PASSWORD = "test-password-1234"

# Shaped like what preprocess/4-catalog_generator.py actually writes, including
# the DATA_WEB-relative volumeSources the staged `get` has to rewrite onto the
# blob proxy (a staged dataset has no DATA_WEB path yet).
META = {
    "id": "DS", "name": "DS", "type": "fixed",
    "dimensions": {"x": 64, "y": 64, "z": 64, "c": 1},
    "channels": [{"name": "c0"}],
    "volumeSources": [{
        "kind": "bricks", "label": "Chunked bricks (64³)", "priority": -1,
        "available": True, "multiscale": True,
        "path": "DATA_WEB/fixed/DS",
        "manifestPath": "DATA_WEB/fixed/DS/bricks/manifest.json",
    }],
}
# Shaped like what preprocess/3-chunk_packer.py writes. The per-level dimensions
# are load-bearing: the brick loader refuses a manifest without them, so the
# import refuses it too (a dataset the viewer cannot mount is not a valid import).
MANIFEST = {
    "version": 2, "brickSize": 64,
    "levels": [{"level": 0, "dimensions": {"x": 64, "y": 64, "z": 64}}],
    "brickTransport": {"brickToPack": {
        "b": {"url": "lod0/c0/pack_00.bin", "offset": 0, "length": 10}}},
}


class UploadApiCase(unittest.TestCase):
    """One server, one temp root, one authenticated session per test."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-api-"))
        (cls.tmp / "api").mkdir(parents=True, exist_ok=True)
        (cls.tmp / "DATA_WEB" / "fixed").mkdir(parents=True, exist_ok=True)
        (cls.tmp / "changelog").mkdir(exist_ok=True)
        (cls.tmp / "changelog" / "changelog_1.43.0.md").write_text("x", encoding="utf-8")

        # Redirect every module global the import path touches.
        cls._saved = {k: getattr(dev_server, k) for k in
                      ("ROOT", "DATA_WEB", "CRED_FILE", "UPLOADS_DIR", "CHANGELOG_DIR")}
        dev_server.ROOT = cls.tmp
        dev_server.DATA_WEB = cls.tmp / "DATA_WEB"
        dev_server.CRED_FILE = cls.tmp / "api" / "admin_credential.json"
        dev_server.UPLOADS_DIR = cls.tmp / "uploads"
        dev_server.CHANGELOG_DIR = cls.tmp / "changelog"
        us.configure(cls.tmp)
        us.ensure_dirs()

        dev_server._write_credential_force("admin", PASSWORD)

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for k, v in cls._saved.items():
            setattr(dev_server, k, v)
        us.configure(Path(ROOT))
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.cookie = None
        self.csrf = None
        shutil.rmtree(us.STAGING_DIR, ignore_errors=True)
        shutil.rmtree(us.STATE_DIR, ignore_errors=True)
        shutil.rmtree(dev_server.DATA_WEB / "fixed", ignore_errors=True)
        us.ensure_dirs()
        (dev_server.DATA_WEB / "fixed").mkdir(parents=True, exist_ok=True)

    # ── HTTP helpers ───────────────────────────────────────────────────────────

    def request(self, method, path, body=None, headers=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        h = dict(headers or {})
        if self.cookie:
            h["Cookie"] = self.cookie
        if self.csrf:
            h["X-CSRF-Token"] = self.csrf
        payload = body
        if body is not None and not raw:
            payload = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        try:
            conn.request(method, path, body=payload, headers=h)
            res = conn.getresponse()
            data = res.read()
            return res.status, dict(res.getheaders()), data
        finally:
            conn.close()

    def json_request(self, method, path, body=None, headers=None):
        status, hdrs, data = self.request(method, path, body, headers)
        try:
            return status, json.loads(data.decode() or "{}")
        except Exception:
            return status, {"_raw": data[:200].decode(errors="replace")}

    def login(self):
        status, hdrs, data = self.request(
            "POST", "/api/auth.php?action=login",
            {"username": "admin", "password": PASSWORD})
        self.assertEqual(status, 200, data)
        self.cookie = hdrs.get("Set-Cookie", "").split(";")[0]
        self.csrf = json.loads(data.decode())["csrf"]

    # ── Upload helpers ─────────────────────────────────────────────────────────

    def plan(self, files, folder="DS", type_dir="fixed"):
        return self.json_request("POST", "/api/upload.php?action=plan", {
            "datasets": [{"type": type_dir, "folder": folder,
                          "files": [{"path": p, "size": len(b)} for p, b in files.items()]}],
        })

    def send(self, rel, blob, folder="DS", type_dir="fixed", index=0, sha=None):
        digest = sha if sha is not None else hashlib.sha256(blob).hexdigest()
        ds = f"{type_dir}/{folder}"
        status, _, data = self.request(
            "POST",
            f"/api/upload.php?action=chunk&ds={ds}&path={rel}&index={index}&sha256={digest}",
            blob, {"Content-Type": "application/octet-stream"}, raw=True)
        return status, json.loads(data.decode() or "{}")

    def finish(self, rel, folder="DS", type_dir="fixed"):
        return self.json_request(
            "POST", f"/api/upload.php?action=file_done&ds={type_dir}/{folder}",
            {"path": rel, "root": None})

    def full_dataset(self, folder="DS"):
        blobs = {
            "metadata.json": json.dumps(META).encode(),
            "bricks/manifest.json": json.dumps(MANIFEST).encode(),
            "bricks/lod0/c0/pack_00.bin": b"X" * 10,
            "thumbnail.webp": b"RIFF" + b"0" * 20,
        }
        status, plan = self.plan(blobs, folder)
        self.assertEqual(status, 200, plan)
        for rel, blob in blobs.items():
            st, pl = self.send(rel, blob, folder)
            self.assertEqual(st, 200, (rel, pl))
            st, pl = self.finish(rel, folder)
            self.assertEqual(st, 200, (rel, pl))
        return blobs


class TestAuthGate(UploadApiCase):
    def test_every_action_requires_a_session(self):
        for method, path in (
            ("GET", "/api/upload.php?action=list"),
            ("GET", "/api/upload.php?action=limits"),
            ("GET", "/api/upload.php?action=blob&ds=fixed/DS&path=metadata.json"),
            ("GET", "/api/upload.php?action=state&ds=fixed/DS"),
            ("POST", "/api/upload.php?action=plan"),
        ):
            status, _ = self.json_request(method, path, {} if method == "POST" else None)
            self.assertEqual(status, 401, f"{path} must require auth")

    def test_writes_require_the_csrf_header(self):
        self.login()
        saved, self.csrf = self.csrf, None
        for path in ("?action=plan", "?action=publish&ds=fixed/DS", "?action=discard&ds=fixed/DS"):
            status, _ = self.json_request("POST", f"/api/upload.php{path}", {})
            self.assertEqual(status, 403, f"{path} must require CSRF")
        # A chunk POST is a write too, despite carrying a raw body.
        status, _, _ = self.request(
            "POST", "/api/upload.php?action=chunk&ds=fixed/DS&path=metadata.json&index=0",
            b"x", {"Content-Type": "application/octet-stream"}, raw=True)
        self.assertEqual(status, 403)
        self.csrf = saved

    def test_a_write_action_is_refused_over_GET(self):
        self.login()
        status, _ = self.json_request("GET", "/api/upload.php?action=publish&ds=fixed/DS")
        self.assertEqual(status, 405)


class TestStaticGuard(UploadApiCase):
    def test_the_staging_root_is_not_web_served(self):
        self.login()
        self.full_dataset()
        # Authenticated or not, the staging tree has no static URL.
        for path in ("/uploads/staging/fixed/DS/metadata.json",
                     "/uploads/state/fixed__DS.json",
                     "/uploads/",
                     "/%75ploads/staging/fixed/DS/metadata.json",
                     "/x/../uploads/staging/fixed/DS/metadata.json"):
            status, _, _ = self.request("GET", path)
            self.assertIn(status, (403, 404), f"{path} leaked with status {status}")
            status, _, _ = self.request("HEAD", path)
            self.assertIn(status, (403, 404), f"HEAD {path} leaked with status {status}")

    def test_the_blob_proxy_is_the_only_way_in(self):
        self.login()
        blobs = self.full_dataset()
        status, hdrs, data = self.request(
            "GET", "/api/upload.php?action=blob&ds=fixed/DS&path=bricks/lod0/c0/pack_00.bin")
        self.assertEqual(status, 200)
        self.assertEqual(data, blobs["bricks/lod0/c0/pack_00.bin"])
        # Opaque octets, never a document: no sniffing, no caching.
        self.assertEqual(hdrs.get("Content-Type"), "application/octet-stream")
        self.assertEqual(hdrs.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(hdrs.get("Cache-Control"), "no-store")

    def test_the_blob_proxy_refuses_traversal(self):
        self.login()
        self.full_dataset()
        for bad in ("../../../api/admin_credential.json", "/etc/passwd",
                    "bricks/../../../../api/admin_credential.json", "../state/fixed__DS.json"):
            status, _ = self.json_request(
                "GET", f"/api/upload.php?action=blob&ds=fixed/DS&path={bad}")
            self.assertEqual(status, 404, f"{bad} must not resolve")

    def test_range_requests_work(self):
        """The brick loader fetches whole packs but may retry a partial range."""
        self.login()
        blobs = self.full_dataset()
        status, hdrs, data = self.request(
            "GET", "/api/upload.php?action=blob&ds=fixed/DS&path=bricks/lod0/c0/pack_00.bin",
            headers={"Range": "bytes=2-5"})
        self.assertEqual(status, 206)
        self.assertEqual(data, blobs["bricks/lod0/c0/pack_00.bin"][2:6])
        self.assertEqual(hdrs.get("Content-Range"), "bytes 2-5/10")


class TestChunkWire(UploadApiCase):
    def test_a_raw_octet_chunk_round_trips(self):
        self.login()
        blob = b"Z" * 4096
        status, plan = self.plan({"bricks/lod0/c0/pack_00.bin": blob})
        self.assertEqual(status, 200)
        self.assertEqual(plan["datasets"][0]["files"][0]["missing"], [0])
        status, payload = self.send("bricks/lod0/c0/pack_00.bin", blob)
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["done"])
        status, payload = self.finish("bricks/lod0/c0/pack_00.bin")
        self.assertEqual(status, 200, payload)
        self.assertEqual(
            (us.STAGING_DIR / "fixed/DS/bricks/lod0/c0/pack_00.bin").read_bytes(), blob)

    def test_a_tampered_chunk_is_refused_over_the_wire(self):
        self.login()
        blob = b"Z" * 4096
        self.plan({"bricks/lod0/c0/pack_00.bin": blob})
        status, payload = self.send("bricks/lod0/c0/pack_00.bin", blob, sha="0" * 64)
        self.assertEqual(status, 422)
        self.assertEqual(payload["error"], "checksum_mismatch")
        self.assertFalse((us.STAGING_DIR / "fixed/DS/bricks/lod0/c0/pack_00.bin").exists())

    def test_an_oversized_body_is_refused_before_it_is_read(self):
        self.login()
        status, _, _ = self.request(
            "POST", "/api/upload.php?action=chunk&ds=fixed/DS&path=metadata.json&index=0",
            b"", {"Content-Type": "application/octet-stream",
                  "Content-Length": str(dev_server._MAX_UPLOAD_BODY + 1)}, raw=True)
        self.assertEqual(status, 413)

    def test_a_disallowed_path_is_refused_over_the_wire(self):
        self.login()
        for bad in ("evil.php", "../../api/admin_credential.json", ".htaccess"):
            status, payload = self.send(bad, b"x")
            self.assertEqual(status, 400, (bad, payload))


class TestLifecycle(UploadApiCase):
    def test_state_progresses_and_publish_moves_the_dataset(self):
        self.login()
        self.full_dataset()
        status, info = self.json_request("GET", "/api/upload.php?action=state&ds=fixed/DS")
        self.assertEqual(status, 200)
        self.assertEqual(info["state"], us.STATE_STAGED)

        status, v = self.json_request("POST", "/api/upload.php?action=validate&ds=fixed/DS")
        self.assertTrue(v["ok"], v)

        status, r = self.json_request("POST", "/api/upload.php?action=publish&ds=fixed/DS",
                                      {"hidden": True})
        self.assertEqual(status, 200, r)
        published = dev_server.DATA_WEB / "fixed" / "DS" / "metadata.json"
        self.assertTrue(published.exists())
        self.assertTrue(json.loads(published.read_text())["hidden"])

    def test_a_staged_dataset_is_listed_and_editable_through_the_datasets_api(self):
        self.login()
        self.full_dataset()
        status, listing = self.json_request("GET", "/api/datasets.php?action=list")
        self.assertEqual(status, 200)
        row = next((d for d in listing["datasets"] if d["id"] == "staging:fixed/DS"), None)
        self.assertIsNotNone(row, "a staged dataset must appear in the editor list")
        self.assertTrue(row["staging"])
        self.assertTrue(row["stagingEditable"])
        self.assertTrue(row["hidden"], "a staged dataset is never in the public catalog")

        # The editor reads it, edits it, and the edit sticks.
        status, meta = self.json_request(
            "GET", "/api/datasets.php?action=get&id=staging%3Afixed%2FDS")
        self.assertEqual(status, 200, meta)
        self.assertEqual(meta["path"], "staging:fixed/DS")
        # The pipeline's DATA_WEB paths must be rewritten onto the proxy: the
        # dataset has no DATA_WEB location yet, and must not appear to have one.
        src = meta["volumeSources"][0]
        self.assertTrue(src["path"].startswith("api/upload.php?action=blob"), src)
        self.assertTrue(src["manifestPath"].endswith("path=bricks/manifest.json"), src)
        self.assertNotIn("DATA_WEB/", src["path"])

        status, r = self.json_request(
            "POST", "/api/datasets.php?action=save&id=staging%3Afixed%2FDS",
            {**META, "name": "Renamed while uploading"})
        self.assertEqual(status, 200, r)
        self.assertEqual(us.read_staged_metadata("fixed", "DS")["name"], "Renamed while uploading")

        # And re-sending the pipeline's original metadata does NOT clobber it.
        original = json.dumps(META).encode()
        self.plan({"metadata.json": original})
        status, payload = self.send("metadata.json", original)
        self.assertEqual(status, 200)
        self.assertEqual(payload.get("skipped"), "locked")
        self.assertEqual(us.read_staged_metadata("fixed", "DS")["name"], "Renamed while uploading")

    def test_a_published_dataset_leaves_the_staging_list(self):
        self.login()
        self.full_dataset()
        self.json_request("POST", "/api/upload.php?action=publish&ds=fixed/DS", {})
        status, listing = self.json_request("GET", "/api/upload.php?action=list")
        self.assertEqual([d["key"] for d in listing["datasets"]], [])
        status, listing = self.json_request("GET", "/api/datasets.php?action=list")
        ids = [d["id"] for d in listing["datasets"]]
        self.assertIn("fixed/DS", ids)
        self.assertNotIn("staging:fixed/DS", ids)

    def test_discard_removes_everything(self):
        self.login()
        self.full_dataset()
        status, r = self.json_request("POST", "/api/upload.php?action=discard&ds=fixed/DS", {})
        self.assertEqual(status, 200, r)
        self.assertFalse((us.STAGING_DIR / "fixed/DS").exists())

    def test_limits_advertises_a_usable_chunk_size(self):
        self.login()
        status, limits = self.json_request("GET", "/api/upload.php?action=limits")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(limits["chunkSize"], us.MIN_CHUNK_SIZE)
        self.assertLessEqual(limits["chunkSize"], limits["maxChunkSize"])
        self.assertGreaterEqual(limits["parallel"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
