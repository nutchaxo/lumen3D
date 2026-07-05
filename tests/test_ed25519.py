"""Pin the vendored Ed25519 verifier to the RFC 8032 §7.1 test vectors, and prove
sign/verify agree + that tampering is rejected. If this fails, the release
authenticity chain is broken — do not ship.

    python tests/test_ed25519.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ed25519_pure as ed  # noqa: E402

# RFC 8032, Section 7.1 — canonical Ed25519 vectors (verbatim hex).
VECTORS = [
    {  # TEST 1 — empty message
        "seed": "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "pub":  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "msg":  "",
        "sig":  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f"
                "b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    },
    {  # TEST 2 — one-byte message 0x72
        "seed": "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
        "pub":  "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
        "msg":  "72",
        "sig":  "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da08"
                "5ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    },
]

fails = 0


def check(name, cond):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        fails += 1


for i, v in enumerate(VECTORS, 1):
    seed = bytes.fromhex(v["seed"])
    pub = bytes.fromhex(v["pub"])
    msg = bytes.fromhex(v["msg"])
    sig = bytes.fromhex(v["sig"])

    check(f"vec{i}: publickey(seed) matches RFC", ed.publickey(seed) == pub)
    check(f"vec{i}: sign(seed,msg) reproduces RFC signature", ed.sign(seed, msg) == sig)
    check(f"vec{i}: verify accepts the valid signature", ed.verify(pub, msg, sig) is True)
    check(f"vec{i}: verify_hex accepts (hex API)", ed.verify_hex(v["pub"], msg, v["sig"]) is True)

    # Tamper detection — every mutation must be rejected.
    if msg:
        bad_msg = bytes([msg[0] ^ 0x01]) + msg[1:]
        check(f"vec{i}: tampered message rejected", ed.verify(pub, bad_msg, sig) is False)
    else:
        check(f"vec{i}: extra message byte rejected", ed.verify(pub, b"\x00", sig) is False)

    bad_sig = bytes([sig[0] ^ 0x01]) + sig[1:]
    check(f"vec{i}: tampered signature rejected", ed.verify(pub, msg, bad_sig) is False)

    other = VECTORS[(i) % len(VECTORS)]  # the other vector's key
    check(f"vec{i}: wrong public key rejected",
          ed.verify(bytes.fromhex(other["pub"]), msg, sig) is False)

# Malformed inputs never raise — always False.
check("malformed lengths return False (no raise)",
      ed.verify(b"\x00" * 31, b"x", b"\x00" * 64) is False and
      ed.verify(b"\x00" * 32, b"x", b"\x00" * 63) is False and
      ed.verify_hex("zz", b"x", "zz") is False)

# Round-trip on a fresh (non-RFC) seed to exercise the full path independently.
seed = bytes(range(32))
pub = ed.publickey(seed)
msg = b"lumen3d-release SHA256SUMS\n"
sig = ed.sign(seed, msg)
check("round-trip: fresh keypair verifies", ed.verify(pub, msg, sig) is True)
check("round-trip: tamper rejected", ed.verify(pub, msg + b"!", sig) is False)

if fails:
    print(f"\n{fails} ED25519 CHECKS FAILED")
    sys.exit(1)
print("\nALL ED25519 CHECKS PASSED (py)")
