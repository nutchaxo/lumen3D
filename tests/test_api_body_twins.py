"""Request bodies the admin API must refuse, answered alike by both backends.

The same requests go to dev_server.py and to a throwaway copy of the PHP tree under
`php -S router.php`, and each answer is asserted on both:

* dataset `save`: a body that is not a JSON object (garbage, a list, nothing) is a
  400 `Invalid JSON body`; a field whose type the viewer cannot read (name/stage not
  a string, dimensions/voxel_size not an object, channels/volumeSources not a list of
  objects) is a 400 naming the field; nothing is written in either case.
* site `save` of instance/theme/legal: a non-object or empty body, or a structural key
  of the wrong type (`{"brand":5}`, `{"tokens":5}`), is refused and the doc is left
  as it was; a partial `merge=` save and an empty map written as `[]` still pass.
* media upload/delete: a field that is not a string is a 400 with the PHP wording,
  never a 500.
* media upload keeps only what the magic bytes prove (stored extension = the bytes'),
  atomically; media delete: 400 `Invalid file` for a bad name, 404 `Not found` for none.
* site publish of a page nothing backs: 404 `Not found`; of a bad name: 400 `Invalid doc`.
* a failed login carries `code: bad_credentials` beside the legacy `error` text.
* `Unknown action` (`Unknown action.` on auth.php) and `bad_request` for a login,
  setup or change_password body whose fields are not strings.
* first-run setup refuses a cross-site request (text/plain body, Sec-Fetch-Site
  cross-site, a foreign or null Origin) with a 403 and writes no credential.
* catalog.json survives two datasets of one date whose names are not comparable.

Python only (the findings are about dev_server.py): an anonymous POST, or a write
without its CSRF token, is refused before the body is read; an exception inside a
GET route answers a 500 JSON instead of a dropped connection, also on the second
request of a kept-alive connection.

Run: python tests/test_api_body_twins.py
"""
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import dev_server  # noqa: E402
import upload_staging as us  # noqa: E402

PASSWORD = "test-password-1234"
META = {"name": "G", "type": "3d", "id": "3d/G", "date": "2024-01-01", "configured": True}


def _find_php():
    for cand in ("php", r"C:\php-portable\php.exe"):
        p = shutil.which(cand) or (cand if os.path.isfile(cand) else None)
        if p:
            return p
    return None


PHP = _find_php()


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _seed(tree: Path):
    """The dataset fixtures both backends serve: one to edit, two that share a date
    and carry names of incomparable types."""
    for folder, meta in (("G", META),
                         ("N1", {"name": 5, "date": "2023-05-05", "configured": True}),
                         ("N2", {"name": "Beta", "date": "2023-05-05", "configured": True}),
                         ("N3", {"name": ["x"], "date": "2023-05-05", "configured": True})):
        d = tree / "DATA_WEB" / "3d" / folder
        d.mkdir(parents=True, exist_ok=True)
        (d / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    defaults = tree / "config" / "defaults" / "neutral"
    defaults.mkdir(parents=True, exist_ok=True)
    for f in (ROOT / "config" / "defaults" / "neutral").glob("*.json"):
        shutil.copy(f, defaults / f.name)
    (tree / "changelog").mkdir(exist_ok=True)
    (tree / "changelog" / "changelog_1.78.0.md").write_text("x", encoding="utf-8")


class TwinCases:
    """Mixed into one TestCase per backend; `self.call` speaks HTTP to it."""

    tree: Path

    def call(self, method, path, body=None, raw=None, auth=True, csrf=True, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        h = {"Content-Type": "application/json"}
        h.update(headers or {})
        if auth and self.cookie:
            h["Cookie"] = self.cookie
        if auth and csrf and self.csrf:
            h["X-CSRF-Token"] = self.csrf
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if method == "POST" and payload is None:
            payload = b""
        try:
            conn.request(method, path, body=payload, headers=h)
            res = conn.getresponse()
            data = res.read()
            try:
                parsed = json.loads(data.decode("utf-8") or "null")
            except ValueError:
                parsed = None
            return res.status, parsed, res.getheaders()
        finally:
            conn.close()

    def login(self):
        st, data, hdrs = self.call("POST", "/api/auth.php?action=login",
                                   {"username": "admin", "password": PASSWORD}, auth=False)
        if st != 200:
            raise AssertionError(f"login failed: {st} {data}")
        jar = {}
        for k, v in hdrs:
            if k.lower() == "set-cookie":
                name, _, val = v.split(";")[0].partition("=")
                jar[name.strip()] = val
        self.cookie = "; ".join(f"{k}={v}" for k, v in jar.items() if v and v != "deleted")
        self.csrf = data["csrf"]

    def meta(self):
        return json.loads((self.tree / "DATA_WEB" / "3d" / "G" / "metadata.json").read_text(encoding="utf-8"))

    def site_doc(self, doc):
        st, data, _ = self.call("GET", f"/api/site.php?action=get&doc={doc}")
        self.assertEqual(st, 200, data)
        return data

    # ── datasets.php save ───────────────────────────────────────────────────────

    def test_dataset_save_refuses_non_object_bodies(self):
        before = self.meta()
        for raw in (b"garbage", b"[1,2]", b'"x"', b"5", b""):
            st, data, _ = self.call("POST", "/api/datasets.php?action=save&id=3d/G", raw=raw)
            self.assertEqual((st, data), (400, {"error": "Invalid JSON body"}), raw)
        self.assertEqual(self.meta(), before, "a refused save writes nothing")

    def test_dataset_save_refuses_malformed_fields(self):
        before = self.meta()
        cases = [({"name": ["x"]}, "name"), ({"name": 5}, "name"), ({"stage": {"a": 1}}, "stage"),
                 ({"volumeSources": 5}, "volumeSources"), ({"volumeSources": [1]}, "volumeSources"),
                 ({"volumeSources": {}}, "volumeSources"), ({"channels": "a"}, "channels"),
                 ({"channels": [{"name": "c"}, None]}, "channels"), ({"dimensions": []}, "dimensions"),
                 ({"dimensions": None}, "dimensions"), ({"voxel_size": 1}, "voxel_size"),
                 ({"name": "ok", "volumeSources": 5, "channels": "a"}, "channels")]
        for body, field in cases:
            st, data, _ = self.call("POST", "/api/datasets.php?action=save&id=3d/G", body)
            self.assertEqual((st, data), (400, {"error": "Invalid field", "field": field}), body)
        self.assertEqual(self.meta(), before, "a refused save writes nothing")

    def test_dataset_save_accepts_a_well_formed_doc(self):
        body = {"name": "Renamed", "stage": None, "channels": [{"name": "c", "color": "#fff"}],
                "volumeSources": [], "dimensions": {"x": 2, "y": 2, "z": 2},
                "voxel_size": {"x": 1, "y": 1, "z": 1}, "embryo": 3}
        st, data, _ = self.call("POST", "/api/datasets.php?action=save&id=3d/G", body)
        self.assertEqual(st, 200, data)
        self.assertEqual(self.meta()["name"], "Renamed")
        st, data, _ = self.call("POST", "/api/datasets.php?action=save&id=3d/G", {})
        self.assertEqual(st, 200, "an empty object is a valid (no-op) edit")
        self.assertEqual(self.meta()["name"], "Renamed")

    # ── site.php save ───────────────────────────────────────────────────────────

    def test_site_save_refuses_corrupting_bodies(self):
        st, _d, _h = self.call("POST", "/api/site.php?action=save&doc=instance",
                               {"brand": {"name": "Kept"}, "nav": {"showAbout": True}})
        self.assertEqual(st, 200)
        theme_before = self.site_doc("theme")
        legal_before = self.site_doc("legal")
        cases = [("instance", b"garbage", "Invalid JSON body"), ("instance", b"[1]", "Invalid JSON body"),
                 ("instance", b"", "Invalid JSON body"), ("instance", b"{}", "empty_doc"),
                 ("instance", b'{"brand":5}', "Invalid 'brand'"), ("instance", b'{"nav":[1]}', "Invalid 'nav'"),
                 ("instance", b'{"channelColorPresets":{}}', "Invalid 'channelColorPresets'"),
                 ("theme", b'{"tokens":5}', "Invalid 'tokens'"), ("theme", b'{"dark":"x"}', "Invalid 'dark'"),
                 ("legal", b'{"sections":{"a":1}}', "Invalid 'sections'"),
                 ("pages/news", b"[1,2]", "Invalid JSON body")]
        for doc, raw, err in cases:
            st, data, _ = self.call("POST", f"/api/site.php?action=save&doc={doc}", raw=raw)
            self.assertEqual((st, data), (400, {"error": err}), (doc, raw))
        st, data, _ = self.call("POST", "/api/site.php?action=save&doc=instance&merge=brand", raw=b'{"brand":5}')
        self.assertEqual((st, data), (400, {"error": "Invalid 'brand'"}))
        inst = self.site_doc("instance")
        self.assertEqual(inst.get("brand"), {"name": "Kept"}, "the doc survives every refusal")
        self.assertEqual(self.site_doc("theme"), theme_before)
        self.assertEqual(self.site_doc("legal"), legal_before)

    def test_site_save_keeps_valid_partial_saves(self):
        st, data, _ = self.call("POST", "/api/site.php?action=save&doc=instance",
                                {"brand": {"name": "A", "shortName": "S"}, "seo": {"description": "d"}})
        self.assertEqual(st, 200, data)
        st, data, _ = self.call("POST", "/api/site.php?action=save&doc=instance&merge=brand.name",
                                {"brand": {"name": "B"}})
        self.assertEqual(st, 200, data)
        st, data, _ = self.call("POST", "/api/site.php?action=save&doc=instance&merge=seo", {})
        self.assertEqual(st, 200, "a merge save may remove its listed path")
        inst = self.site_doc("instance")
        self.assertEqual(inst["brand"], {"name": "B", "shortName": "S"})
        self.assertNotIn("seo", inst)
        st, data, _ = self.call("POST", "/api/site.php?action=save&doc=theme",
                                {"tokens": {"--color-primary": "#123456"}, "dark": [], "light": {}})
        self.assertEqual(st, 200, "an empty map written as [] by an old PHP host still saves")

    # ── media.php ───────────────────────────────────────────────────────────────

    def test_media_non_string_fields(self):
        bad_type = "Type de fichier non supporté (png, jpg, webp, gif, avif)"
        empty = "Fichier vide ou trop volumineux (max 8 Mo)"
        for body, err in (({"filename": 5, "data": "x"}, bad_type), ({"name": ["a.png"]}, bad_type),
                          ({"filename": "a.png", "data": 5}, empty), ({"filename": "a.png", "data": {"x": 1}}, empty)):
            st, data, _ = self.call("POST", "/api/media.php?action=upload", body)
            self.assertEqual((st, data), (400, {"ok": False, "error": err}), body)
        for body in ({"name": 5}, {"name": ["a.png"]}, {}):
            st, data, _ = self.call("POST", "/api/media.php?action=delete", body)
            self.assertEqual((st, data), (400, {"error": "Invalid file"}), body)

    def _upload(self, filename, raw_bytes=None, data=None):
        import base64
        payload = data if data is not None else base64.b64encode(raw_bytes).decode()
        return self.call("POST", "/api/media.php?action=upload", {"filename": filename, "data": payload})

    PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
    JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 24
    GIF = b"GIF89a" + b"\x00" * 24
    WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 24
    AVIF = b"\x00\x00\x00\x1cftypavif" + b"\x00" * 24

    def test_media_upload_checks_the_magic_bytes(self):
        bad_type = "Type de fichier non supporté (png, jpg, webp, gif, avif)"
        empty = "Fichier vide ou trop volumineux (max 8 Mo)"
        for fname, raw in (("x.png", b"<?php echo 1; ?>"), ("x.png", b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
                           ("x.jpg", b"not an image at all"), ("x.gif", b"GIF90a" + b"\x00" * 8)):
            st, data, _ = self._upload(fname, raw)
            self.assertEqual((st, data), (400, {"ok": False, "error": bad_type}), (fname, raw))
        for fname, payload in (("x.png", "!!!not base64!!!"), ("x.png", ""), ("x.png", "A")):
            st, data, _ = self._upload(fname, data=payload)
            self.assertEqual((st, data), (400, {"ok": False, "error": empty}), (fname, payload))
        stored = [p.name for p in (self.tree / "config" / "uploads").glob("*") if not p.name.startswith(".")] \
            if (self.tree / "config" / "uploads").is_dir() else []
        self.assertFalse([n for n in stored if n.startswith("x")], "nothing refused was stored")

    def test_media_upload_extension_follows_the_bytes(self):
        import base64
        cases = (("photo.jpeg", self.PNG, "photo.png"), ("a.png", self.JPG, "a.jpg"), ("b.webp", self.GIF, "b.gif"),
                 ("c.gif", self.WEBP, "c.webp"), ("d.png", self.AVIF, "d.avif"))
        for fname, raw, want in cases:
            st, data, _ = self._upload(fname, raw)
            self.assertEqual(st, 200, (fname, data))
            self.assertEqual(data, {"ok": True, "url": f"config/uploads/{want}", "name": want})
            self.assertEqual((self.tree / "config" / "uploads" / want).read_bytes(), raw)
        # a data: URL, whitespace inside the base64 and a name already taken
        url = "data:image/png;base64," + base64.b64encode(self.PNG).decode()
        st, data, _ = self._upload("photo.png", data=url)
        self.assertEqual((st, data["name"]), (200, "photo-1.png"))
        st, data, _ = self._upload("sp.png", data=base64.b64encode(self.PNG).decode()[:8] + "\n " + base64.b64encode(self.PNG).decode()[8:])
        self.assertEqual((st, data["name"]), (200, "sp.png"))
        left = [p.name for p in (self.tree / "config" / "uploads").iterdir() if p.name.startswith(".tmp")]
        self.assertEqual(left, [], "the write is atomic: no temporary file stays")

    def test_media_delete_statuses(self):
        st, data, _ = self._upload("gone.png", self.PNG)
        self.assertEqual(st, 200)
        st, data, _ = self.call("POST", "/api/media.php?action=delete", {"name": "gone.png"})
        self.assertEqual((st, data), (200, {"ok": True}))
        self.assertFalse((self.tree / "config" / "uploads" / "gone.png").exists())
        st, data, _ = self.call("POST", "/api/media.php?action=delete", {"name": "gone.png"})
        self.assertEqual((st, data), (404, {"error": "Not found"}), "no such file")
        for name in ("script.php", "noext", "../x"):
            st, data, _ = self.call("POST", "/api/media.php?action=delete", {"name": name})
            self.assertEqual((st, data), (400, {"error": "Invalid file"}), name)

    # ── site.php publish ────────────────────────────────────────────────────────

    def test_publish_statuses(self):
        st, data, _ = self.call("POST", "/api/site.php?action=publish&doc=pages/never-written", {})
        self.assertEqual((st, data), (404, {"error": "Not found"}), "a page nothing backs")
        for doc in ("pages/Bad Slug", "unknown", "pages/../x"):
            st, data, _ = self.call("POST", f"/api/site.php?action=publish&doc={doc.replace(' ', '%20')}", {})
            self.assertEqual((st, data), (400, {"error": "Invalid doc"}), doc)
        st, data, _ = self.call("POST", "/api/site.php?action=save_draft&doc=pages/news",
                                {"title": {"en": "N"}, "draft": {"sections": []}})
        self.assertEqual(st, 200, data)
        st, data, _ = self.call("POST", "/api/site.php?action=publish&doc=pages/news", {})
        self.assertEqual(st, 200, data)
        self.assertTrue(data["ok"] and isinstance(data["rev"], str))

    # ── site.php: empty objects stay objects ────────────────────────────────────

    def stored(self, rel):
        return json.loads((self.tree / rel).read_text(encoding="utf-8"))

    def test_site_empty_objects_round_trip(self):
        draft = {"sections": [{"id": "s", "props": {}, "columns": [
            {"id": "c", "width": 12, "props": {}, "widgets": [{"type": "spacer", "props": {}}]}]}]}
        st, data, _ = self.call("POST", "/api/site.php?action=save_draft&doc=pages/emptyobj",
                                {"title": {"en": "E"}, "draft": draft})
        self.assertEqual(st, 200, data)
        self.assertEqual(self.stored("api/page-drafts/emptyobj.json"), draft, "the stored draft keeps every {}")
        self.assertEqual(self.site_doc("pages/emptyobj")["draft"], draft, "get answers {} as {}")
        st, data, _ = self.call("POST", "/api/site.php?action=publish&doc=pages/emptyobj", {})
        self.assertEqual(st, 200, data)
        self.assertEqual(self.stored("config/pages/emptyobj.json")["published"], draft, "publish keeps every {}")
        self.assertEqual(self.stored("api/page-drafts/emptyobj.json"), draft)

        st, data, _ = self.call("POST", "/api/site.php?action=save_draft&doc=pages/emptyobj", {"draft": {}})
        self.assertEqual(st, 200, "an empty draft is an object")
        self.assertEqual(self.stored("api/page-drafts/emptyobj.json"), {})
        self.assertEqual(self.site_doc("pages/emptyobj")["draft"], {})
        for body, err in (({"draft": []}, "Invalid 'draft' block"), ({"draft": [1]}, "Invalid 'draft' block"),
                          ({"draft": {"sections": {"a": {}}}}, "Invalid sections"),
                          ({"draft": {"sections": [[1]]}}, "Invalid section"),
                          ({"draft": {"sections": [{"columns": {"a": 1}}]}}, "Invalid columns"),
                          ({"draft": {"sections": [{"columns": [{"widgets": [{}]}]}]}}, "Invalid widget")):
            st, data, _ = self.call("POST", "/api/site.php?action=save_draft&doc=pages/emptyobj", body)
            self.assertEqual((st, data), (400, {"error": err}), body)

        page = {"title": {"en": "P"}, "published": {"sections": [{"props": {}, "columns": [{"props": {}}]}]}, "draft": {}}
        st, data, _ = self.call("POST", "/api/site.php?action=save&doc=pages/emptyobj", page)
        self.assertEqual(st, 200, data)
        self.assertEqual(self.stored("config/pages/emptyobj.json")["published"], page["published"])
        self.assertEqual(self.stored("api/page-drafts/emptyobj.json"), {})

        st, data, _ = self.call("POST", "/api/site.php?action=save&doc=instance",
                                {"brand": {"name": "A"}, "seo": {}, "footer": {"links": []}})
        self.assertEqual(st, 200, data)
        st, data, _ = self.call("POST", "/api/site.php?action=save&doc=instance&merge=brand.name",
                                {"brand": {"name": "B"}})
        self.assertEqual(st, 200, data)
        inst = self.stored("config/instance.json")
        self.assertEqual((inst["brand"], inst["seo"], inst["footer"]), ({"name": "B"}, {}, {"links": []}),
                         "a merge rewrites the stored doc with its {} and [] intact")
        self.assertEqual(self.site_doc("instance")["seo"], {})

    # ── parity bits ─────────────────────────────────────────────────────────────

    def test_bad_credentials_carry_a_stable_code(self):
        st, data, _ = self.call("POST", "/api/auth.php?action=login",
                                {"username": "admin", "password": "wrong-password"}, auth=False)
        self.assertEqual((st, data), (401, {"error": "Identifiants incorrects.", "code": "bad_credentials"}))

    def test_unknown_action_wording(self):
        for ep in ("datasets", "site", "media", "admin"):
            st, data, _ = self.call("POST", f"/api/{ep}.php?action=nope%3Cb%3E", {})
            self.assertEqual((st, data), (400, {"error": "Unknown action"}), ep)
        st, data, _ = self.call("POST", "/api/auth.php?action=nope", {})
        self.assertEqual((st, data), (400, {"error": "Unknown action."}))

    def test_malformed_credential_bodies(self):
        for body in ({"username": 5, "password": "x"}, {"username": "admin", "password": ["x"]}, None):
            st, data, _ = self.call("POST", "/api/auth.php?action=login", body, auth=False)
            self.assertEqual((st, data), (400, {"error": "bad_request"}), body)
        st, data, _ = self.call("POST", "/api/auth.php?action=setup", {"username": 5, "password": "x" * 10}, auth=False)
        self.assertEqual((st, data), (400, {"error": "bad_request"}))
        st, data, _ = self.call("POST", "/api/auth.php?action=change_password", {"current": 5, "new": "y" * 10})
        self.assertEqual((st, data), (400, {"error": "bad_request"}))

    def test_setup_refuses_a_cross_site_claim_of_a_fresh_install(self):
        cred = self.tree / "api" / "admin_credential.json"
        aside = cred.with_name("admin_credential.json.aside")
        cred.replace(aside)
        try:
            body = json.dumps({"username": "x", "password": "attacker-password"}).encode()
            for headers in ({"Content-Type": "text/plain"},
                            {"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"},
                            {"Content-Type": "application/json", "Origin": "http://evil.example"},
                            {"Content-Type": "application/json", "Origin": "null"}):
                st, data, _ = self.call("POST", "/api/auth.php?action=setup", raw=body, auth=False, headers=headers)
                self.assertEqual(st, 403, (headers, data))
                self.assertFalse(cred.exists(), f"a refused setup wrote a credential: {headers}")
        finally:
            cred.unlink(missing_ok=True)
            aside.replace(cred)
        st, data, _ = self.call("POST", "/api/auth.php?action=setup",
                                {"username": "x", "password": "y" * 12}, auth=False,
                                headers={"Sec-Fetch-Site": "same-origin"})
        self.assertEqual((st, data), (409, {"error": "already_configured"}), "same-origin JSON reaches the setup")

    # ── catalog ─────────────────────────────────────────────────────────────────

    def test_catalog_with_incomparable_names(self):
        st, data, _ = self.call("GET", "/DATA_WEB/catalog.json", auth=False)
        self.assertEqual(st, 200)
        names = [d.get("name") for d in data]
        self.assertEqual(names[0], "G", "newest date first")
        self.assertEqual(names[1:], ["Beta", 5, ["x"]], "same date: name descending, non-scalar last")


class PythonBackend(TwinCases, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tree = Path(tempfile.mkdtemp(prefix="lumen-twins-py-"))
        (cls.tree / "api").mkdir()
        _seed(cls.tree)
        keys = ("ROOT", "DATA_WEB", "CRED_FILE", "UPLOADS_DIR", "CHANGELOG_DIR", "CONFIG_DIR",
                "CONFIG_DEFAULTS_DIR", "INSTANCE_FILE", "THEME_CSS_FILE", "PAGE_DRAFTS_DIR", "MEDIA_DIR")
        cls._saved = {k: getattr(dev_server, k) for k in keys}
        dev_server.ROOT = cls.tree
        dev_server.DATA_WEB = cls.tree / "DATA_WEB"
        dev_server.CRED_FILE = cls.tree / "api" / "admin_credential.json"
        dev_server.UPLOADS_DIR = cls.tree / "uploads"
        dev_server.CHANGELOG_DIR = cls.tree / "changelog"
        dev_server.CONFIG_DIR = cls.tree / "config"
        dev_server.CONFIG_DEFAULTS_DIR = cls.tree / "config" / "defaults" / "neutral"
        dev_server.INSTANCE_FILE = cls.tree / "config" / "instance.json"
        dev_server.THEME_CSS_FILE = cls.tree / "config" / "theme.css"
        dev_server.PAGE_DRAFTS_DIR = cls.tree / "api" / "page-drafts"
        dev_server.MEDIA_DIR = cls.tree / "config" / "uploads"
        dev_server._CATALOG_CACHE.update({"sig": None, "data": None, "body": None})
        us.configure(cls.tree)
        us.ensure_dirs()
        dev_server._write_credential_force("admin", PASSWORD)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), dev_server.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for k, v in cls._saved.items():
            setattr(dev_server, k, v)
        dev_server._CATALOG_CACHE.update({"sig": None, "data": None, "body": None})
        us.configure(ROOT)
        dev_server._BRUTE.clear()
        dev_server._BRUTE_GLOBAL.update(start=0.0, count=0)
        shutil.rmtree(cls.tree, ignore_errors=True)

    def setUp(self):
        self.cookie = self.csrf = None
        dev_server._BRUTE.clear()
        dev_server._BRUTE_GLOBAL.update(start=0.0, count=0)
        self.login()

    def _raw_post(self, path, headers):
        """Announce a 10 MB body, send none, and read what comes back."""
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        try:
            head = f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n" \
                   f"Content-Length: 10000000\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers.items()) + "\r\n"
            s.sendall(head.encode())
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
            return data
        finally:
            s.close()

    def test_media_upload_size_limit(self):
        # Called directly: an 8 MB image is an 11 MB request, past a default php.ini's
        # post_max_size, so the PHP twin cannot be fed one over HTTP in a test.
        import base64
        empty = {"ok": False, "error": "Fichier vide ou trop volumineux (max 8 Mo)"}
        big = base64.b64encode(self.PNG + b"\x00" * (8 * 1024 * 1024)).decode()
        self.assertEqual(dev_server._media_upload({"filename": "big.png", "data": big}), empty)
        self.assertEqual(dev_server._media_upload({"filename": "big.png", "data": "A" * (4 * 2796203 + 8)}), empty)
        ok = dev_server._media_upload({"filename": "edge.png", "data": base64.b64encode(
            self.PNG + b"\x00" * (8 * 1024 * 1024 - len(self.PNG))).decode()})
        self.assertTrue(ok["ok"], ok)

    def test_refused_before_the_body_is_read(self):
        for path in ("/api/datasets.php?action=save&id=3d/G", "/api/media.php?action=upload",
                     "/api/site.php?action=save&doc=instance", "/api/admin.php?action=stats"):
            resp = self._raw_post(path, {})
            self.assertTrue(resp.startswith(b"HTTP/1.0 401") or resp.startswith(b"HTTP/1.1 401"), (path, resp[:60]))
        resp = self._raw_post("/api/datasets.php?action=save&id=3d/G", {"Cookie": self.cookie})
        self.assertIn(b" 403 ", resp.split(b"\r\n")[0], "a write without its CSRF token is refused unread")

    def test_get_route_exception_is_a_500_json(self):
        orig = dev_server._build_catalog

        def boom():
            raise RuntimeError("synthetic")
        dev_server._build_catalog = boom
        dev_server._CATALOG_CACHE.update({"body": None})
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
            conn.request("GET", "/api/health")
            r = conn.getresponse()
            r.read()
            self.assertEqual(r.status, 200)
            conn.request("GET", "/DATA_WEB/catalog.json")
            r = conn.getresponse()
            self.assertEqual((r.status, json.loads(r.read())), (500, {"error": "internal_error"}),
                             "second request of a kept-alive connection")
            conn.close()
        finally:
            dev_server._build_catalog = orig
            dev_server._CATALOG_CACHE.update({"sig": None, "body": None})


@unittest.skipUnless(PHP, "SKIP php not found")
class PhpBackend(TwinCases, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tree = Path(tempfile.mkdtemp(prefix="lumen-twins-php-"))
        (cls.tree / "api").mkdir()
        for f in (ROOT / "api").iterdir():
            if f.is_file() and f.suffix in (".php", ".pem"):
                shutil.copy(f, cls.tree / "api" / f.name)
        shutil.copy(ROOT / "router.php", cls.tree / "router.php")
        _seed(cls.tree)
        rec = dev_server._credential_record("admin", PASSWORD)
        (cls.tree / "api" / "admin_credential.json").write_text(json.dumps(rec), encoding="utf-8")
        cls.port = _free_port()
        cls.proc = subprocess.Popen([PHP, "-S", f"127.0.0.1:{cls.port}", "router.php"], cwd=str(cls.tree),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(200):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)
        shutil.rmtree(cls.tree, ignore_errors=True)

    def setUp(self):
        self.cookie = self.csrf = None
        self.login()


if __name__ == "__main__":
    unittest.main(verbosity=2)
