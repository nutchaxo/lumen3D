#!/usr/bin/env python3
"""Build a signed release artifact for ONE first-party marketplace plugin.

Twin of tools/build_release.py, but the allowlist is a single plugin folder. Emits,
into --out:
  plugin-<id>-<version>.zip   deterministic zip of the plugin folder (plugin.json at
                              the zip root; sorted entries, fixed 1980 timestamp, 0644)
  version.json                {id, placement, version, files:{relpath:sha256}}
  SHA256SUMS                  coreutils-style line for the zip
  SHA256SUMS.sig             detached Ed25519 signature over SHA256SUMS (hex), when a
                              signing seed is provided (--sign-seed-hex or LUMEN_SIGNING_KEY)
  catalog-entry.json          a ready-to-paste marketplace catalog entry (fill in the URLs)

The platform's marketplace verifies SHA256SUMS.sig against the PINNED marketplace key
(dev_server.py:_MARKETPLACE_PUBKEY_HEX / _admin_lib.php:MARKETPLACE_PUBKEY) fail-closed,
then the zip's sha256 from those authenticated bytes — the SAME chain as the core updater.

Usage:
  python tools/build_plugin_release.py js/modules/tools/screenshot --out dist/plugins
  LUMEN_SIGNING_KEY=<64-hex-seed> python tools/build_plugin_release.py <dir> --out <out>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    import ed25519_pure as _ed25519
except Exception:
    _ed25519 = None

# Identity-bearing files only (mirrors the trust hash extension set); skip dotfiles.
_HASH_EXT = {".js", ".json", ".mjs", ".css", ".html"}
_FIXED_DT = (1980, 1, 1, 0, 0, 0)


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _iter_files(plugin_dir: Path):
    for p in sorted(plugin_dir.rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            yield p


def build(plugin_dir: Path, out_dir: Path, seed_hex: str | None) -> dict:
    plugin_dir = plugin_dir.resolve()
    meta_path = plugin_dir / "plugin.json"
    if not meta_path.is_file():
        raise SystemExit(f"plugin.json introuvable dans {plugin_dir}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    pid = str(meta.get("id") or plugin_dir.name)
    placement = meta.get("placement") or plugin_dir.parent.name
    version = str(meta.get("version") or "0.0.0")
    out_dir.mkdir(parents=True, exist_ok=True)

    zip_name = f"plugin-{pid}-{version}.zip"
    zip_path = out_dir / zip_name

    files = {}   # relpath -> sha256 (identity files, for version.json)
    members = []
    for p in _iter_files(plugin_dir):
        rel = p.relative_to(plugin_dir).as_posix()
        data = p.read_bytes()
        members.append((rel, data))
        if p.suffix.lower() in _HASH_EXT:
            files[rel] = _sha256_bytes(data)

    # Deterministic zip: sorted, fixed timestamp, 0644 — byte-stable across machines.
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel, data in sorted(members):
            zi = zipfile.ZipInfo(rel, date_time=_FIXED_DT)
            zi.external_attr = 0o644 << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(zi, data)

    zip_digest = _sha256_bytes(zip_path.read_bytes())

    (out_dir / "version.json").write_text(
        json.dumps({"id": pid, "placement": placement, "version": version, "files": files},
                   indent=2, ensure_ascii=False), encoding="utf-8")

    # Write SHA256SUMS as raw bytes (LF) so the SIGNED bytes == the PUBLISHED bytes —
    # write_text would translate \n→\r\n on Windows and break signature verification.
    sums_bytes = f"{zip_digest}  {zip_name}\n".encode("utf-8")
    (out_dir / "SHA256SUMS").write_bytes(sums_bytes)

    signed = False
    if seed_hex:
        if _ed25519 is None:
            raise SystemExit("ed25519_pure indisponible — impossible de signer")
        seed = bytes.fromhex(seed_hex.strip())
        sig = _ed25519.sign(seed, sums_bytes)
        (out_dir / "SHA256SUMS.sig").write_text(sig.hex() + "\n", encoding="utf-8", newline="\n")
        signed = True

    (out_dir / "catalog-entry.json").write_text(json.dumps({
        "id": pid, "name": meta.get("name") or pid, "placement": placement,
        "subtype": meta.get("subtype"), "description": meta.get("description") or "",
        "creator": meta.get("creator"), "icon": meta.get("icon"),
        "platformCompat": meta.get("platformCompat"),
        "sandboxCapabilities": meta.get("sandboxCapabilities"),
        "latestVersion": version,
        "assetUrl": f"https://…/{zip_name}",
        "sumsUrl": "https://…/SHA256SUMS",
        "sigUrl": "https://…/SHA256SUMS.sig",
        "sha256": zip_digest,
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    return {"id": pid, "version": version, "zip": zip_name, "sha256": zip_digest, "signed": signed}


def main() -> None:
    ap = argparse.ArgumentParser(description="Build a signed marketplace plugin release.")
    ap.add_argument("plugin_dir", help="path to the plugin folder (contains plugin.json)")
    ap.add_argument("--out", default="dist/plugins", help="output directory")
    ap.add_argument("--sign-seed-hex", default=os.environ.get("LUMEN_SIGNING_KEY", ""),
                    help="Ed25519 private seed (64 hex chars); or set LUMEN_SIGNING_KEY")
    args = ap.parse_args()
    info = build(Path(args.plugin_dir), Path(args.out), args.sign_seed_hex or None)
    print(json.dumps(info, indent=2, ensure_ascii=False))
    if not info["signed"]:
        print("⚠  non signé (aucun seed) — intégrité sha256 seule. "
              "Fournir --sign-seed-hex ou LUMEN_SIGNING_KEY pour signer.", file=sys.stderr)


if __name__ == "__main__":
    main()
