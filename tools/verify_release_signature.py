#!/usr/bin/env python3
"""Check a built release against the PINNED publisher key before it is uploaded.

    python tools/verify_release_signature.py dist

Reads the public key pinned in dev_server.py (_RELEASE_PUBKEY_HEX), in
install.php (PINNED_PUBKEY) and in the PHP updater api/_admin_lib.php
(LUMEN_RELEASE_PUBKEY) as text (no file is imported or executed), requires all
three to be set and identical, then verifies dist/SHA256SUMS.sig over the
exact bytes of dist/SHA256SUMS. Exit 0 only when everything agrees: a release that
the updater would refuse (wrong secret, unsigned, key not pinned) never gets
published.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import ed25519_pure as ed  # noqa: E402

_HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")


def _pinned(path: Path, pattern: str) -> str:
    m = re.search(pattern, path.read_text(encoding="utf-8"), re.MULTILINE)
    if not m:
        sys.exit(f"ERROR: cannot find the pinned key declaration in {path.name}")
    return m.group(1).strip().lower()


def main() -> int:
    dist = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist"
    py_key = _pinned(ROOT / "dev_server.py", r'^_RELEASE_PUBKEY_HEX\s*=\s*"([^"]*)"')
    php_key = _pinned(ROOT / "install.php", r"^const PINNED_PUBKEY\s*=\s*'([^']*)'")
    # The PHP hosts' one-click updater: a key that disagrees there would strand every
    # PHP host on this release (each later update refused as badly signed).
    upd_key = _pinned(ROOT / "api" / "_admin_lib.php", r"^const LUMEN_RELEASE_PUBKEY\s*=\s*'([^']*)'")
    keys = (("dev_server.py _RELEASE_PUBKEY_HEX", py_key), ("install.php PINNED_PUBKEY", php_key),
            ("api/_admin_lib.php LUMEN_RELEASE_PUBKEY", upd_key))
    for name, key in keys:
        if not _HEX64.match(key):
            print(f"ERROR: {name} is not a 64-hex Ed25519 public key (empty = release key not pinned).")
            return 1
    if len({key for _, key in keys}) != 1:
        print("ERROR: the pinned keys of dev_server.py, install.php and api/_admin_lib.php differ.")
        return 1

    sums, sig = dist / "SHA256SUMS", dist / "SHA256SUMS.sig"
    if not sums.is_file() or not sig.is_file():
        print(f"ERROR: {sums} or {sig} is missing - the release is unsigned.")
        return 1
    sig_hex = sig.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{128}", sig_hex):
        print("ERROR: SHA256SUMS.sig is not 128 hex characters.")
        return 1
    if not ed.verify_hex(py_key, sums.read_bytes(), sig_hex):
        print("ERROR: SHA256SUMS.sig does not verify under the pinned public key "
              "(is LUMEN_SIGNING_KEY the seed of that key?).")
        return 1
    print(f"OK: SHA256SUMS.sig verifies under the pinned key {py_key[:16]}...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
