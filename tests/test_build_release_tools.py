"""Release tooling invariants: what the allowlist ships, reproducible timestamp,
and the pinned-key signature gate used by release.yml (tools/verify_release_signature.py).

Run: python tests/test_build_release_tools.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import ed25519_pure as ed          # noqa: E402
import build_release as br         # noqa: E402
import verify_release_signature as vrs  # noqa: E402


class TestAllowlist(unittest.TestCase):
    def test_api_ships_php_and_two_support_files_only(self):
        shipped = {p.relative_to(ROOT).as_posix() for _, p in br.collect_files(ROOT) if p.relative_to(ROOT).parts[0] == "api"}
        for name in shipped:
            self.assertTrue(name.endswith(".php") or name in ("api/.htaccess", "api/ca-bundle.pem"), name)
        for state in ("api/admin_credential.json", "api/stats.json", "api/page-drafts/.migrated", "api/plugin-trust.json"):
            self.assertNotIn(state, shipped)

    def test_no_secret_or_dev_content(self):
        names = [a for a, _ in br.collect_files(ROOT)]
        for bad in ("secrets/", "uploads/", "tests/", "tools/", "DOCS/", "preprocess/", ".git", "widgets.html"):
            self.assertFalse([n for n in names if n == bad or n.startswith(bad)], bad)
        self.assertFalse([n for n in names if n.startswith("config/") and not n.startswith("config/defaults/")
                          and n != "config/theme.css"])

    def test_every_flat_changelog_is_in_the_release_notes(self):
        import json
        doc = json.loads(br.build_release_notes("9.9.9"))
        flat = [p for p in (ROOT / "changelog").iterdir() if br.CHANGELOG_NAME_RE.match(p.name) and p.read_text(encoding="utf-8").strip()]
        self.assertEqual(len(doc["versions"]), len(flat))

    def test_timestamp_follows_source_date_epoch(self):
        old = os.environ.get("SOURCE_DATE_EPOCH")
        os.environ["SOURCE_DATE_EPOCH"] = "1700000000"
        try:
            self.assertEqual(br._release_timestamp(), "2023-11-14T22:13:20Z")
        finally:
            if old is None:
                del os.environ["SOURCE_DATE_EPOCH"]
            else:
                os.environ["SOURCE_DATE_EPOCH"] = old


class TestSignatureGate(unittest.TestCase):
    def _tree(self, tmp, py_key, php_key, sums, sig_hex, upd_key=None):
        tmp = Path(tmp)
        (tmp / "dev_server.py").write_text(f'_RELEASE_PUBKEY_HEX = "{py_key}"\n', encoding="utf-8")
        (tmp / "install.php").write_text(f"const PINNED_PUBKEY = '{php_key}';\n", encoding="utf-8")
        (tmp / "api").mkdir()
        (tmp / "api" / "_admin_lib.php").write_text(
            f"const LUMEN_RELEASE_PUBKEY = '{py_key if upd_key is None else upd_key}';\n", encoding="utf-8")
        dist = tmp / "dist"
        dist.mkdir()
        (dist / "SHA256SUMS").write_bytes(sums)
        if sig_hex is not None:
            (dist / "SHA256SUMS.sig").write_text(sig_hex + "\n", encoding="utf-8")
        return dist

    def _run(self, tmp, dist):
        old_root, old_argv = vrs.ROOT, sys.argv
        vrs.ROOT = Path(tmp)
        sys.argv = ["verify", str(dist)]
        try:
            return vrs.main()
        finally:
            vrs.ROOT, sys.argv = old_root, old_argv

    def test_gate(self):
        seed = bytes(range(32))
        pub = ed.publickey(seed).hex()
        sums = b"abc  lumen3d-web-1.0.0.zip\n"
        good = ed.sign(seed, sums).hex()
        other = ed.sign(bytes([7] * 32), sums).hex()
        cases = [
            (pub, pub, good, 0),        # signed with the pinned key
            (pub, pub, other, 1),       # signed with another key
            (pub, pub, None, 1),        # unsigned
            ("", "", good, 1),          # key not pinned
            (pub, "", good, 1),         # install.php not pinned
            (pub, ed.publickey(bytes([7] * 32)).hex(), good, 1),  # twins disagree
        ]
        for py_key, php_key, sig, want in cases:
            with tempfile.TemporaryDirectory() as tmp:
                dist = self._tree(tmp, py_key, php_key, sums, sig)
                self.assertEqual(self._run(tmp, dist), want, (py_key[:6], php_key[:6], sig and sig[:6]))
        # The PHP updater's own pin: empty or different strands every PHP host.
        for upd_key in ("", ed.publickey(bytes([7] * 32)).hex()):
            with tempfile.TemporaryDirectory() as tmp:
                dist = self._tree(tmp, pub, pub, sums, good, upd_key=upd_key)
                self.assertEqual(self._run(tmp, dist), 1, upd_key[:6])

    def test_real_tree_keys_agree(self):
        """The three pinned keys of the repository are set and identical."""
        keys = {
            vrs._pinned(ROOT / "dev_server.py", r'^_RELEASE_PUBKEY_HEX\s*=\s*"([^"]*)"'),
            vrs._pinned(ROOT / "install.php", r"^const PINNED_PUBKEY\s*=\s*'([^']*)'"),
            vrs._pinned(ROOT / "api" / "_admin_lib.php", r"^const LUMEN_RELEASE_PUBKEY\s*=\s*'([^']*)'"),
        }
        self.assertEqual(len(keys), 1)
        self.assertRegex(next(iter(keys)), r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main(verbosity=2)
