"""Hardening of the Python servers: release verification, login throttling,
sessions, request bodies, static caching/compression, document allowlist,
statistics, staging robustness and publish leftovers.

Run: python tests/test_pyserver_hardening.py
"""
import errno
import gzip
import hashlib
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)
import dev_server  # noqa: E402
import upload_staging as us  # noqa: E402


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ── Release verification ─────────────────────────────────────────────────────

class TestReleaseVerification(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.zip = self.tmp / "release.zip"
        self.zip.write_bytes(b"PK-not-really-a-zip")
        self._pub = dev_server._RELEASE_PUBKEY_HEX
        dev_server._RELEASE_PUBKEY_HEX = ""

    def tearDown(self):
        dev_server._RELEASE_PUBKEY_HEX = self._pub
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, sums: bytes, name="lumen3d-web-9.9.9.zip", sums_url="https://x/SHA256SUMS"):
        info = {"assetName": name, "sumsUrl": sums_url, "assetUrl": "https://x/a.zip"}
        with mock.patch.object(dev_server, "_fetch_url_bytes", lambda url, **kw: sums):
            dev_server._verify_release_download(info, self.zip)

    def test_listed_and_matching_passes(self):
        self._run(f"{sha(self.zip.read_bytes())}  lumen3d-web-9.9.9.zip\n".encode())

    def test_asset_missing_from_sums_is_refused(self):
        with self.assertRaises(OSError):
            self._run(f"{'ab' * 32}  lumen3d-web-1.0.0.zip\n".encode())

    def test_digest_mismatch_is_refused(self):
        with self.assertRaises(OSError):
            self._run(f"{'ab' * 32}  lumen3d-web-9.9.9.zip\n".encode())

    def test_no_sums_is_refused(self):
        with self.assertRaises(OSError):
            self._run(b"", sums_url=None)

    def _check(self, assets):
        rel = {"tag_name": "v9.9.9", "assets": assets, "body": ""}
        with mock.patch.object(dev_server, "_http_get_json", lambda url, **kw: rel), \
             mock.patch.object(dev_server, "_max_version", lambda d: "1.0.0"):
            return dev_server._update_check()

    def test_asset_must_carry_the_tag_version(self):
        sums = {"name": "SHA256SUMS", "browser_download_url": "https://x/S"}
        info = self._check([{"name": "lumen3d-web-evil.zip", "browser_download_url": "u"}, sums])
        self.assertIsNone(info["assetUrl"])
        self.assertEqual(info["assetError"], "asset_name_mismatch")
        info = self._check([{"name": "lumen3d-web-9.9.9.zip", "browser_download_url": "u",
                             "size": 3}, sums])
        self.assertEqual(info["assetUrl"], "u")
        self.assertIsNone(info["assetError"])
        info = self._check([{"name": "lumen3d-web-9.9.9.zip", "browser_download_url": "u"}])
        self.assertEqual(info["assetError"], "no_checksums")

    def test_start_update_refuses_an_unverifiable_release(self):
        fake = {"available": True, "latest": "9.9.9", "assetUrl": None, "zipUrl": "z",
                "sumsUrl": None, "assetError": "no_release_asset"}
        with mock.patch.object(dev_server, "_update_check", lambda: fake), \
             mock.patch.object(dev_server, "JOURNAL_FILE", self.tmp / "none.json"):
            ok, status, payload = dev_server._start_update()
        self.assertFalse(ok)
        self.assertEqual(payload["error"], "unverifiable_release")
        self.assertFalse(dev_server._UPDATE_STATE["running"])


# ── Login throttling, credentials, sessions ──────────────────────────────────

class TestBruteForce(unittest.TestCase):
    def setUp(self):
        dev_server._BRUTE.clear()

    def tearDown(self):
        dev_server._BRUTE.clear()

    def test_parallel_burst_is_capped(self):
        results = []
        lock = threading.Lock()

        def attempt():
            r = dev_server._brute_reserve("198.51.100.1")
            with lock:
                results.append(r)

        threads = [threading.Thread(target=attempt) for _ in range(60)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sum(1 for r in results if r is None), dev_server.MAX_ATTEMPTS)

    def test_expired_lock_starts_a_fresh_count(self):
        for _ in range(dev_server.MAX_ATTEMPTS):
            dev_server._brute_reserve("k")
        self.assertIsNotNone(dev_server._brute_reserve("k"))
        dev_server._BRUTE["k"]["until"] = 1.0          # lockout elapsed
        self.assertIsNone(dev_server._brute_reserve("k"))
        self.assertEqual(dev_server._BRUTE["k"]["count"], 1)

    def test_table_is_bounded(self):
        with mock.patch.object(dev_server, "_BRUTE_MAX_ENTRIES", 50):
            for i in range(200):
                dev_server._brute_reserve(f"10.0.{i // 250}.{i % 250}")
            self.assertLessEqual(len(dev_server._BRUTE), 50)


class TestCredentials(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._cred = dev_server.CRED_FILE
        dev_server.CRED_FILE = self.tmp / "admin_credential.json"

    def tearDown(self):
        dev_server.CRED_FILE = self._cred
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_unknown_user_still_runs_one_pbkdf2(self):
        dev_server._write_credential_force("admin", "correct-horse")
        calls = []
        real = dev_server._verify_password
        with mock.patch.object(dev_server, "_verify_password",
                               lambda p, s: calls.append(s) or real(p, s)):
            self.assertFalse(dev_server._check_credentials("root", "correct-horse"))
        self.assertEqual(calls, [dev_server._dummy_hash()])

    def test_legacy_hash_is_upgraded_on_login(self):
        rec = {"version": 1, "username": "admin",
               "password_pbkdf2": hashlib.sha256(b"oldpassword").hexdigest()}
        dev_server.CRED_FILE.write_text(json.dumps(rec), encoding="utf-8")
        self.assertTrue(dev_server._check_credentials("admin", "oldpassword"))
        stored = json.loads(dev_server.CRED_FILE.read_text(encoding="utf-8"))["password_pbkdf2"]
        self.assertTrue(stored.startswith(f"pbkdf2_sha256${dev_server.PBKDF2_ITERATIONS}$"))
        self.assertTrue(dev_server._check_credentials("admin", "oldpassword"))

    def test_non_ascii_legacy_value_does_not_raise(self):
        self.assertFalse(dev_server._verify_password("x", "é" * 64))

    def test_setup_leaves_no_partial_file(self):
        ok, status, _ = dev_server._setup_credential("admin", "long-enough")
        self.assertTrue(ok)
        ok, status, payload = dev_server._setup_credential("admin", "another-one")
        self.assertEqual((ok, status), (False, 409))
        self.assertEqual([p.name for p in self.tmp.iterdir()], ["admin_credential.json"])


class TestSessions(unittest.TestCase):
    def tearDown(self):
        dev_server._SESSIONS.clear()

    def test_password_change_revokes_other_sessions(self):
        a = dev_server._new_session("admin")
        b = dev_server._new_session("admin")
        self.assertEqual(dev_server._revoke_other_sessions(a), 1)
        self.assertIsNotNone(dev_server._get_session(a))
        self.assertIsNone(dev_server._get_session(b))

    def test_store_is_bounded(self):
        with mock.patch.object(dev_server, "MAX_SESSIONS", 5):
            for _ in range(20):
                dev_server._new_session("admin")
            self.assertLessEqual(len(dev_server._SESSIONS), 5)


# ── Range parser ─────────────────────────────────────────────────────────────

class TestRangeParser(unittest.TestCase):
    def test_forms(self):
        p = dev_server._parse_byte_range
        self.assertEqual(p("bytes=-500", 1000), (500, 999))
        self.assertEqual(p("bytes=-5000", 1000), (0, 999))
        self.assertEqual(p("bytes=10-", 1000), (10, 999))
        self.assertEqual(p("bytes=10-99999", 1000), (10, 999))
        self.assertIs(p("bytes=1000-", 1000), dev_server._RANGE_UNSATISFIABLE)
        self.assertIs(p("bytes=-0", 1000), dev_server._RANGE_UNSATISFIABLE)
        for bad in ("bytes=5-1", "bytes=0-1,4-5", "bytes= 1_0-20", "items=0-1", "bytes=-", None):
            self.assertIsNone(p(bad, 1000), bad)


# ── Statistics ───────────────────────────────────────────────────────────────

class TestDownloadCounter(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._dw, self._stats = dev_server.DATA_WEB, dev_server.STATS_FILE
        dev_server.DATA_WEB = self.tmp / "DATA_WEB"
        dev_server.STATS_FILE = self.tmp / "stats.json"
        (dev_server.DATA_WEB / "3d" / "Real" / "download").mkdir(parents=True)

    def tearDown(self):
        dev_server._flush_stats()
        dev_server.DATA_WEB, dev_server.STATS_FILE = self._dw, self._stats
        shutil.rmtree(self.tmp, ignore_errors=True)

    class _H:
        headers = {}
        _head_only = False

    def test_only_existing_datasets_are_counted(self):
        h = self._H()
        dev_server.AdminHandler._maybe_count_download(h, "DATA_WEB/3d/Invented/download/x.zip")
        dev_server.AdminHandler._maybe_count_download(h, "DATA_WEB/3d/Real/download/x.zip")
        rows = dev_server._load_stats()["datasets"]
        self.assertEqual(list(rows), ["3d/Real"])

    def test_events_are_batched(self):
        for _ in range(5):
            dev_server._record_event("visit")
        self.assertEqual(dev_server._load_stats()["global"]["visits"], 5)


# ── Static serving, documents, request bodies (live server) ──────────────────

class LiveServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls._stats = dev_server.STATS_FILE
        dev_server.STATS_FILE = cls.tmp / "stats.json"
        cls.httpd = dev_server._QuietServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        dev_server._flush_stats()
        dev_server.STATS_FILE = cls._stats
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def req(self, method, path, headers=None, body=None, conn=None):
        own = conn is None
        conn = conn or http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        if own:
            conn.close()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, data

    def test_js_is_revalidated_compressed_and_sniff_proof(self):
        raw = (ROOT / "js/core/plugin-registry.js").read_bytes()
        st, h, body = self.req("GET", "/js/core/plugin-registry.js",
                               {"Accept-Encoding": "gzip"})
        self.assertEqual(st, 200)
        self.assertEqual(h.get("content-encoding"), "gzip")
        self.assertEqual(gzip.decompress(body), raw)
        self.assertEqual(h.get("cache-control"), "no-cache")
        self.assertEqual(h.get("x-content-type-options"), "nosniff")
        self.assertIn("javascript", h.get("content-type", ""))
        st, h2, body = self.req("GET", "/js/core/plugin-registry.js",
                                {"Accept-Encoding": "gzip", "If-None-Match": h["etag"]})
        self.assertEqual((st, body), (304, b""))
        st, h3, _ = self.req("GET", "/js/core/plugin-registry.js?v=1.2.3")
        self.assertIn("immutable", h3.get("cache-control", ""))

    def test_catalog_is_revalidated(self):
        st, h, body = self.req("GET", "/DATA_WEB/catalog.json", {"Accept-Encoding": "gzip"})
        self.assertEqual(st, 200)
        data = gzip.decompress(body) if h.get("content-encoding") == "gzip" else body
        self.assertIsInstance(json.loads(data), list)
        st, _, body = self.req("GET", "/DATA_WEB/catalog.json", {"If-None-Match": h["etag"]})
        self.assertEqual((st, body), (304, b""))

    def test_keep_alive(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            for _ in range(3):
                st, h, _ = self.req("GET", "/js/core/compat.js", conn=conn)
                self.assertEqual(st, 200)
        finally:
            conn.close()

    def test_no_directory_listing(self):
        for path in ("/DATA_WEB/", "/DATA_WEB/3d/", "/js/", "/js/core"):
            st, _, body = self.req("GET", path)
            self.assertEqual(st, 404, path)
            self.assertNotIn(b"Directory listing", body)

    def test_only_top_level_pages_are_documents(self):
        st, h, body = self.req("GET", "/Admpan.HTML")
        self.assertEqual(st, 200)
        self.assertIn("nonce-", h.get("content-security-policy", ""))
        self.assertNotIn(b"{{CSP_NONCE}}", body)
        for path in ("/SCRIPTS/viewer_template.html", "/js/modules/x/evil.html",
                     "/DATA_WEB/3d/x/download/a.htm"):
            st, _, _ = self.req("GET", path)
            self.assertEqual(st, 404, path)
        st, hh, body = self.req("HEAD", "/index.html")
        st2, hg, _ = self.req("GET", "/index.html")
        self.assertEqual((st, body), (200, b""))
        self.assertEqual(hh.get("content-length"), hg.get("content-length"))

    def test_dot_segments_are_never_served(self):
        st, _, _ = self.req("GET", "/DATA_WEB/3d/.replaced-x-1/metadata.json")
        self.assertEqual(st, 404)

    def test_body_limits(self):
        st, h, _ = self.req("POST", "/api/telemetry.php?action=visit",
                            {"Content-Length": "-1"})
        self.assertEqual(st, 400)
        st, h, _ = self.req("POST", "/api/auth.php?action=status",
                            {"Content-Length": "999999999"})
        self.assertEqual(st, 413)
        self.assertEqual(h.get("connection", "").lower(), "close")

    def test_upload_body_not_read_without_session(self):
        st, _, body = self.req("POST", "/api/upload.php?action=chunk&ds=3d/X&path=a&index=0",
                               {"Content-Length": str(16 * 1024 * 1024)})
        self.assertEqual(st, 401)

    def test_login_requires_same_origin_json(self):
        st, _, body = self.req("POST", "/api/auth.php?action=login",
                               {"Content-Type": "text/plain"}, body=b'{"username":"a"}')
        self.assertEqual((st, json.loads(body)["error"]), (403, "json_required"))
        st, _, body = self.req("POST", "/api/auth.php?action=login",
                               {"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"},
                               body=b'{"username":"a"}')
        self.assertEqual((st, json.loads(body)["error"]), (403, "cross_origin"))
        st, _, body = self.req("POST", "/api/auth.php?action=login",
                               {"Content-Type": "application/json", "Origin": "https://evil.example"},
                               body=b'{"username":"a"}')
        self.assertEqual(st, 403)

    def test_auth_api_sends_no_cors_grant(self):
        st, h, _ = self.req("GET", "/api/auth.php?action=status")
        self.assertEqual(st, 200)
        self.assertNotIn("access-control-allow-origin", h)

    def test_telemetry_is_post_only(self):
        st, _, _ = self.req("GET", "/api/telemetry.php?action=visit")
        self.assertEqual(st, 405)
        st, _, _ = self.req("POST", "/api/telemetry.php?action=visit", {"Content-Length": "0"})
        self.assertEqual(st, 200)


class TestFastServer(unittest.TestCase):
    def test_static_only_with_the_dev_server_policy(self):
        import fast_server
        srv = fast_server.ServerClass(("127.0.0.1", 0), fast_server.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            def get(method, path):
                c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=20)
                c.request(method, path, body=b"" if method == "POST" else None,
                          headers={"Range": "bytes=0-9"} if path.endswith(".js") else {})
                r = c.getresponse()
                r.read()
                c.close()
                return r.status, r.getheader("Content-Security-Policy") or ""
            self.assertIn("nonce-", get("GET", "/index.html")[1])
            self.assertEqual(get("GET", "/api/auth.php?action=status")[0], 404)
            self.assertEqual(get("POST", "/api/telemetry.php?action=visit")[0], 405)
            self.assertEqual(get("GET", "/js/core/compat.js")[0], 206)
        finally:
            srv.shutdown()
            srv.server_close()


# ── Upload staging ───────────────────────────────────────────────────────────

class StagingCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        us.configure(self.tmp)
        us.ensure_dirs()

    def tearDown(self):
        us.configure(ROOT)
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestStagingHardening(StagingCase):
    def test_active_documents_and_devices_are_refused(self):
        for rel in ("download/notes.xml", "download/a.svg", "download/a.html",
                    "download/CON.zip", "download/nul.txt", "download/a.zip."):
            self.assertIsNone(us.classify_path("3d", rel), rel)
        self.assertIsNotNone(us.classify_path("3d", "download/a.zip"))

    def test_plan_refuses_what_the_disk_cannot_hold(self):
        files = [{"path": "metadata.json", "size": 10 ** 9}]
        with mock.patch.object(us, "_free_bytes", lambda p: us.DISK_RESERVE_BYTES + 1000):
            res = us.plan([{"type": "3d", "folder": "Big", "files": files}])
        ds = res["datasets"][0]
        self.assertEqual(ds["error"], "insufficient_disk")
        self.assertIsNone(us.load_journal("3d", "Big"))

    def test_absurd_size_is_rejected(self):
        res = us.plan([{"type": "3d", "folder": "Huge",
                        "files": [{"path": "metadata.json", "size": 1 << 60}]}])
        self.assertEqual(res["datasets"][0]["rejected"][0]["reason"], "too_large")

    def test_chunk_needs_a_digest_and_reports_a_full_disk(self):
        us.plan([{"type": "3d", "folder": "D", "files": [{"path": "metadata.json", "size": 3}]}])
        st, pl = us.write_chunk("3d", "D", "metadata.json", 0, b"abc", None)
        self.assertEqual((st, pl["error"]), (400, "checksum_required"))
        full = OSError(errno.ENOSPC, "No space left on device")
        with mock.patch.object(us, "save_journal", side_effect=full):
            st, pl = us.write_chunk("3d", "D", "metadata.json", 0, b"abc", sha(b"abc"))
        self.assertEqual((st, pl["error"]), (507, "insufficient_disk"))

    def test_own_temp_files_are_not_strays(self):
        d = us.STAGING_DIR / "3d" / "T"
        d.mkdir(parents=True)
        (d / (us._TMP_PREFIX + "abc")).write_text("{}")
        self.assertEqual(us._find_stray(d, "3d"), [])

    def test_leftovers_are_restored_or_removed(self):
        base = us.DATA_WEB / "3d"
        (base / ".replaced-Lost-1").mkdir(parents=True)
        (base / ".replaced-Lost-1" / "metadata.json").write_text("{}")
        (base / "Kept").mkdir()
        (base / ".replaced-Kept-2").mkdir()
        (base / ".incoming-Kept-3").mkdir()
        log = us.recover_publish_leftovers()
        self.assertTrue((base / "Lost" / "metadata.json").is_file())
        self.assertEqual(sorted(p.name for p in base.iterdir()), ["Kept", "Lost"])
        self.assertEqual(len(log), 3)
        self.assertEqual(us.recover_publish_leftovers(), [])

    def test_catalog_skips_dot_folders(self):
        old = dev_server.DATA_WEB
        dev_server.DATA_WEB = us.DATA_WEB
        try:
            leftover = us.DATA_WEB / "3d" / ".replaced-X-1"
            leftover.mkdir(parents=True)
            (leftover / "metadata.json").write_text(json.dumps({"name": "X", "configured": True}))
            dev_server._CATALOG_CACHE["sig"] = None
            self.assertEqual(dev_server._list_datasets(), [])
            self.assertEqual(dev_server._build_catalog(), [])
        finally:
            dev_server.DATA_WEB = old
            dev_server._CATALOG_CACHE["sig"] = None


if __name__ == "__main__":
    unittest.main(verbosity=1)
