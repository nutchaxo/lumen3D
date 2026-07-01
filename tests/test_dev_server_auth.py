"""Unit tests for dev_server.py password hashing (ELE-08 / SEC-010).

Before the fix the admin password defaulted to a hardcoded constant
("iribhm2024") and was hashed with unsalted SHA-256. These tests assert salted
PBKDF2 hashing, backward-compatible verification of legacy hashes, and the
absence of any hardcoded default password.

Run: py tests/test_dev_server_auth.py
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
import dev_server  # noqa: E402


class TestPasswordHashing(unittest.TestCase):
    def test_pbkdf2_roundtrip(self):
        h = dev_server._hash_password("s3cret!")
        self.assertTrue(h.startswith("pbkdf2_sha256$"))
        self.assertTrue(dev_server._verify_password("s3cret!", h))
        self.assertFalse(dev_server._verify_password("wrong", h))

    def test_salt_is_random(self):
        a = dev_server._hash_password("same")
        b = dev_server._hash_password("same")
        self.assertNotEqual(a, b, "salt must be random per hash")
        self.assertTrue(dev_server._verify_password("same", a))
        self.assertTrue(dev_server._verify_password("same", b))

    def test_legacy_sha256_backward_compat(self):
        legacy = hashlib.sha256(b"oldpw").hexdigest()
        self.assertTrue(dev_server._verify_password("oldpw", legacy))
        self.assertFalse(dev_server._verify_password("nope", legacy))

    def test_verify_rejects_empty(self):
        self.assertFalse(dev_server._verify_password("x", ""))
        self.assertFalse(dev_server._verify_password("x", None))

    def test_no_hardcoded_default_password(self):
        self.assertFalse(hasattr(dev_server, "DEFAULT_PASSWORD"))
        src = Path(ROOT, "dev_server.py").read_text(encoding="utf-8")
        self.assertNotIn("iribhm2024", src)

    def test_load_config_no_longer_stores_password(self):
        # v1.4.0: the password moved to the dedicated credential store. _load_config
        # no longer auto-generates one — a missing credential drives first-run setup.
        tmp = tempfile.mkdtemp()
        orig_cfg, orig_cred = dev_server.CONFIG_FILE, dev_server.CRED_FILE
        try:
            dev_server.CONFIG_FILE = Path(tmp) / "config.json"
            dev_server.CRED_FILE = Path(tmp) / "admin_credential.json"
            cfg = dev_server._load_config()
            self.assertNotIn("password_pbkdf2", cfg)
            self.assertEqual(cfg.get("username"), dev_server.DEFAULT_USERNAME)
            self.assertFalse(dev_server.CONFIG_FILE.exists())  # a read must not write
            self.assertFalse(dev_server._credential_exists())
        finally:
            dev_server.CONFIG_FILE, dev_server.CRED_FILE = orig_cfg, orig_cred
            shutil.rmtree(tmp, ignore_errors=True)

    def test_credential_setup_and_check(self):
        tmp = tempfile.mkdtemp()
        orig = dev_server.CRED_FILE
        try:
            dev_server.CRED_FILE = Path(tmp) / "admin_credential.json"
            self.assertFalse(dev_server._credential_exists())
            ok, status, _ = dev_server._setup_credential("admin", "hunter2")
            self.assertTrue(ok)
            self.assertEqual(status, 200)
            self.assertTrue(dev_server._check_credentials("admin", "hunter2"))
            self.assertFalse(dev_server._check_credentials("admin", "bad"))
            self.assertFalse(dev_server._check_credentials("root", "hunter2"))
            # persisted record holds only a one-way hash, never cleartext
            text = dev_server.CRED_FILE.read_text(encoding="utf-8")
            self.assertIn("pbkdf2_sha256$", text)
            self.assertNotIn("hunter2", text)
        finally:
            dev_server.CRED_FILE = orig
            shutil.rmtree(tmp, ignore_errors=True)

    def test_setup_is_exclusive(self):
        # Anti-overwrite guarantee: a second setup can never replace a live credential.
        tmp = tempfile.mkdtemp()
        orig = dev_server.CRED_FILE
        try:
            dev_server.CRED_FILE = Path(tmp) / "admin_credential.json"
            ok1, _, _ = dev_server._setup_credential("admin", "first-pw")
            self.assertTrue(ok1)
            ok2, status2, payload2 = dev_server._setup_credential("admin", "second-pw")
            self.assertFalse(ok2)
            self.assertEqual(status2, 409)
            self.assertEqual(payload2.get("error"), "already_configured")
            # the overwrite attempt had no effect — original password still valid
            self.assertTrue(dev_server._check_credentials("admin", "first-pw"))
            self.assertFalse(dev_server._check_credentials("admin", "second-pw"))
        finally:
            dev_server.CRED_FILE = orig
            shutil.rmtree(tmp, ignore_errors=True)

    def test_change_requires_current_password(self):
        tmp = tempfile.mkdtemp()
        orig = dev_server.CRED_FILE
        try:
            dev_server.CRED_FILE = Path(tmp) / "admin_credential.json"
            dev_server._setup_credential("admin", "old-pw")
            ok, status, _ = dev_server._change_credential("wrong", "new-pw")
            self.assertFalse(ok)
            self.assertEqual(status, 401)
            self.assertTrue(dev_server._check_credentials("admin", "old-pw"))
            ok2, status2, _ = dev_server._change_credential("old-pw", "new-pw")
            self.assertTrue(ok2)
            self.assertEqual(status2, 200)
            self.assertTrue(dev_server._check_credentials("admin", "new-pw"))
            self.assertFalse(dev_server._check_credentials("admin", "old-pw"))
        finally:
            dev_server.CRED_FILE = orig
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
