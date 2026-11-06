"""A failed self-update tells the admin browser a stable code, never the host's own text.

dev_server._run_update keeps the exception text (file names of the host) in the server
log and puts `<phase>_failed` (or the code of a deliberate refusal) in the state the
Updates tab reads and in the outcome file that survives a restart.

    python tests/test_update_failure_codes.py
"""
import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import dev_server as ds  # noqa: E402

SECRET = r"C:\hosting\private\site\backups\x.zip"


class UpdateFailureCodes(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lumen-upd-"))
        keys = ("BACKUPS_DIR", "LAST_UPDATE_FILE", "JOURNAL_FILE", "_preflight_update", "_prune_backups",
                "_make_backup_zip", "_http_download")
        self._saved = {k: getattr(ds, k) for k in keys}
        self._state = dict(ds._UPDATE_STATE)
        ds.BACKUPS_DIR = self.tmp / "backups"
        ds.LAST_UPDATE_FILE = ds.BACKUPS_DIR / "last-update.json"
        ds.JOURNAL_FILE = ds.BACKUPS_DIR / "pivot-journal.json"
        ds._prune_backups = lambda *a, **k: None

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(ds, k, v)
        ds._UPDATE_STATE.clear()
        ds._UPDATE_STATE.update(self._state)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_update(self):
        out = io.StringIO()
        ds._UPDATE_STATE.update({"running": True, "error": None})
        with contextlib.redirect_stdout(out):
            ds._run_update({"current": "1.0.0", "latest": "1.0.1", "assetUrl": "u", "sumsUrl": "s", "assetName": "a.zip"})
        return out.getvalue()

    def outcome(self):
        state = dict(ds._UPDATE_STATE)
        last = json.loads(ds.LAST_UPDATE_FILE.read_text(encoding="utf-8"))
        return state, last

    def test_generic_failure_is_a_phase_code(self):
        def boom(info):
            raise OSError(f"backups/ non inscriptible: [Errno 13] {SECRET}")
        ds._preflight_update = boom
        log = self.run_update()
        state, last = self.outcome()
        self.assertEqual((state["phase"], state["error"], state["running"]), ("error", "preflight_failed", False))
        self.assertEqual(last["error"], "preflight_failed")
        self.assertNotIn(SECRET, json.dumps(state) + json.dumps(last))
        self.assertIn(SECRET, log, "the server log keeps the full text")

    def test_backup_phase_code(self):
        ds._preflight_update = lambda info: None

        def boom(path):
            raise OSError(f"sauvegarde incomplète — {SECRET}: denied")
        ds._make_backup_zip = boom
        self.run_update()
        state, last = self.outcome()
        self.assertEqual((state["error"], last["error"]), ("backup_failed", "backup_failed"))

    def test_deliberate_refusal_keeps_its_own_code(self):
        def boom(info):
            raise ds._UpdateError("insufficient_disk", f"espace disque insuffisant ({SECRET})")
        ds._preflight_update = boom
        self.run_update()
        state, last = self.outcome()
        self.assertEqual((state["error"], last["error"]), ("insufficient_disk", "insufficient_disk"))

    def test_signature_refusals_carry_a_code(self):
        saved = (ds._RELEASE_PUBKEY_HEX, ds._ed25519)
        ds._RELEASE_PUBKEY_HEX, ds._ed25519 = "00" * 32, object()
        try:
            with self.assertRaises(ds._UpdateError) as cm:
                ds._verify_release_signature(b"sums", {"sigUrl": None})
            self.assertEqual(cm.exception.code, "signature_invalid")
            self.assertIsInstance(cm.exception, OSError)
        finally:
            ds._RELEASE_PUBKEY_HEX, ds._ed25519 = saved


if __name__ == "__main__":
    unittest.main(verbosity=2)
