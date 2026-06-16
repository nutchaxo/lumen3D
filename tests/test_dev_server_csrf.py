"""Unit tests for dev_server.py CSRF protection (ELE-05 / SEC-007).

State-changing actions (save, save_thumbnail, rebuild_catalog) relied only on
the auth cookie and rebuild_catalog was triggerable via GET. The fix requires
POST + a per-session CSRF token in the X-CSRF-Token header.

Run: py tests/test_dev_server_csrf.py
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import dev_server  # noqa: E402


class TestCsrf(unittest.TestCase):
    def test_new_session_has_csrf(self):
        tok = dev_server._new_session("admin")
        try:
            s = dev_server._SESSIONS[tok]
            self.assertIn("csrf", s)
            self.assertGreaterEqual(len(s["csrf"]), 32)
        finally:
            dev_server._SESSIONS.pop(tok, None)

    def test_is_write_action(self):
        for a in ("save", "save_thumbnail", "rebuild_catalog"):
            self.assertTrue(dev_server._is_write_action(a))
        for a in ("list", "get", "status", "login", "logout", ""):
            self.assertFalse(dev_server._is_write_action(a))

    def test_check_csrf(self):
        s = {"csrf": "abc123"}
        self.assertTrue(dev_server._check_csrf(s, "abc123"))
        self.assertFalse(dev_server._check_csrf(s, "wrong"))
        self.assertFalse(dev_server._check_csrf(s, None))
        self.assertFalse(dev_server._check_csrf(None, "abc123"))
        self.assertFalse(dev_server._check_csrf({}, "abc123"))

    def test_authorize_write(self):
        s = {"csrf": "tok"}
        ok, st, _ = dev_server._authorize_write("POST", s, "tok")
        self.assertTrue(ok)
        self.assertEqual(st, 200)
        # GET on a write action is rejected (blocks GET-triggered CSRF)
        ok, st, _ = dev_server._authorize_write("GET", s, "tok")
        self.assertFalse(ok)
        self.assertEqual(st, 405)
        # POST with wrong / missing token is rejected
        for bad in ("bad", None, ""):
            ok, st, _ = dev_server._authorize_write("POST", s, bad)
            self.assertFalse(ok)
            self.assertEqual(st, 403)
        # POST without a session is rejected
        ok, st, _ = dev_server._authorize_write("POST", None, "tok")
        self.assertFalse(ok)
        self.assertEqual(st, 403)


if __name__ == "__main__":
    unittest.main(verbosity=2)
