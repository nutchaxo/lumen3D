"""Page version history (api/page-versions.php) — dev_server.py.

DOCS/pages-library/SPEC.md §2-§3. A real HTTP server on a throwaway tree, so the
session, the CSRF gate, the body ceiling and the static-file guard are the real ones.

* every action, its exact answer and error codes;
* the limits (51st version, oversized block / file) and the input gate (slug / id
  traversal, bad origin / mode / content);
* activation: the end state equals an editor publish, a draft activation leaves the
  published block alone, the safety snapshot is taken once and never duplicated;
* the history survives deleting the page and restores it;
* the stored file is byte-for-byte the golden fixture the PHP twin is held to
  (tests/fixtures/page-versions/). Regenerate with LUMEN_UPDATE_GOLDEN=1.
"""
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

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import dev_server as ds  # noqa: E402
import upload_staging as us  # noqa: E402

PASSWORD = "test-password-1234"
FIXTURES = ROOT / "tests" / "fixtures" / "page-versions"


def blk(text="Hello", extra=None):
    """A minimal page block: one section, one column, one heading widget."""
    widget = {"type": "heading", "props": {"text": {"en": text, "fr": text + " fr"}}}
    block = {"sections": [{"id": "s1", "props": {}, "columns": [
        {"id": "c1", "width": 12, "props": {}, "widgets": [widget]}]}]}
    if extra:
        block.update(extra)
    return block


def big_block(chars):
    """A block whose compact JSON is about ``chars`` bytes (one long string)."""
    return {"sections": [{"id": "s1", "columns": [{"id": "c1", "width": 12, "widgets": [
        {"type": "text", "props": {"body": "x" * chars}}]}]}]}


class PageVersionsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="lumen-pv-"))
        (cls.tmp / "api").mkdir(parents=True, exist_ok=True)
        (cls.tmp / "changelog").mkdir(exist_ok=True)
        (cls.tmp / "changelog" / "changelog_1.87.0.md").write_text("x", encoding="utf-8")
        keys = ("ROOT", "DATA_WEB", "CRED_FILE", "UPLOADS_DIR", "CHANGELOG_DIR", "CONFIG_DIR",
                "CONFIG_DEFAULTS_DIR", "INSTANCE_FILE", "THEME_CSS_FILE", "PAGE_DRAFTS_DIR",
                "PAGE_VERSIONS_DIR")
        cls._saved = {k: getattr(ds, k) for k in keys}
        ds.ROOT = cls.tmp
        ds.DATA_WEB = cls.tmp / "DATA_WEB"
        ds.CRED_FILE = cls.tmp / "api" / "admin_credential.json"
        ds.UPLOADS_DIR = cls.tmp / "uploads"
        ds.CHANGELOG_DIR = cls.tmp / "changelog"
        ds.CONFIG_DIR = cls.tmp / "config"
        ds.CONFIG_DEFAULTS_DIR = cls.tmp / "config" / "defaults" / "neutral"
        ds.INSTANCE_FILE = cls.tmp / "config" / "instance.json"
        ds.THEME_CSS_FILE = cls.tmp / "config" / "theme.css"
        ds.PAGE_DRAFTS_DIR = cls.tmp / "api" / "page-drafts"
        ds.PAGE_VERSIONS_DIR = cls.tmp / "api" / "page-versions"
        ds.CONFIG_DEFAULTS_DIR.mkdir(parents=True, exist_ok=True)
        us.configure(cls.tmp)
        us.ensure_dirs()
        ds._write_credential_force("admin", PASSWORD)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), ds.AdminHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for k, v in cls._saved.items():
            setattr(ds, k, v)
        us.configure(ROOT)
        ds._BRUTE.clear()
        ds._BRUTE_GLOBAL.update(start=0.0, count=0)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        for d in (ds.CONFIG_DIR / "pages", ds.PAGE_DRAFTS_DIR, ds.PAGE_VERSIONS_DIR):
            shutil.rmtree(d, ignore_errors=True)
        self.cookie = self.csrf = None
        ds._BRUTE.clear()
        ds._BRUTE_GLOBAL.update(start=0.0, count=0)
        self.login()

    # ── plumbing ────────────────────────────────────────────────────────────────

    def request(self, method, path, body=None, headers=None, raw=None, auth=True, csrf=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        h = dict(headers or {})
        if auth and self.cookie:
            h["Cookie"] = self.cookie
        if auth and csrf and self.csrf:
            h["X-CSRF-Token"] = self.csrf
        payload = raw
        if body is not None:
            payload = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        try:
            conn.request(method, path, body=payload, headers=h)
            res = conn.getresponse()
            data = res.read()
            try:
                parsed = json.loads(data.decode() or "{}")
            except ValueError:
                parsed = {}
            return res.status, {k.lower(): v for k, v in res.getheaders()}, parsed
        finally:
            conn.close()

    def login(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("POST", "/api/auth.php?action=login",
                     body=json.dumps({"username": "admin", "password": PASSWORD}).encode(),
                     headers={"Content-Type": "application/json"})
        res = conn.getresponse()
        data = json.loads(res.read().decode())
        self.cookie = (res.getheader("Set-Cookie") or "").split(";")[0]
        self.csrf = data["csrf"]
        conn.close()

    def pv(self, action, slug=None, vid=None, body=None, method=None, expect=200, **kw):
        q = f"action={action}"
        if slug is not None:
            q += f"&slug={slug}"
        if vid is not None:
            q += f"&id={vid}"
        if method is None:
            method = "GET" if action in ("list", "get") else "POST"
        if method == "POST" and body is None:
            body = {}
        st, h, data = self.request(method, f"/api/page-versions.php?{q}", body, **kw)
        if expect is not None:
            self.assertEqual(st, expect, data)
        return st, h, data

    def add(self, slug, content=None, **extra):
        body = {"origin": "import", "content": content or {"published": blk("A")}}
        body.update(extra)
        _st, _h, data = self.pv("add", slug, body=body)
        return data

    def live(self, slug):
        return ds._load_site_admin(f"pages/{slug}")

    def seed_live(self, slug, published=None, draft=None, title=None):
        doc = {}
        if title is not None:
            doc["title"] = title
        if published is not None:
            doc["published"] = published
        if draft is not None:
            doc["draft"] = draft
        self.assertTrue(ds._save_site_doc(f"pages/{slug}", doc))

    def history_file(self, slug):
        return ds.PAGE_VERSIONS_DIR / f"{slug}.json"

    def stored(self, slug):
        return json.loads(self.history_file(slug).read_text(encoding="utf-8"))

    def editor_publish(self, slug, page):
        """The three writes of pages-transfer.js pageWrites({publish:true})."""
        doc = f"pages/{slug}"
        title = page.get("title")
        pub = page.get("published") or page.get("draft")
        body = {"draft": pub}
        if title:
            body["title"] = title
        self.assertEqual(ds._site_save_draft(doc, body)[0], 200)
        self.assertTrue(ds._publish_site_doc(doc))
        if page.get("published") and page.get("draft"):
            self.assertEqual(ds._site_save_draft(doc, {"draft": page["draft"]})[0], 200)

    def files_of(self, slug):
        pub = ds.CONFIG_DIR / "pages" / f"{slug}.json"
        dr = ds.PAGE_DRAFTS_DIR / f"{slug}.json"
        return (pub.read_bytes() if pub.exists() else None, dr.read_bytes() if dr.exists() else None)

    # ── access control ──────────────────────────────────────────────────────────

    def test_anonymous_is_refused_for_reads_and_writes(self):
        for method, action in (("GET", "list"), ("GET", "get"), ("POST", "add"), ("POST", "purge")):
            st, _h, data = self.request(method, f"/api/page-versions.php?action={action}&slug=about",
                                        body={} if method == "POST" else None, auth=False)
            self.assertEqual((st, data), (401, {"error": "Not authenticated"}), (method, action))

    def test_anonymous_post_is_refused_before_the_body_is_read(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest("POST", "/api/page-versions.php?action=add&slug=about")
            conn.putheader("Content-Length", str(8 * 1024 * 1024))
            conn.endheaders()      # announced, never sent
            res = conn.getresponse()
            self.assertEqual(res.status, 401)
        finally:
            conn.close()

    def test_write_needs_post_and_the_csrf_token(self):
        body = {"origin": "import", "content": {"published": blk()}}
        st, _h, d = self.request("POST", "/api/page-versions.php?action=add&slug=about", body, csrf=False)
        self.assertEqual((st, d["error"]), (403, "Invalid or missing CSRF token"))
        st, _h, d = self.request("POST", "/api/page-versions.php?action=add&slug=about", body,
                                 headers={"X-CSRF-Token": "wrong"}, csrf=False)
        self.assertEqual(st, 403)
        st, _h, d = self.request("GET", "/api/page-versions.php?action=purge&slug=about")
        self.assertEqual(st, 405, "a write is never reachable by GET")
        self.assertFalse(self.history_file("about").exists())

    def test_reads_are_no_store_and_need_no_csrf(self):
        st, h, d = self.request("GET", "/api/page-versions.php?action=list", csrf=False)
        self.assertEqual(st, 200)
        self.assertIn("no-store", h.get("cache-control", ""))
        st, h, d = self.request("GET", "/api/page-versions.php?action=get&slug=about&id=v000000000000")
        self.assertEqual((st, d["error"]), (404, "not_found"))
        self.assertIn("no-store", h.get("cache-control", ""))

    def test_the_body_ceiling_is_registered_like_site_php(self):
        self.assertIn("/api/page-versions.php", ds._API_BODY_LIMITS)
        self.assertGreaterEqual(ds._API_BODY_LIMITS["/api/page-versions.php"], ds._API_BODY_LIMITS["/api/site.php"])
        self.assertEqual(ds.AdminHandler._WRITE_ACTIONS["/api/page-versions.php"],
                         frozenset({"add", "update", "activate", "delete", "purge"}))
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest("POST", "/api/page-versions.php?action=add&slug=about")
            conn.putheader("Cookie", self.cookie)
            conn.putheader("X-CSRF-Token", self.csrf)
            conn.putheader("Content-Length", str(ds._API_BODY_LIMITS["/api/page-versions.php"] + 1))
            conn.endheaders()
            res = conn.getresponse()
            self.assertEqual(res.status, 413)
        finally:
            conn.close()

    # ── the history is never served ─────────────────────────────────────────────

    def test_history_files_are_never_served_or_updated_over(self):
        self.add("about")
        f = self.history_file("about")
        self.assertTrue(f.is_file())
        for p in ("api/page-versions/about.json", "/api/page-versions/about.json", "/api/page-versions/",
                  "/%61pi/page-versions/about.json", "/api%2fpage-versions%2fabout.json",
                  "/x/../api/page-versions/about.json", "\\api\\page-versions\\about.json",
                  "/API/page-versions/about.json"):
            self.assertTrue(ds._is_forbidden_static(p), p)
        for url in ("/api/page-versions/about.json", "/%61pi/page-versions/about.json",
                    "/api%2Fpage-versions%2Fabout.json", "/api/page-versions/", "/API/page-versions/about.json"):
            for auth in (True, False):
                st, _h, data = self.request("GET", url, auth=auth)
                self.assertEqual(st, 404, (url, auth))
                self.assertNotIn("versions", data)
        self.assertTrue(ds._is_protected_rel("api/page-versions/about.json"))
        self.assertTrue(ds._is_protected_rel("api/page-versions"))
        self.assertIn("api/page-versions", ds._UPDATE_PROTECT)

    def test_the_file_is_private_and_atomically_written(self):
        self.add("about")
        if os.name == "posix":
            self.assertEqual(self.history_file("about").stat().st_mode & 0o777, 0o600)
        self.assertEqual([p.name for p in ds.PAGE_VERSIONS_DIR.iterdir()], ["about.json"], "no temp file left behind")
        raw = self.history_file("about").read_bytes()
        self.assertNotIn(b"\r\n", raw, "LF on every platform: the twins write the same bytes")

    # ── input gate ──────────────────────────────────────────────────────────────

    def test_slug_and_id_traversal_is_refused_and_writes_nothing(self):
        outside = ds.PAGE_VERSIONS_DIR.parent
        before = sorted(p.name for p in outside.rglob("*"))
        bad_slugs = ["..", "../x", "a/b", "a%2Fb", "%2e%2e", "%2e%2e%2fx", "%252e%252e", "x%00", "%00",
                     "About", "ABOUT", "a%0A", "a%20b", "a.b", "-a", "_a", "a" * 65, "", "a%5Cb", "%C3%A9"]
        for slug in bad_slugs:
            calls = [("get", "GET", None),
                     ("add", "POST", {"origin": "import", "content": {"published": blk()}}),
                     ("update", "POST", {"label": "x"}), ("activate", "POST", {}),
                     ("delete", "POST", {}), ("purge", "POST", {})]
            if slug:                      # `slug=` alone is "no slug", which list answers for every page
                calls.insert(0, ("list", "GET", None))
            for action, method, body in calls:
                q = f"/api/page-versions.php?action={action}&slug={slug}&id=v0123456789ab"
                st, _h, d = self.request(method, q, body)
                self.assertEqual((st, d.get("error")), (400, "invalid_slug"), (action, slug))
        # a missing slug is the same refusal (except list, which answers for every page)
        st, _h, d = self.request("POST", "/api/page-versions.php?action=add", {})
        self.assertEqual((st, d["error"]), (400, "invalid_slug"))
        bad_ids = ["", "x", "v", "V0123456789AB", "v0123456789a", "v0123456789abc", "v0123456789ag",
                   "../v0123456789ab", "v0123456789ab%0A", "v0123456789ab%00", "%2e%2e", "a/b"]
        for vid in bad_ids:
            for action, method in (("get", "GET"), ("update", "POST"), ("activate", "POST"), ("delete", "POST")):
                st, _h, d = self.request(method, f"/api/page-versions.php?action={action}&slug=about&id={vid}",
                                         {"label": "x"} if method == "POST" else None)
                self.assertEqual((st, d.get("error")), (400, "invalid_id"), (action, vid))
        self.assertEqual(sorted(p.name for p in outside.rglob("*")), before)
        self.assertFalse(ds.PAGE_VERSIONS_DIR.exists() and any(ds.PAGE_VERSIONS_DIR.iterdir()))

    def test_unknown_action(self):
        st, _h, d = self.pv("nope", "about", method="POST", expect=None)
        self.assertEqual((st, d), (400, {"error": "Unknown action"}))
        st, _h, d = self.pv("nope", "about", method="GET", expect=None)
        self.assertEqual((st, d), (400, {"error": "Unknown action"}))

    def test_add_validates_its_body(self):
        def add_err(body, status, code, slug="about"):
            st, _h, d = self.pv("add", slug, body=body, expect=None)
            self.assertEqual((st, d.get("error")), (status, code), body)
            return d

        add_err({"content": {"published": blk()}}, 400, "invalid_origin")
        add_err({"origin": "nope", "content": {"published": blk()}}, 400, "invalid_origin")
        add_err({"origin": 5, "content": {"published": blk()}}, 400, "invalid_origin")
        add_err({"origin": "import", "content": {"published": blk()}, "activate": "now"}, 400, "invalid_mode")
        add_err({"origin": "import", "content": {"published": blk()}, "label": 5}, 400, "invalid_body")
        add_err({"origin": "import", "content": {"published": blk()}, "note": ["x"]}, 400, "invalid_body")
        for content in (None, [], "x", {}, {"title": {"en": "T"}}, {"published": {}}, {"published": []},
                        {"published": {"sections": "x"}}, {"draft": {"blocks": {}}},
                        {"published": {"sections": [{"columns": {"a": 1}}]}},
                        {"published": {"sections": [{"columns": [{"widgets": [{}]}]}]}},
                        {"published": {"sections": [1]}},
                        {"published": blk(), "title": "plain string"},
                        {"published": blk(), "title": {"en": 5}},
                        {"published": blk(), "nav": {"show": "yes"}},
                        {"published": blk(), "nav": []}):
            d = add_err({"origin": "import", "content": content}, 400, "invalid_content")
        self.assertIn("detail", d)
        # a body that is not an object, or not JSON
        st, _h, d = self.request("POST", "/api/page-versions.php?action=add&slug=about", raw=b"[1,2]",
                                 headers={"Content-Type": "application/json"})
        self.assertEqual((st, d["error"]), (400, "invalid_body"))
        st, _h, d = self.request("POST", "/api/page-versions.php?action=add&slug=about", raw=b"not json",
                                 headers={"Content-Type": "application/json"})
        self.assertEqual((st, d["error"]), (400, "invalid_body"))
        st, _h, d = self.request("POST", "/api/page-versions.php?action=add&slug=about")
        self.assertEqual((st, d["error"]), (400, "invalid_body"))
        self.assertFalse(self.history_file("about").exists(), "a refused add stores nothing")

    def test_text_fields_are_cleaned_and_bounded(self):
        d = self.add("about", label="  " + "L" * 200 + "\x00\x07  ", note="n" * 3000 + "\x00",
                     exportedAt="2026-11-18T09:00:00.000Z\n", source="bemine.be\x00" + "s" * 100,
                     platform="1.86.0\t")
        v = d["version"]
        self.assertEqual(v["label"], "L" * 120)
        self.assertEqual(len(v["note"]), 2000)
        self.assertEqual(v["exportedAt"], "2026-11-18T09:00:00.000Z")
        self.assertEqual(v["source"], ("bemine.be" + "s" * 100)[:64])
        self.assertEqual(v["platform"], "1.86.0")
        e = self.add("about", label="   ")
        self.assertEqual(e["version"]["label"], "Version", "an empty label becomes Version")
        n = self.add("about", note="line1\nline2\ttab\x01")
        self.assertEqual(n["version"]["note"], "line1\nline2\ttab", "newline and tab survive in a note")
        z = self.add("about", source=None)
        self.assertEqual((z["version"]["exportedAt"], z["version"]["source"], z["version"]["platform"]), ("", "", ""))
        for field, value in (("exportedAt", 12), ("source", ["x"]), ("platform", {"x": 1})):
            self.pv("add", "about", body={"origin": "import", "content": {"published": blk("A")}, field: value}, expect=400)

    # ── add / list / get ────────────────────────────────────────────────────────

    def test_add_list_get_round_trip_and_meta(self):
        content = {"title": {"en": "About", "fr": "A propos"},
                   "nav": {"label": {"en": "About"}, "show": True, "junk": 1},
                   "published": blk("Pub"), "draft": blk("Dra"), "unknown": {"x": 1}}
        d = self.add("about", content, label="Spring", note="n", exportedAt="e", source="s", platform="1.86.0")
        self.assertTrue(d["ok"])
        self.assertRegex(d["id"], r"^v[0-9a-f]{12}$")
        self.assertNotIn("snapshotId", d)
        meta = d["version"]
        self.assertEqual(set(meta), {"id", "label", "note", "origin", "createdAt", "updatedAt", "exportedAt",
                                     "source", "platform", "widgets", "bytes", "locales", "hasPublished",
                                     "hasDraft", "title", "isActive"})
        self.assertEqual((meta["widgets"], meta["locales"], meta["hasPublished"], meta["hasDraft"]),
                         (1, ["en", "fr"], True, True))
        self.assertEqual(meta["title"], {"en": "About", "fr": "A propos"})
        self.assertFalse(meta["isActive"])
        self.assertRegex(meta["createdAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(meta["createdAt"], meta["updatedAt"])
        _st, _h, got = self.pv("get", "about", d["id"])
        self.assertTrue(got["ok"])
        stored = got["version"]["content"]
        self.assertEqual(list(stored), ["title", "nav", "published", "draft"], "canonical key order, unknown keys dropped")
        self.assertEqual(stored["nav"], {"label": {"en": "About"}, "show": True})
        self.assertEqual({k: got["version"][k] for k in meta}, meta)
        self.assertEqual(meta["bytes"], len(json.dumps(stored, ensure_ascii=False, separators=(",", ":")).encode()))

    def test_list_is_newest_first_and_filters_by_slug(self):
        a1 = self.add("about", label="one")["id"]
        a2 = self.add("about", label="two")["id"]
        h1 = self.add("home", label="h")["id"]
        _st, _h, d = self.pv("list")
        self.assertEqual(d["schema"], "lumen-page-versions/1")
        self.assertEqual(d["limits"], {"maxVersions": 50, "maxBytes": 33554432})
        self.assertEqual(sorted(d["pages"]), ["about", "home"])
        self.assertEqual([v["id"] for v in d["pages"]["about"]["versions"]], [a2, a1])
        self.assertEqual((d["pages"]["about"]["count"], d["pages"]["about"]["active"]), (2, None))
        self.assertNotIn("content", d["pages"]["about"]["versions"][0])
        _st, _h, only = self.pv("list", "home")
        self.assertEqual(list(only["pages"]), ["home"])
        self.assertEqual(only["pages"]["home"]["versions"][0]["id"], h1)
        _st, _h, none = self.pv("list", "nothing-here")
        self.assertEqual(none["pages"], {})
        self.assertEqual([v["id"] for v in self.stored("about")["versions"]], [a1, a2], "stored oldest first")

    def test_get_and_mutations_of_unknown_things_are_404(self):
        self.add("about")
        for action, body in (("get", None), ("update", {"label": "x"}), ("activate", {}), ("delete", {})):
            st, _h, d = self.pv(action, "about", "v0123456789ab", body=body, expect=None)
            self.assertEqual((st, d["error"]), (404, "not_found"), action)
            st, _h, d = self.pv(action, "never-existed", "v0123456789ab", body=body, expect=None)
            self.assertEqual((st, d["error"]), (404, "not_found"), action)

    def test_locales_widgets_and_legacy_blocks(self):
        legacy = {"blocks": [{"type": "heading", "props": {"text": {"nl": "Hoi"}}}, {"type": "spacer"}]}
        d = self.add("about", {"draft": legacy})
        m = d["version"]
        self.assertEqual((m["widgets"], m["locales"], m["hasPublished"], m["hasDraft"]), (2, ["nl"], False, True))
        # the primary block is the published one when there is one
        d2 = self.add("about", {"draft": blk("d"), "published": legacy})
        self.assertEqual(d2["version"]["widgets"], 2)
        # props such as {"id": "x", "n": 1} are not locale maps
        odd = blk("t")
        odd["sections"][0]["props"] = {"bg": "red", "id": "z"}
        self.assertEqual(sorted(set(self.add("about", {"published": odd})["version"]["locales"])), ["bg", "en", "fr", "id"],
                         "same rule as pageLocales(): an all-2-letter string map counts")

    def test_a_block_width_is_clamped_like_an_editor_save(self):
        b = blk()
        b["sections"][0]["columns"][0]["width"] = 99
        d = self.add("about", {"published": b})
        _st, _h, got = self.pv("get", "about", d["id"])
        self.assertEqual(got["version"]["content"]["published"]["sections"][0]["columns"][0]["width"], 12)

    # ── limits ──────────────────────────────────────────────────────────────────

    def test_the_51st_version_is_refused(self):
        for i in range(50):
            ds._pv_handle("add", {"slug": "about"}, {"origin": "manual", "label": f"v{i}",
                                                     "content": {"published": blk(str(i))}})
        _st, _h, d = self.pv("list", "about")
        self.assertEqual(d["pages"]["about"]["count"], 50)
        st, _h, d = self.pv("add", "about", body={"origin": "manual", "content": {"published": blk()}}, expect=None)
        self.assertEqual((st, d["error"]), (409, "too_many_versions"))
        self.assertEqual(len(self.stored("about")["versions"]), 50)
        # deleting one makes room again
        victim = self.stored("about")["versions"][0]["id"]
        self.pv("delete", "about", victim)
        self.pv("add", "about", body={"origin": "manual", "content": {"published": blk()}})

    def test_a_block_over_2_mib_is_refused(self):
        st, _h, d = self.pv("add", "about", body={"origin": "import", "content": {"published": big_block(2_200_000)}},
                            expect=None)
        self.assertEqual((st, d["error"]), (413, "version_too_large"))
        st, _h, d = self.pv("add", "about", body={"origin": "import", "content": {"draft": big_block(2_200_000)}},
                            expect=None)
        self.assertEqual((st, d["error"]), (413, "version_too_large"))
        self.assertFalse(self.history_file("about").exists())
        ok = self.pv("add", "about", body={"origin": "import", "content": {"published": big_block(1_900_000),
                                                                           "draft": big_block(1_900_000)}})[2]
        self.assertGreater(ok["version"]["bytes"], 3_800_000)

    def test_the_stored_file_is_capped_at_32_mib(self):
        results = []
        for i in range(30):
            st, d = ds._pv_handle("add", {"slug": "about"}, {"origin": "manual",
                                  "content": {"published": big_block(1_900_000 + i)}})
            results.append((st, d.get("error")))
            if st != 200:
                break
        self.assertEqual(results[-1], (413, "version_too_large"), results)
        self.assertLess(len(results), 30)
        self.assertLessEqual(self.history_file("about").stat().st_size, 32 * 1024 * 1024)
        self.assertEqual(len(self.stored("about")["versions"]), len(results) - 1, "the refused one is not stored")

    # ── update ──────────────────────────────────────────────────────────────────

    def test_update_label_note_and_content(self):
        vid = self.add("about", label="one")["id"]
        orig = ds._pv_now
        try:
            ds._pv_now = lambda: "2030-01-02T03:04:05Z"
            _st, _h, d = self.pv("update", "about", vid, body={"label": "  Renamed  ", "note": "why"})
            self.assertEqual((d["version"]["label"], d["version"]["note"], d["version"]["updatedAt"]),
                             ("Renamed", "why", "2030-01-02T03:04:05Z"))
            self.assertNotEqual(d["version"]["createdAt"], "2030-01-02T03:04:05Z")
            _st, _h, d = self.pv("update", "about", vid, body={"label": ""})
            self.assertEqual(d["version"]["label"], "Version")
            _st, _h, d = self.pv("update", "about", vid, body={"content": {"draft": blk("New"), "title": {"en": "T"}}})
            self.assertEqual((d["version"]["hasPublished"], d["version"]["hasDraft"], d["version"]["title"]),
                             (False, True, {"en": "T"}), "content is replaced wholesale")
        finally:
            ds._pv_now = orig
        _st, _h, got = self.pv("get", "about", vid)
        self.assertEqual(got["version"]["note"], "why")
        self.assertEqual(got["version"]["content"]["draft"]["sections"][0]["columns"][0]["widgets"][0]["props"]["text"]["en"], "New")

    def test_update_needs_something_and_refuses_contradictions(self):
        vid = self.add("about")["id"]
        for body, code in (({}, "nothing_to_update"), ({"label": None}, "nothing_to_update"),
                           ({"fromLive": True, "content": {"published": blk()}}, "invalid_body"),
                           ({"label": 5}, "invalid_body"), ({"fromLive": "yes"}, "invalid_body"),
                           ({"content": {"published": {}}}, "invalid_content")):
            st, _h, d = self.pv("update", "about", vid, body=body, expect=None)
            self.assertEqual((st, d["error"]), (400, code), body)
        st, _h, d = self.request("POST", f"/api/page-versions.php?action=update&slug=about&id={vid}", raw=b"[]",
                                 headers={"Content-Type": "application/json"})
        self.assertEqual((st, d["error"]), (400, "invalid_body"))

    def test_update_from_live_takes_the_live_state_and_keeps_nav(self):
        vid = self.add("about", {"title": {"en": "Old"}, "nav": {"label": {"en": "Nav"}, "show": True},
                                 "published": blk("old")})["id"]
        st, _h, d = self.pv("update", "about", vid, body={"fromLive": True}, expect=None)
        self.assertEqual((st, d["error"]), (400, "invalid_content"), "no live page yet")
        self.seed_live("about", published=blk("live-pub"), draft=blk("live-draft"), title={"en": "Live"})
        _st, _h, d = self.pv("update", "about", vid, body={"fromLive": True})
        self.assertEqual((d["version"]["hasPublished"], d["version"]["hasDraft"], d["version"]["title"]),
                         (True, True, {"en": "Live"}))
        content = self.pv("get", "about", vid)[2]["version"]["content"]
        self.assertEqual(content["nav"], {"label": {"en": "Nav"}, "show": True})
        self.assertEqual(content["published"], self.live("about")["published"])
        self.assertEqual(content["draft"], self.live("about")["draft"])

    # ── activate ────────────────────────────────────────────────────────────────

    def test_activate_publish_is_the_end_state_of_an_editor_publish(self):
        cases = {
            "both": {"title": {"en": "T"}, "published": blk("P"), "draft": blk("D")},
            "pub-only": {"title": {"en": "T"}, "published": blk("P")},
            "draft-only": {"draft": blk("D")},
            "no-title": {"published": blk("P"), "draft": blk("D")},
        }
        for name, page in cases.items():
            for seeded in (False, True):
                a, b = f"act-{name}-{int(seeded)}", f"edit-{name}-{int(seeded)}"
                if seeded:
                    for s in (a, b):
                        self.seed_live(s, published=blk("old"), draft=blk("old-draft"), title={"en": "Old"})
                vid = self.add(a, page)["id"]
                _st, _h, ans = self.pv("activate", a, vid, body={"mode": "publish"})
                self.assertEqual(ans["active"], vid)
                self.assertEqual(ans["rev"], ds._site_rev(f"pages/{a}"))
                self.editor_publish(b, page)
                pa, da = self.files_of(a)
                pb, db = self.files_of(b)
                pub_a, pub_b = json.loads(pa), json.loads(pb)
                self.assertEqual(pub_a.pop("schemaVersion"), 2)
                pub_b.pop("schemaVersion", None)     # the editor path stamps it only when a title moves
                self.assertEqual(pub_a, pub_b, (name, seeded, "public file"))
                self.assertEqual(da, db, (name, seeded, "draft file"))
                self.assertNotIn("draft", pub_a, "the public file carries no draft")
                self.assertEqual(self.stored(a)["active"], vid)

    def test_activate_defaults_to_publish_and_accepts_no_body(self):
        vid = self.add("about", {"published": blk("P"), "draft": blk("D")})["id"]
        st, _h, ans = self.request("POST", f"/api/page-versions.php?action=activate&slug=about&id={vid}")
        self.assertEqual(st, 200, ans)
        self.assertEqual(self.live("about")["published"], blk("P"))
        st, _h, d = self.pv("activate", "about", vid, body={"mode": "weird"}, expect=None)
        self.assertEqual((st, d["error"]), (400, "invalid_mode"))

    def test_activate_draft_leaves_the_published_block_and_the_active_marker(self):
        v1 = self.add("about", {"title": {"en": "One"}, "published": blk("P1"), "draft": blk("D1")})["id"]
        v2 = self.add("about", {"draft": blk("D2"), "title": {"en": "Two"}})["id"]
        self.pv("activate", "about", v1, body={"mode": "publish"})
        before_pub = self.files_of("about")[0]
        _st, _h, ans = self.pv("activate", "about", v2, body={"mode": "draft"})
        self.assertEqual(ans["active"], v1, "a draft activation does not move the marker")
        live = self.live("about")
        self.assertEqual(live["draft"], blk("D2"))
        self.assertEqual(live["published"], blk("P1"), "published untouched")
        self.assertEqual(live["title"], {"en": "Two"})
        self.assertEqual(self.stored("about")["active"], v1)
        self.assertNotEqual(self.files_of("about")[0], before_pub, "only the title of the public file moved")
        # published-only version activated as draft: the draft is its published block
        v3 = self.add("about", {"published": blk("P3")})["id"]
        self.pv("activate", "about", v3, body={"mode": "draft"})
        self.assertEqual(self.live("about")["draft"], blk("P3"))
        self.assertEqual(self.live("about")["published"], blk("P1"))

    def test_activate_draft_on_a_page_with_no_published_block_creates_an_empty_one(self):
        vid = self.add("fresh", {"draft": blk("D")})["id"]
        self.pv("activate", "fresh", vid, body={"mode": "draft"})
        live = self.live("fresh")
        self.assertEqual(live["published"], {"sections": []})
        self.assertEqual(live["draft"], blk("D"))
        self.assertIsNone(self.stored("fresh")["active"])

    def test_safety_snapshot_is_taken_once_and_never_duplicated(self):
        self.seed_live("about", published=blk("live"), draft=blk("live-draft"), title={"en": "Live"})
        a = self.add("about", {"published": blk("A")}, label="A")["id"]
        b = self.add("about", {"published": blk("B")}, label="B")["id"]
        _st, _h, ans = self.pv("activate", "about", a, body={"snapshotLabel": "Before A"})
        snap = ans["snapshotId"]
        versions = self.stored("about")["versions"]
        self.assertEqual(len(versions), 3)
        s = [v for v in versions if v["id"] == snap][0]
        self.assertEqual((s["origin"], s["label"], s["note"]), ("auto", "Before A", ""))
        self.assertEqual(s["content"], {"title": {"en": "Live"}, "published": blk("live"), "draft": blk("live-draft")})
        # activating A again: the page is exactly A now -> nothing to save
        _st, _h, ans = self.pv("activate", "about", a)
        self.assertNotIn("snapshotId", ans)
        self.assertEqual(len(self.stored("about")["versions"]), 3)
        # activating B while the page equals A (a stored version) -> still no snapshot
        _st, _h, ans = self.pv("activate", "about", b)
        self.assertNotIn("snapshotId", ans)
        self.assertEqual(len(self.stored("about")["versions"]), 3)
        # an editor change makes the page differ from every version -> one snapshot, default label
        self.assertEqual(ds._site_save_draft("pages/about", {"draft": blk("edited")})[0], 200)
        _st, _h, ans = self.pv("activate", "about", a)
        self.assertIn("snapshotId", ans)
        last = self.stored("about")["versions"][-1]
        self.assertEqual((last["id"], last["label"], last["origin"]), (ans["snapshotId"], "Before activation", "auto"))
        self.assertEqual(last["content"]["draft"], blk("edited"))
        self.assertEqual(last["content"]["published"], blk("B"))
        self.assertEqual(len(self.stored("about")["versions"]), 4)

    def test_no_snapshot_when_the_live_state_equals_a_stored_version(self):
        a = self.add("about", {"published": blk("A")})["id"]
        b = self.add("about", {"published": blk("B"), "draft": blk("B2")})["id"]
        self.pv("activate", "about", a)        # the page did not exist: nothing to save
        self.assertEqual(len(self.stored("about")["versions"]), 2)
        _st, _h, ans = self.pv("activate", "about", b)
        self.assertNotIn("snapshotId", ans, "the page was exactly version A")
        self.assertEqual(len(self.stored("about")["versions"]), 2)
        # a page that equals a version only once the missing draft is read as the published block
        self.seed_live("other", published=blk("A"), draft=blk("A"))
        o = self.add("other", {"published": blk("A")})["id"]
        c = self.add("other", {"published": blk("C")})["id"]
        _st, _h, ans = self.pv("activate", "other", c)
        self.assertNotIn("snapshotId", ans)
        self.assertEqual(self.live("other")["published"], blk("C"))
        self.assertTrue(o)

    def test_activating_an_unchanged_active_version_rewrites_nothing(self):
        vid = self.add("about", {"published": blk("P"), "draft": blk("D")})["id"]
        self.pv("activate", "about", vid)
        files = self.files_of("about")
        mtime = self.history_file("about").stat().st_mtime_ns
        _st, _h, ans = self.pv("activate", "about", vid)
        self.assertEqual((ans["ok"], ans["active"]), (True, vid))
        self.assertEqual(self.files_of("about"), files)
        self.assertEqual(self.history_file("about").stat().st_mtime_ns, mtime)
        self.assertEqual(ans["rev"], ds._site_rev("pages/about"))

    def test_snapshot_over_the_version_limit_changes_nothing(self):
        self.seed_live("about", published=blk("live"))
        for i in range(50):
            ds._pv_handle("add", {"slug": "about"}, {"origin": "manual", "content": {"published": blk(f"m{i}")}})
        target = self.stored("about")["versions"][0]["id"]
        live_before, hist_before = self.files_of("about"), self.history_file("about").read_bytes()
        st, _h, d = self.pv("activate", "about", target, expect=None)
        self.assertEqual((st, d["error"]), (409, "too_many_versions"))
        self.assertEqual(self.files_of("about"), live_before)
        self.assertEqual(self.history_file("about").read_bytes(), hist_before)

    def test_add_with_activate_does_both_in_one_operation(self):
        self.seed_live("about", published=blk("live"))
        d = self.add("about", {"published": blk("Imported"), "title": {"en": "I"}}, activate="publish",
                     snapshotLabel="Before import")
        self.assertTrue(d["version"]["isActive"])
        self.assertIn("snapshotId", d)
        versions = self.stored("about")["versions"]
        self.assertEqual(versions[0]["id"], d["id"])
        self.assertEqual((versions[1]["id"], versions[1]["label"]), (d["snapshotId"], "Before import"),
                         "the snapshot is appended after the added version")
        self.assertEqual(self.stored("about")["active"], d["id"])
        self.assertEqual(self.live("about")["published"], blk("Imported"))
        # draft mode
        d2 = self.add("about", {"published": blk("Other")}, activate="draft")
        self.assertFalse(d2["version"]["isActive"])
        self.assertEqual(self.live("about")["draft"], blk("Other"))
        self.assertEqual(self.live("about")["published"], blk("Imported"))
        # the 51st-version rule also covers the snapshot: nothing at all is stored
        for i in range(60):
            if len(self.stored("about")["versions"]) >= 49:
                break
            ds._pv_handle("add", {"slug": "about"}, {"origin": "manual", "content": {"published": blk(f"q{i}")}})
        self.assertEqual(len(self.stored("about")["versions"]), 49)
        self.assertEqual(ds._site_save_draft("pages/about", {"draft": blk("unsaved work")})[0], 200)
        st, _h, e = self.pv("add", "about", body={"origin": "import", "content": {"published": blk("Z")},
                                                  "activate": "publish"}, expect=None)
        self.assertEqual((st, e["error"]), (409, "too_many_versions"))
        self.assertEqual(len(self.stored("about")["versions"]), 49)
        self.assertEqual(self.live("about")["draft"], blk("unsaved work"))

    def test_a_failed_activation_after_the_add_reports_the_stored_version(self):
        orig = ds._pv_apply_live

        def boom(*a, **k):
            raise ds._PvError(500, "write_failed")

        ds._pv_apply_live = boom
        try:
            st, _h, d = self.pv("add", "about", body={"origin": "import", "content": {"published": blk("Z")},
                                                      "activate": "publish"}, expect=None)
        finally:
            ds._pv_apply_live = orig
        self.assertEqual((st, d["error"], d["added"]), (500, "write_failed", True))
        self.assertEqual([v["id"] for v in self.stored("about")["versions"]], [d["id"]])
        self.assertIsNone(self.stored("about")["active"], "never marked active when the page was not changed")

    # ── delete / purge / restore ────────────────────────────────────────────────

    def test_the_active_version_cannot_be_deleted(self):
        a = self.add("about")["id"]
        b = self.add("about", {"published": blk("B")})["id"]
        self.pv("activate", "about", a)
        st, _h, d = self.pv("delete", "about", a, expect=None)
        self.assertEqual((st, d["error"]), (409, "active_version"))
        self.assertEqual(len(self.stored("about")["versions"]), 2)
        _st, _h, d = self.pv("delete", "about", b)
        self.assertEqual(d, {"ok": True, "active": a})
        # activate another one first, then the former can go
        c = self.add("about", {"published": blk("C")})["id"]
        self.pv("activate", "about", c)
        _st, _h, d = self.pv("delete", "about", a)
        self.assertEqual(d["active"], c)
        # the last remaining version cannot go while active; once it is not, the file disappears
        st, _h, d = self.pv("delete", "about", c, expect=None)
        self.assertEqual(st, 409)

    def test_deleting_the_last_version_removes_the_file(self):
        a = self.add("about")["id"]
        self.assertTrue(self.history_file("about").exists())
        _st, _h, d = self.pv("delete", "about", a)
        self.assertEqual(d, {"ok": True, "active": None})
        self.assertFalse(self.history_file("about").exists())
        _st, _h, listing = self.pv("list")
        self.assertEqual(listing["pages"], {})

    def test_purge_is_idempotent_and_scoped_to_one_page(self):
        self.add("about")
        self.add("home")
        self.assertEqual(self.pv("purge", "about")[2], {"ok": True})
        self.assertEqual(self.pv("purge", "about")[2], {"ok": True})
        self.assertEqual(self.pv("purge", "never-existed")[2], {"ok": True})
        self.assertFalse(self.history_file("about").exists())
        self.assertTrue(self.history_file("home").exists())

    def test_a_deleted_page_is_restorable_from_its_history(self):
        self.seed_live("news", published=blk("N"), draft=blk("N-draft"), title={"en": "News"})
        vid = self.add("news", {"published": blk("N"), "draft": blk("N-draft"), "title": {"en": "News"}})["id"]
        self.pv("activate", "news", vid)
        self.assertTrue(ds._delete_site_doc("pages/news"))
        self.assertFalse((ds.CONFIG_DIR / "pages" / "news.json").exists())
        self.assertFalse((ds.PAGE_DRAFTS_DIR / "news.json").exists())
        _st, _h, listing = self.pv("list")
        self.assertIn("news", listing["pages"], "the history outlives the page")
        _st, _h, ans = self.pv("activate", "news", vid)
        self.assertNotIn("snapshotId", ans, "there was no live page to save")
        live = self.live("news")
        self.assertEqual((live["published"], live["draft"], live["title"]), (blk("N"), blk("N-draft"), {"en": "News"}))

    def test_an_unreadable_history_is_parked_and_another_schema_is_never_touched(self):
        ds.PAGE_VERSIONS_DIR.mkdir(parents=True, exist_ok=True)
        f = self.history_file("about")
        newer = b'{"schema":"lumen-page-versions/2","slug":"about","versions":[]}'
        f.write_bytes(newer)
        st, _h, d = self.pv("add", "about", body={"origin": "import", "content": {"published": blk()}}, expect=None)
        self.assertEqual((st, d["error"]), (500, "write_failed"))
        self.assertEqual(f.read_bytes(), newer, "a history of a newer schema is untouched")
        self.assertEqual(self.pv("list")[2]["pages"], {}, "an unreadable history is not listed")
        self.assertEqual(self.pv("purge", "about")[2], {"ok": True})
        for junk in (b"not json", b"[1]",
                     b'{"schema":"lumen-page-versions/1","slug":"home","active":null,"versions":[]}',
                     b'{"schema":"lumen-page-versions/1","slug":"about","active":null,"versions":[{"id":"bad"}]}'):
            f.write_bytes(junk)
            self.assertEqual(self.pv("list")[2]["pages"], {}, "an unreadable history is not listed")
            self.add("about")
            parked = sorted(ds.PAGE_VERSIONS_DIR.glob("about.corrupt-*.json"))
            self.assertIn(junk, [p.read_bytes() for p in parked], "the unreadable file is kept aside, whole")
            self.assertEqual(len(self.stored("about")["versions"]), 1, "a clean history starts")
            self.pv("purge", "about")
        self.assertEqual(len(parked), 4)
        self.assertEqual(self.pv("list")[2]["pages"], {}, "a parked file is not a page")

    def test_concurrent_adds_are_all_stored(self):
        errors = []

        def worker(i):
            st, d = ds._pv_handle("add", {"slug": "about"}, {"origin": "manual", "label": str(i),
                                  "content": {"published": blk(str(i))}})
            if st != 200:
                errors.append((st, d))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])
        versions = self.stored("about")["versions"]
        self.assertEqual(len(versions), 20)
        self.assertEqual(len({v["id"] for v in versions}), 20)

    def test_histories_of_two_pages_are_independent(self):
        a = self.add("about")["id"]
        self.add("home")
        self.pv("activate", "about", a)
        self.assertIsNone(self.stored("home")["active"])
        st, _h, d = self.pv("get", "home", a, expect=None)
        self.assertEqual((st, d["error"]), (404, "not_found"), "an id belongs to its page")

    # ── golden file (the PHP twin must produce and read exactly this) ──────────

    def _deterministic(self):
        counter = iter(range(1, 100))
        clock = iter(f"2026-11-19T13:45:{s:02d}Z" for s in range(1, 60))
        saved = (ds._pv_new_id, ds._pv_now)
        ds._pv_new_id = lambda taken: f"v{next(counter):012x}"
        ds._pv_now = lambda: next(clock)
        self.addCleanup(lambda: (setattr(ds, "_pv_new_id", saved[0]), setattr(ds, "_pv_now", saved[1])))

    def test_stored_file_and_list_answer_match_the_golden_fixture(self):
        self._deterministic()
        self.seed_live("about", published=blk("Live", {"background": {"preset": "none", "params": {}}}),
                       title={"en": "About"})
        content = {"title": {"en": "About", "fr": "A propos"},
                   "nav": {"label": {"en": "About", "fr": "A propos"}, "show": True},
                   "published": blk("Spring", {"background": {"preset": "aurora", "params": {"speed": 2}}}),
                   "draft": {"blocks": [{"type": "heading", "props": {"text": {"nl": "Hoi \u00e9\u4e16"}}}]}}
        _st, d1 = ds._pv_handle("add", {"slug": "about"}, {
            "origin": "import", "label": "Spring redesign", "note": "From the lab site",
            "exportedAt": "2026-11-18T09:00:00.000Z", "source": "bemine.be", "platform": "1.86.0",
            "content": content})
        _st, d2 = ds._pv_handle("add", {"slug": "about"}, {"origin": "capture", "label": "Plain",
                                "content": {"published": {"sections": []}}, "activate": "publish"})
        self.assertEqual(d2["snapshotId"], "v000000000003")
        _st, listing = ds._pv_handle("list", {"slug": "about"}, None)
        raw = self.history_file("about").read_bytes()
        pretty = (json.dumps(listing, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        FIXTURES.mkdir(parents=True, exist_ok=True)
        golden_file, golden_list = FIXTURES / "about.history.json", FIXTURES / "about.list.json"
        if os.environ.get("LUMEN_UPDATE_GOLDEN"):
            golden_file.write_bytes(raw)
            golden_list.write_bytes(pretty)
        self.assertEqual(raw, golden_file.read_bytes(), "history file drifted from the golden fixture")
        self.assertEqual(pretty, golden_list.read_bytes(), "list answer drifted from the golden fixture")
        doc = json.loads(raw.decode("utf-8"))
        self.assertEqual(list(doc), ["schema", "slug", "active", "versions"])
        self.assertEqual(list(doc["versions"][0]),
                         ["id", "label", "note", "origin", "createdAt", "updatedAt", "exportedAt", "source",
                          "platform", "content"])
        self.assertEqual(d1["id"], "v000000000001")

    def test_the_golden_file_is_readable_by_this_backend(self):
        """A history written by the PHP twin is this exact file: it must load, list and activate."""
        ds.PAGE_VERSIONS_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy(FIXTURES / "about.history.json", self.history_file("about"))
        _st, _h, listing = self.pv("list", "about")
        self.assertEqual(listing, json.loads((FIXTURES / "about.list.json").read_text(encoding="utf-8")))
        first = listing["pages"]["about"]["versions"][-1]["id"]
        _st, _h, got = self.pv("get", "about", first)
        self.assertEqual(got["version"]["content"]["draft"]["blocks"][0]["props"]["text"]["nl"], "Hoi \u00e9\u4e16")
        self.pv("activate", "about", first, body={"mode": "draft"})


    # ── review fixes ────────────────────────────────────────────────────────────

    @staticmethod
    def nested(depth):
        """{"a": {"a": … {}}}, ``depth`` containers deep."""
        node = {}
        for _ in range(depth - 1):
            node = {"a": node}
        return node

    def deep_block(self, containers):
        """A block whose nesting depth is exactly ``containers``."""
        b = blk("deep")
        b["sections"][0]["columns"][0]["widgets"][0]["props"]["deep"] = self.nested(containers - 8)
        return b

    def raw_post(self, action, slug, raw, vid=None):
        q = f"/api/page-versions.php?action={action}&slug={slug}" + (f"&id={vid}" if vid else "")
        st, _h, got = self.request("POST", q, raw=raw, headers={"Content-Type": "application/json"})
        return st, got

    def test_a_deeply_nested_block_is_refused_and_never_poisons_the_list(self):
        self.assertEqual(ds._pv_depth(self.deep_block(ds._PV_MAX_DEPTH), 1000), ds._PV_MAX_DEPTH)
        ok = self.add("about", {"published": self.deep_block(ds._PV_MAX_DEPTH)})
        self.assertTrue(ok["ok"])
        _st, _h, got = self.pv("add", "about", body={"origin": "manual", "content": {
            "published": self.deep_block(ds._PV_MAX_DEPTH + 1)}}, expect=400)
        self.assertEqual(got["error"], "invalid_content")
        # What a JSON parser still decodes: the request used to be stored, then crash every list.
        raw = ('{"origin":"manual","content":{"published":{"sections":[],"x":'
               + '{"a":' * 900 + "1" + "}" * 900 + "}}}").encode()
        st, got = self.raw_post("add", "about", raw)
        self.assertEqual((st, got["error"]), (400, "invalid_content"))
        self.assertEqual(len(self.stored("about")["versions"]), 1, "the deep version was not stored")
        _st, _h, listing = self.pv("list")
        self.assertEqual(listing["pages"]["about"]["count"], 1)
        # A body no parser can read, or one only this parser reads: a refusal, never an internal error.
        raw = ('{"origin":"manual","content":{"published":{"sections":[],"x":'
               + '{"a":' * 5000 + "1" + "}" * 5000 + "}}}").encode()
        st, got = self.raw_post("add", "about", raw)
        self.assertEqual(st, 400)
        self.assertIn(got["error"], ("invalid_body", "invalid_content"))

    def test_a_history_holding_a_deep_version_still_lists_and_the_other_pages_survive(self):
        self.add("about", {"published": blk("ok")})
        # A hand-written file (or one written by a platform that allowed it): deep but readable.
        doc = self.stored("about")
        doc["versions"][0]["content"]["published"] = {"sections": [], "x": self.nested(800)}
        self.history_file("about").write_text(json.dumps(doc), encoding="utf-8")
        self.add("home", {"published": blk("home")})
        st, _h, listing = self.pv("list")
        self.assertEqual(st, 200)
        self.assertIn("home", listing["pages"])

    def test_a_malformed_body_is_never_read_as_no_body(self):
        vid = self.add("about", {"published": blk("A")})["id"]
        other = self.add("about", {"published": blk("B")})["id"]
        before = self.history_file("about").read_bytes()
        for raw in (b"[1]", b'"x"', b"{bad", b"123", b"true"):
            for action, v in (("activate", vid), ("update", vid), ("add", None)):
                st, got = self.raw_post(action, "about", raw, v)
                self.assertEqual((st, got.get("error")), (400, "invalid_body"), (raw, action))
        # What is not JSON at all is refused by every write, those that read no body included.
        for action, v in (("delete", other), ("purge", None)):
            st, got = self.raw_post(action, "about", b"{bad", v)
            self.assertEqual((st, got.get("error")), (400, "invalid_body"), action)
        self.assertEqual(self.history_file("about").read_bytes(), before)
        self.assertFalse((ds.CONFIG_DIR / "pages" / "about.json").exists(), "nothing was published")
        # ... while an empty body, `null` and `[]` are "no body": the defaults apply.
        for raw in (b"", b"null", b"[]"):
            st, got = self.raw_post("activate", "about", raw, vid)
            self.assertEqual(st, 200, raw)

    def test_a_refused_add_does_not_park_a_corrupt_history(self):
        ds.PAGE_VERSIONS_DIR.mkdir(parents=True, exist_ok=True)
        self.history_file("about").write_text("{nope", encoding="utf-8")
        _st, _h, got = self.pv("add", "about", body={"origin": "capture", "exportedAt": 5,
                                                     "content": {"published": blk("A")}}, expect=400)
        self.assertEqual(got["error"], "invalid_body")
        self.assertEqual([p.name for p in ds.PAGE_VERSIONS_DIR.iterdir()], ["about.json"])
        # The first refusal wins, in the PHP twin's order: text fields, info, mode, content.
        _st, _h, got = self.pv("add", "about", body={"origin": "capture", "label": 5, "activate": "bogus"}, expect=400)
        self.assertEqual(got["error"], "invalid_body")
        _st, _h, got = self.pv("add", "about", body={"origin": "capture", "exportedAt": 5, "content": {}}, expect=400)
        self.assertEqual(got["error"], "invalid_body")
        _st, _h, got = self.pv("add", "about", body={"origin": "capture", "activate": "bogus", "content": {}}, expect=400)
        self.assertEqual(got["error"], "invalid_mode")
        self.assertEqual([p.name for p in ds.PAGE_VERSIONS_DIR.iterdir()], ["about.json"])

    def test_a_snapshot_is_never_refused_because_the_live_page_is_damaged(self):
        vid = self.add("about", {"published": blk("Good")})["id"]
        damaged = {"published": {"sections": [{"columns": "x"}]}, "schemaVersion": 2}
        ds._save_site_doc("pages/about", damaged)
        _st, _h, got = self.pv("activate", "about", vid)
        self.assertIn("snapshotId", got)
        snap = [v for v in self.stored("about")["versions"] if v["id"] == got["snapshotId"]][0]
        self.assertEqual(snap["content"]["published"], damaged["published"])
        self.assertEqual(self.live("about")["published"], blk("Good"))
        # ... nor is "Update from live page" over it.
        ds._save_site_doc("pages/about", damaged)
        _st, _h, got = self.pv("update", "about", vid, body={"fromLive": True})
        self.assertEqual(got["version"]["widgets"], 0)
        # a version captured from a damaged page is kept, never shown: activating it is refused, nothing moves
        live_before = self.files_of("about")
        _st, _h, got = self.pv("activate", "about", vid, expect=400)
        self.assertEqual(got["error"], "invalid_content")
        self.assertEqual(self.files_of("about"), live_before)
        vid = self.add("about", {"published": blk("Good again")})["id"]
        # a live column wider than 12 is kept as it is in the snapshot: nothing is clamped on the way
        wide = blk("Wide")
        wide["sections"][0]["columns"][0]["width"] = 99
        ds._save_site_doc("pages/about", {"published": wide, "schemaVersion": 2})
        _st, _h, got = self.pv("activate", "about", vid)
        snap = [v for v in self.stored("about")["versions"] if v["id"] == got["snapshotId"]][0]
        self.assertEqual(snap["content"]["published"]["sections"][0]["columns"][0]["width"], 99)

    def test_a_legacy_string_title_is_not_snapshotted(self):
        vid = self.add("about", {"published": blk("A")})["id"]
        ds._save_site_doc("pages/about", {"title": "Plain title", "published": blk("Live"), "schemaVersion": 2})
        _st, _h, got = self.pv("activate", "about", vid)
        snap = [v for v in self.stored("about")["versions"] if v["id"] == got["snapshotId"]][0]
        self.assertNotIn("title", snap["content"])

    def test_activation_normalizes_a_legacy_layout_even_when_the_page_shows_the_version(self):
        vid = self.add("about", {"published": blk("A")})["id"]
        # Live = the version, but the draft is still inline in the public file and there is no schemaVersion.
        public = ds.CONFIG_DIR / "pages" / "about.json"
        public.parent.mkdir(parents=True, exist_ok=True)
        public.write_text(json.dumps({"published": blk("A"), "draft": blk("A")}), encoding="utf-8")
        self.pv("activate", "about", vid)
        stored_public = json.loads(public.read_text(encoding="utf-8"))
        self.assertNotIn("draft", stored_public)
        self.assertEqual(stored_public["schemaVersion"], 2)
        self.assertTrue((ds.PAGE_DRAFTS_DIR / "about.json").exists())
        # A page already in the editor's layout is left alone: not a byte moves.
        before = self.files_of("about")
        self.pv("activate", "about", vid)
        self.assertEqual(self.files_of("about"), before)

    def test_a_live_title_survives_activating_a_version_with_another_title(self):
        plain = self.add("about", {"published": blk("P")}, label="no title")["id"]
        titled = self.add("about", {"published": blk("Q"), "title": {"en": "Y"}}, label="titled")["id"]
        self.seed_live("about", published=blk("P"), title={"en": "Live X"})
        _st, _h, got = self.pv("activate", "about", titled)
        self.assertIn("snapshotId", got, "the live title is stored nowhere else")
        snap = [v for v in self.stored("about")["versions"] if v["id"] == got["snapshotId"]][0]
        self.assertEqual(snap["content"]["title"], {"en": "Live X"})
        # activating the title-less version over the same kind of live page loses no title: no snapshot
        self.seed_live("about", published=blk("P"), title={"en": "Live X"})
        _st, _h, got = self.pv("activate", "about", plain)
        self.assertNotIn("snapshotId", got)

    def test_oversize_is_413_whatever_the_escaping_and_slashes_are_not_counted_twice(self):
        wide = {"sections": [{"id": "s", "columns": [{"id": "c", "width": 12, "widgets": [
            {"type": "text", "props": {"body": "é" * 400000}}]}]}]}
        _st, _h, got = self.pv("add", "about", body={"origin": "manual", "content": {"published": wide}}, expect=413)
        self.assertEqual(got["error"], "version_too_large")
        slashes = {"sections": [{"id": "s", "columns": [{"id": "c", "width": 12, "widgets": [
            {"type": "text", "props": {"body": "/" * 1100000}}]}]}]}
        self.pv("add", "about", body={"origin": "manual", "content": {"published": slashes}})

    def test_a_null_sections_beside_blocks_is_the_legacy_shape(self):
        self.pv("add", "about", body={"origin": "manual", "content": {"published": {
            "sections": None, "blocks": [{"type": "heading", "props": {}}]}}})
        self.pv("add", "about", body={"origin": "manual", "content": {"published": {"sections": None}}}, expect=400)

    def test_add_with_activate_at_49_versions_stores_nothing(self):
        self.seed_live("about", published=blk("unsaved live"))
        for i in range(49):
            self.add("about", {"published": blk(f"v{i}")}, label=f"v{i}")
        _st, _h, got = self.pv("add", "about", body={"origin": "manual", "content": {"published": blk("z")},
                                                     "activate": "publish"}, expect=409)
        self.assertEqual(got, {"error": "too_many_versions"})
        self.assertEqual(len(self.stored("about")["versions"]), 49)
        self.assertEqual(self.live("about")["published"], blk("unsaved live"))


if __name__ == "__main__":
    unittest.main()
