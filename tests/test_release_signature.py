"""Updater authenticity gate (L7): dev_server._verify_release_signature must be a
no-op when no key is pinned, and FAIL-CLOSED in every failure mode once a key is
pinned (missing sig, wrong sig, no verifier). Uses a locally generated keypair — no
network, no committed secret.

    python tests/test_release_signature.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dev_server as ds  # noqa: E402
import ed25519_pure as ed  # noqa: E402

fails = 0


def check(name, cond):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        fails += 1


def raises(fn):
    try:
        fn()
        return False
    except Exception:
        return True


SEED = bytes(range(1, 33))
PUB = ed.publickey(SEED)
SUMS = b"ab" * 32 + b"  lumen3d-web-9.9.9.zip\n"
GOOD_SIG_HEX = ed.sign(SEED, SUMS).hex().encode("ascii")

# Save originals to restore between cases.
_orig_pub = ds._RELEASE_PUBKEY_HEX
_orig_ed = ds._ed25519
_orig_fetch = ds._fetch_url_bytes

try:
    # A. No key pinned → no-op (integrity-only mode). Never raises even without a sig.
    ds._RELEASE_PUBKEY_HEX = ""
    check("no key pinned → no-op (no raise)",
          not raises(lambda: ds._verify_release_signature(SUMS, {})))

    # B. Key pinned + valid detached signature (hex) → passes.
    ds._RELEASE_PUBKEY_HEX = PUB.hex()
    ds._fetch_url_bytes = lambda url, **kw: GOOD_SIG_HEX
    check("valid signature accepted",
          not raises(lambda: ds._verify_release_signature(SUMS, {"sigUrl": "https://x/SHA256SUMS.sig"})))

    # B2. Raw 64-byte binary signature also accepted.
    ds._fetch_url_bytes = lambda url, **kw: ed.sign(SEED, SUMS)
    check("raw binary signature accepted",
          not raises(lambda: ds._verify_release_signature(SUMS, {"sigUrl": "https://x/SHA256SUMS.sig"})))

    # C. Key pinned but NO signature asset → fail-closed.
    ds._fetch_url_bytes = lambda url, **kw: GOOD_SIG_HEX
    check("missing SHA256SUMS.sig rejected (fail-closed)",
          raises(lambda: ds._verify_release_signature(SUMS, {})))

    # D. Signature over DIFFERENT bytes → rejected.
    ds._fetch_url_bytes = lambda url, **kw: ed.sign(SEED, SUMS + b"tampered").hex().encode()
    check("signature over other bytes rejected",
          raises(lambda: ds._verify_release_signature(SUMS, {"sigUrl": "https://x"})))

    # E. Signature by a DIFFERENT key → rejected.
    ds._fetch_url_bytes = lambda url, **kw: ed.sign(bytes(range(2, 34)), SUMS).hex().encode()
    check("signature by wrong key rejected",
          raises(lambda: ds._verify_release_signature(SUMS, {"sigUrl": "https://x"})))

    # F. Verifier module unavailable while a key is pinned → fail-closed.
    ds._ed25519 = None
    ds._fetch_url_bytes = lambda url, **kw: GOOD_SIG_HEX
    check("no verifier available rejected (fail-closed)",
          raises(lambda: ds._verify_release_signature(SUMS, {"sigUrl": "https://x"})))
finally:
    ds._RELEASE_PUBKEY_HEX = _orig_pub
    ds._ed25519 = _orig_ed
    ds._fetch_url_bytes = _orig_fetch

if fails:
    print(f"\n{fails} RELEASE-SIGNATURE CHECKS FAILED")
    sys.exit(1)
print("\nALL RELEASE-SIGNATURE CHECKS PASSED (py)")
