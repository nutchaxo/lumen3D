"""Vendored, dependency-free Ed25519 (RFC 8032) — sign + verify in pure Python.

The platform ships and runs on the Python standard library ONLY (no ``cryptography``
/ ``PyNaCl``). The self-updater needs to *authenticate* a release — prove it was
produced by the holder of the project signing key, not merely that its bytes are
intact — so it needs asymmetric signature verification with no third-party wheel.

This is the canonical RFC 8032 reference implementation (public domain, from the
RFC appendix / D. J. Bernstein's ref code), lightly wrapped with hex helpers.
It is the *slow* variable-time version: that is fine here because verification
operates exclusively on **public** data (public key, released manifest, detached
signature) — there is no secret to leak through a timing side channel. The
``sign`` path is included for the release tooling/tests only; the deployed host
never holds a private seed.

Public API:
    publickey(seed32)            -> pub32          (bytes)
    sign(seed32, msg)            -> sig64          (bytes)
    verify(pub32, msg, sig64)    -> bool
    verify_hex(pub_hex, msg, sig_hex) -> bool      (bytes msg, hex key/sig)

Do not "optimize" the field math without re-running tests/test_ed25519.py, which
pins the two RFC 8032 §7.1 vectors byte-for-byte.
"""

import hashlib

# Curve25519 / edwards25519 constants (RFC 8032 §5.1).
_p = 2 ** 255 - 19                                             # field prime
_q = 2 ** 252 + 27742317777372353535851937790883648493        # group order (L)


def _sha512(data):
    return hashlib.sha512(data).digest()


def _modp_inv(x):
    return pow(x, _p - 2, _p)


_d = -121665 * _modp_inv(121666) % _p          # curve constant d
_I = pow(2, (_p - 1) // 4, _p)                 # sqrt(-1) mod p


def _recover_x(y, sign):
    if y >= _p:
        return None
    xx = (y * y - 1) * _modp_inv(_d * y * y + 1) % _p
    if xx == 0:
        return None if sign else 0
    x = pow(xx, (_p + 3) // 8, _p)
    if (x * x - xx) % _p != 0:
        x = x * _I % _p
    if (x * x - xx) % _p != 0:
        return None
    if (x & 1) != sign:
        x = _p - x
    return x


# Base point B, in extended homogeneous coordinates (X, Y, Z, T) with T = X*Y/Z.
_g_y = 4 * _modp_inv(5) % _p
_g_x = _recover_x(_g_y, 0)
_B = (_g_x, _g_y, 1, _g_x * _g_y % _p)


def _point_add(P, Q):
    A = (P[1] - P[0]) * (Q[1] - Q[0]) % _p
    Bb = (P[1] + P[0]) * (Q[1] + Q[0]) % _p
    C = 2 * P[3] * Q[3] * _d % _p
    D = 2 * P[2] * Q[2] % _p
    E, F, G, H = Bb - A, D - C, D + C, Bb + A
    return (E * F % _p, G * H % _p, F * G % _p, E * H % _p)


def _point_mul(s, P):
    Q = (0, 1, 1, 0)          # neutral element
    while s > 0:
        if s & 1:
            Q = _point_add(Q, P)
        P = _point_add(P, P)
        s >>= 1
    return Q


def _point_equal(P, Q):
    if (P[0] * Q[2] - Q[0] * P[2]) % _p != 0:
        return False
    if (P[1] * Q[2] - Q[1] * P[2]) % _p != 0:
        return False
    return True


def _point_compress(P):
    zinv = _modp_inv(P[2])
    x = P[0] * zinv % _p
    y = P[1] * zinv % _p
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _point_decompress(s):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _p)


def _secret_expand(seed):
    if len(seed) != 32:
        raise ValueError("Ed25519 seed must be 32 bytes")
    h = _sha512(seed)
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= (1 << 254)
    return a, h[32:]


def publickey(seed):
    """Derive the 32-byte public key from a 32-byte private seed."""
    a, _ = _secret_expand(seed)
    return _point_compress(_point_mul(a, _B))


def sign(seed, msg):
    """Produce a 64-byte detached Ed25519 signature over ``msg`` (bytes)."""
    a, prefix = _secret_expand(seed)
    A = _point_compress(_point_mul(a, _B))
    r = int.from_bytes(_sha512(prefix + msg), "little") % _q
    R = _point_mul(r, _B)
    Rs = _point_compress(R)
    k = int.from_bytes(_sha512(Rs + A + msg), "little") % _q
    S = (r + k * a) % _q
    return Rs + int.to_bytes(S, 32, "little")


def verify(public, msg, signature):
    """True iff ``signature`` (64 bytes) is a valid Ed25519 sig of ``msg`` under ``public``.

    Never raises on malformed inputs — returns False. Fail-closed by construction.
    """
    try:
        if len(public) != 32 or len(signature) != 64:
            return False
        A = _point_decompress(public)
        if A is None:
            return False
        Rs = signature[:32]
        R = _point_decompress(Rs)
        if R is None:
            return False
        S = int.from_bytes(signature[32:], "little")
        if S >= _q:
            return False
        k = int.from_bytes(_sha512(Rs + public + msg), "little") % _q
        return _point_equal(_point_mul(S, _B), _point_add(R, _point_mul(k, A)))
    except Exception:
        return False


def verify_hex(public_hex, msg, signature_hex):
    """Convenience wrapper: hex-encoded key + signature, raw-bytes message."""
    try:
        pub = bytes.fromhex((public_hex or "").strip())
        sig = bytes.fromhex((signature_hex or "").strip())
    except ValueError:
        return False
    return verify(pub, msg, sig)
