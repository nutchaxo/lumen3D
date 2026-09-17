"""The release notes an update brings, version by version.

The GitHub release body carries only the newest changelog, and a version that was
never tagged has no body at all — so tools/build_release.py ships every changelog
as ONE asset (lumen3d-release-notes.json) and dev_server.py reads from it the notes
of every version between the one installed (exclusive) and the latest
(inclusive), oldest first. A release older than the asset falls back to its body.
The changelog page also lists what is installed, from the local changelog files.

Run: py tests/test_release_notes.py
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import dev_server  # noqa: E402
from tools import build_release  # noqa: E402


class SelectChangelogs(unittest.TestCase):
    def test_between_current_and_latest_oldest_first(self):
        versions = {"1.55.0": "d", "1.54.0": "a", "1.54.2": "c", "1.54.1": "b", "1.53.9": "z", "1.55.1": "future"}
        got = dev_server._select_changelogs(versions, "1.54.0", "1.55.0")
        self.assertEqual([g["version"] for g in got], ["1.54.1", "1.54.2", "1.55.0"])
        self.assertEqual(got[0]["markdown"], "b")

    def test_junk_entries_are_ignored(self):
        versions = {"1.54.1": "", "bad": "x", "1.54.2": 3, "1.54.3": "ok", 7: "no"}
        got = dev_server._select_changelogs(versions, "1.54.0", "1.54.3")
        self.assertEqual([g["version"] for g in got], ["1.54.3"])

    def test_nothing_when_up_to_date_or_empty(self):
        self.assertEqual(dev_server._select_changelogs({"1.54.0": "a"}, "1.54.0", "1.54.0"), [])
        self.assertEqual(dev_server._select_changelogs({}, "1.0.0", "2.0.0"), [])
        self.assertEqual(dev_server._select_changelogs(None, "1.0.0", "2.0.0"), [])

    def test_bundle_parser_keeps_only_well_formed_entries(self):
        raw = json.dumps({"versions": [{"version": "1.2.3", "markdown": "m"}, {"version": 1, "markdown": "x"}, "junk", {"version": "1.2.4"}]}).encode()
        self.assertEqual(dev_server._parse_release_notes_bundle(raw), {"1.2.3": "m"})
        self.assertEqual(dev_server._parse_release_notes_bundle(b"[]"), {})


class UpdateCheckNotes(unittest.TestCase):
    """_update_check with GitHub replaced: the asset feeds every version, the body
    alone stands in when the release predates the asset."""

    BODY = "# Changelog v1.55.0\n\n## [ADDED]\n- **X**: y\n"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "changelog_1.54.0.md").write_text("# v1.54.0\n", encoding="utf-8")
        self._saved = {k: getattr(dev_server, k) for k in ("CHANGELOG_DIR", "_http_get_json", "_release_notes_bundle")}
        dev_server.CHANGELOG_DIR = self.tmp
        dev_server._RELEASE_NOTES_CACHE.clear()

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(dev_server, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _release(self, tag, with_asset=True):
        assets = [{"name": "lumen3d-web-1.55.0.zip", "browser_download_url": "https://x/web.zip", "size": 10},
                  {"name": "SHA256SUMS", "browser_download_url": "https://x/sums"}]
        if with_asset:
            assets.append({"name": dev_server.RELEASE_NOTES_ASSET, "browser_download_url": "https://x/notes.json", "size": 10})
        return {"tag_name": tag, "body": self.BODY, "published_at": "2026-09-17T00:00:00Z", "assets": assets,
                "html_url": "https://x/rel", "zipball_url": "https://x/zip"}

    def test_asset_gives_every_version_oldest_first(self):
        dev_server._http_get_json = lambda url, timeout=10: self._release("v1.55.0")
        dev_server._release_notes_bundle = lambda rel: {"1.54.0": "old", "1.54.1": "n1", "1.55.0": "n3", "1.54.2": "n2"}
        c = dev_server._update_check()
        self.assertTrue(c["available"])
        self.assertEqual([x["version"] for x in c["changelogs"]], ["1.54.1", "1.54.2", "1.55.0"])
        self.assertEqual(c["changelogsSource"], "asset")
        self.assertEqual(c["notes"], self.BODY, "the body is still served for an older admin page")

    def test_body_alone_without_the_asset(self):
        dev_server._http_get_json = lambda url, timeout=10: self._release("v1.55.0", with_asset=False)
        c = dev_server._update_check()
        self.assertEqual(c["changelogs"], [{"version": "1.55.0", "markdown": self.BODY}])
        self.assertEqual(c["changelogsSource"], "body")

    def test_asset_failure_falls_back_to_the_body(self):
        dev_server._http_get_json = lambda url, timeout=10: self._release("v1.55.0")

        def boom(rel):
            raise OSError("network")
        dev_server._release_notes_bundle = boom
        c = dev_server._update_check()
        self.assertEqual([x["version"] for x in c["changelogs"]], ["1.55.0"])
        self.assertEqual(c["changelogsSource"], "body")

    def test_up_to_date_carries_no_changelogs(self):
        dev_server._http_get_json = lambda url, timeout=10: self._release("v1.54.0")
        dev_server._release_notes_bundle = lambda rel: {"1.54.0": "a"}
        c = dev_server._update_check()
        self.assertFalse(c["available"])
        self.assertEqual(c["changelogs"], [])
        self.assertIsNone(c["changelogsSource"])

    def test_bundle_is_read_from_the_asset_and_cached_per_tag(self):
        calls = []

        class Resp:
            def __init__(self, raw): self.raw = raw
            def read(self, n=-1): return self.raw
            def __enter__(self): return self
            def __exit__(self, *a): return False
        raw = json.dumps({"versions": [{"version": "1.55.0", "markdown": "m"}]}).encode()
        saved = dev_server.urllib.request.urlopen
        dev_server.urllib.request.urlopen = lambda req, timeout=20: (calls.append(req.full_url), Resp(raw))[1]
        try:
            rel = self._release("v1.55.0")
            self.assertEqual(dev_server._release_notes_bundle(rel), {"1.55.0": "m"})
            self.assertEqual(dev_server._release_notes_bundle(rel), {"1.55.0": "m"})
            self.assertEqual(calls, ["https://x/notes.json"], "downloaded once, then served from the per-tag cache")
            self.assertIsNone(dev_server._release_notes_bundle(self._release("v1.56.0", with_asset=False)), "no asset ⇒ None")
        finally:
            dev_server.urllib.request.urlopen = saved


class LocalChangelogs(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._saved = dev_server.CHANGELOG_DIR
        dev_server.CHANGELOG_DIR = self.tmp

    def tearDown(self):
        dev_server.CHANGELOG_DIR = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_newest_first_and_only_real_changelogs(self):
        (self.tmp / "changelog_1.2.3.md").write_text("# a\n", encoding="utf-8")
        (self.tmp / "changelog_1.10.0.md").write_text("# b\n", encoding="utf-8")
        (self.tmp / "changelog_1.9.9.md").write_text("   ", encoding="utf-8")   # empty: not a version
        (self.tmp / "notes.md").write_text("# junk\n", encoding="utf-8")
        got = dev_server._local_changelogs()
        self.assertEqual([g["version"] for g in got], ["1.10.0", "1.2.3"], "numeric order, not lexical")
        self.assertEqual(got[0]["markdown"], "# b\n")


class ReleaseNotesAsset(unittest.TestCase):
    def test_asset_bundles_every_flat_changelog_newest_first(self):
        doc = json.loads(build_release.build_release_notes("9.9.9").decode("utf-8"))
        self.assertEqual(doc["schema"], 1)
        self.assertEqual(doc["latest"], "9.9.9")
        versions = [v["version"] for v in doc["versions"]]
        flat = sorted((p.stem.split("_", 1)[1] for p in (ROOT / "changelog").glob("changelog_*.md")),
                      key=dev_server._version_tuple, reverse=True)
        self.assertEqual(versions, flat, "the flat changelog directory, newest first")
        self.assertEqual(versions[0], dev_server._max_version(ROOT / "changelog"))
        self.assertTrue(all(v["markdown"].strip() for v in doc["versions"]))
        archived = {p.stem.split("_", 1)[1] for p in (ROOT / "changelog" / "archive").glob("changelog_*.md")}
        self.assertTrue(archived, "the archive exists")
        self.assertFalse(archived & set(versions), "archived history is not shipped")
        self.assertNotIn("\r", doc["versions"][0]["markdown"], "line endings normalised")


if __name__ == "__main__":
    unittest.main(verbosity=1)
