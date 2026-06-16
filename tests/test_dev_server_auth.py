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

    def test_first_run_generates_random_pbkdf2_config(self):
        tmp = tempfile.mkdtemp()
        orig = dev_server.CONFIG_FILE
        try:
            dev_server.CONFIG_FILE = Path(tmp) / "config.json"
            cfg = dev_server._load_config()
            self.assertIn("password_pbkdf2", cfg)
            self.assertNotIn("password_sha256", cfg)
            self.assertTrue(cfg["password_pbkdf2"].startswith("pbkdf2_sha256$"))
            # the persisted file must not contain a cleartext password
            persisted = json.loads(dev_server.CONFIG_FILE.read_text(encoding="utf-8"))
            self.assertNotIn("password", persisted)
        finally:
            dev_server.CONFIG_FILE = orig
            shutil.rmtree(tmp, ignore_errors=True)

    def test_check_credentials_with_pbkdf2_config(self):
        tmp = tempfile.mkdtemp()
        orig = dev_server.CONFIG_FILE
        try:
            dev_server.CONFIG_FILE = Path(tmp) / "config.json"
            dev_server.CONFIG_FILE.write_text(json.dumps({
                "username": "admin",
                "password_pbkdf2": dev_server._hash_password("hunter2"),
            }), encoding="utf-8")
            self.assertTrue(dev_server._check_credentials("admin", "hunter2"))
            self.assertFalse(dev_server._check_credentials("admin", "bad"))
            self.assertFalse(dev_server._check_credentials("root", "hunter2"))
        finally:
            dev_server.CONFIG_FILE = orig
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
