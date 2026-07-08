#!/usr/bin/env python3
"""Generate an Ed25519 release-signing keypair for the Lumen3D updater (L7).

Run ONCE to bootstrap release authenticity. Prints:
  - the PUBLIC key  → paste into  dev_server.py  `_RELEASE_PUBKEY_HEX`
                      and         install.php    `$PINNED_PUBKEY`
  - the PRIVATE seed → store as the GitHub Actions secret `LUMEN_SIGNING_KEY`
                      (Settings → Secrets and variables → Actions). NEVER commit it.

The seed is generated with `secrets.token_bytes` (CSPRNG). Nothing is written to
disk — copy the values from the terminal. Losing the seed only means you must
re-key (generate a new pair and update the two pinned constants); it cannot be
recovered.

    python tools/gen_signing_key.py
"""

import os
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ed25519_pure as ed  # noqa: E402


def main():
    seed = secrets.token_bytes(32)
    pub = ed.publickey(seed)

    # Self-check: a keypair that can't round-trip must never be emitted.
    if not ed.verify(pub, b"lumen3d-keygen-selfcheck", ed.sign(seed, b"lumen3d-keygen-selfcheck")):
        print("ERROR: generated keypair failed self-verification", file=sys.stderr)
        return 1

    print("Lumen3D release signing keypair (Ed25519)\n")
    print("PUBLIC KEY  (pin in dev_server.py `_RELEASE_PUBKEY_HEX` and install.php `$PINNED_PUBKEY`):")
    print(f"  {pub.hex()}\n")
    print("PRIVATE SEED (GitHub secret `LUMEN_SIGNING_KEY` — keep secret, never commit):")
    print(f"  {seed.hex()}\n")
    print("Next steps:")
    print("  1. Paste the PUBLIC key into the pinned constants IN THE REPO SOURCE and COMMIT it")
    print("     (dev_server.py `_RELEASE_PUBKEY_HEX`, install.php `$PINNED_PUBKEY`). It must live")
    print("     in source so it ships in every release — dev_server.py is NOT update-protected,")
    print("     so a key set only on a deployed host would be OVERWRITTEN by the next update.")
    print("  2. Add the SEED as the GitHub Actions secret `LUMEN_SIGNING_KEY`.")
    print("  3. Cut a release — CI attaches a verified SHA256SUMS.sig.")
    print("  NOTE: the FIRST release that introduces the key is authenticated by sha256 only")
    print("  (the running, still-keyless server cannot verify a signature it doesn't yet pin);")
    print("  every subsequent update is signature-verified fail-closed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
