#!/usr/bin/env python3
"""
build_download_bundles.py — Populate each dataset's download/ folder.

For every dataset under DATA_WEB/<type>/<folder>/ this builds the files the
Download Center's file explorer (api/downloads) will expose, in this order:

  1. <folder>_web.zip   — archive of the served/preprocessed dataset (bricks/,
                          metadata.json, thumbnail.webp). The download/ folder is
                          EXCLUDED, so the archive never contains the other
                          download artefacts (or itself). Built FIRST.
  2. <folder>.ims       — the original Imaris file, placed by HARD LINK (no byte
                          duplication; RAW_DATA and DATA_WEB live on the same
                          volume). Falls back to a copy across volumes.
  3. <folder>.ome.tif   — a multi-channel OME-TIFF (uint16, voxel-calibrated in
                          µm, channel names) reconstructed from the .ims internal
                          resolution pyramid at ~TARGET_PX on the long XY side.
  4. <folder>_C{n}_<name>_MIP.png — per-channel maximum-intensity projection.
  5. README.txt         — provenance, dimensions, voxel size, channels, citation.

The .ims is read straight from the Imaris HDF5 pyramid (ResolutionLevel L), so
only the chosen (small) level is touched — never the full-resolution level 0.

Idempotent: existing artefacts are skipped unless --force. Each dataset is
isolated in try/except so one failure never aborts the batch.

Usage:
  py tools/build_download_bundles.py                 # all datasets, all artefacts
  py tools/build_download_bundles.py --datasets E8-1 # substring filter
  py tools/build_download_bundles.py --dry-run
  py tools/build_download_bundles.py --no-ims --no-archive   # only TIFF + MIP
  py tools/build_download_bundles.py --tiff-px 1024 --force
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np

# ── Paths / config ──────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent          # WebPlatform root
DATA_WEB = ROOT / "DATA_WEB"
# Where the original .ims files live (done/ + todo/ are scanned recursively).
RAW_DATA_DIRS = [
    Path(r"C:\Users\Administrator\Desktop\Fixed images for database\RAW_DATA"),
]
DATASET_TYPES = ("fixed", "live", "tracking")

TARGET_PX = 2048               # desired long XY side of the generated OME-TIFF
# Hard ceiling on the in-flight volume (C·Z·Y·X·2 bytes); if the level closest to
# TARGET_PX exceeds this, step down the pyramid so we never blow up disk/RAM.
MAX_TIFF_BYTES = 6 * 1024**3

# False-colour fallbacks (mirror run_preprocess.THUMB_COLORS) when a channel has
# no display colour in metadata.json.
THUMB_COLORS = [
    (0, 255, 102), (255, 61, 255), (47, 107, 255), (255, 48, 48),
    (255, 255, 0), (255, 0, 255), (0, 255, 255),
]


# ── Imaris attribute decoding (mirrors preprocess/1-ims_metadata.attr_str) ──
def attr_str(group, key, default=""):
    if group is None:
        return default
    v = group.attrs.get(key, default)
    if isinstance(v, (bytes, np.bytes_)):
        return v.decode("utf-8", errors="replace").strip()
    if isinstance(v, np.ndarray):
        try:
            return b"".join(
                bytes(c) if isinstance(c, (bytes, np.bytes_)) else c.tobytes()
                for c in v
            ).decode("utf-8", errors="replace").strip()
        except Exception:
            return "".join(
                c.decode("utf-8", errors="replace") if isinstance(c, (bytes, np.bytes_)) else str(c)
                for c in v
            ).strip()
    return str(v).strip()


def attr_float(group, key, default=0.0):
    try:
        return float(attr_str(group, key, str(default)))
    except (TypeError, ValueError):
        return default


def hex_to_rgb(value, fallback):
    m = re.match(r"^#?([0-9a-fA-F]{6})$", str(value or "").strip())
    if not m:
        return fallback
    h = m.group(1)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


# ── Dataset discovery ───────────────────────────────────────────────────────
def _read_meta_json(d):
    """Per-dataset metadata.json — the authoritative source for channels/voxels.
    utf-8-sig tolerates a stray BOM (hand-edited files) without breaking the parse."""
    p = d / "metadata.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8-sig"))
        except Exception:
            return {}
    return {}


def load_datasets(filter_substr=None, types=DATASET_TYPES):
    """Return [{id, type, folder, dir, meta}], driven by catalog.json when present.
    metadata.json (written by the preprocess pipeline) takes precedence for `meta`
    so this works even when run right after a dataset is built, before catalog.json
    has aggregated it."""
    out, seen = [], set()
    catalog = DATA_WEB / "catalog.json"
    entries = []
    if catalog.exists():
        try:
            entries = json.loads(catalog.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[warn] catalog.json unreadable ({exc}); falling back to dir scan")
    for e in entries:
        path = e.get("path") or e.get("id") or ""
        parts = path.split("/", 1)
        if len(parts) != 2:
            continue
        typ, folder = parts
        d = DATA_WEB / typ / folder
        if typ in types and d.is_dir():
            out.append({"id": path, "type": typ, "folder": folder, "dir": d,
                        "meta": _read_meta_json(d) or e})
            seen.add(path)
    # dir-scan fallback for anything not in the catalog
    for typ in types:
        base = DATA_WEB / typ
        if not base.is_dir():
            continue
        for d in sorted(base.iterdir()):
            pid = f"{typ}/{d.name}"
            if d.is_dir() and pid not in seen:
                out.append({"id": pid, "type": typ, "folder": d.name, "dir": d,
                            "meta": _read_meta_json(d)})
    if filter_substr:
        out = [o for o in out if filter_substr.lower() in o["folder"].lower()]
    return out


def find_ims(folder):
    """Locate <folder>.ims in any configured RAW_DATA dir (recursive)."""
    for base in RAW_DATA_DIRS:
        if not base.is_dir():
            continue
        exact = list(base.rglob(f"{folder}.ims"))
        if exact:
            return exact[0]
    return None


# ── Step 1 — archive of the preprocessed dataset (download/ excluded) ───────
def build_archive(ds_dir, folder, out_path, force, dry):
    if out_path.exists() and not force:
        return "skip (exists)"
    # Collect the servable files first; the download/ folder is excluded so the
    # archive never contains the other artefacts (or itself).
    files = [p for p in sorted(ds_dir.rglob("*"))
             if p.is_file() and p.relative_to(ds_dir).parts[:1] != ("download",)]
    if not files:
        return "skip (no web data yet)"        # un-preprocessed dataset → no empty zip
    if dry:
        return f"would build ({len(files)} files)"
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for path in files:
            zf.write(path, arcname=str(Path(folder) / path.relative_to(ds_dir)))
    os.replace(tmp, out_path)
    return f"{len(files)} files, {fmt_size(out_path.stat().st_size)}"


# ── Step 2 — original .ims via hard link (copy fallback) ────────────────────
def place_ims(ims_src, out_path, force, dry):
    if out_path.exists() and not force:
        return "skip (exists)"
    if dry:
        return f"would link {fmt_size(ims_src.stat().st_size)}"
    if out_path.exists():
        out_path.unlink()
    try:
        os.link(ims_src, out_path)                      # hard link, 0 extra bytes
        return f"hardlink {fmt_size(out_path.stat().st_size)}"
    except OSError:
        shutil.copy2(ims_src, out_path)                 # cross-volume fallback
        return f"copy {fmt_size(out_path.stat().st_size)}"


# ── Step 3/4 — OME-TIFF (+ per-channel MIP) from the .ims pyramid ───────────
def list_levels(f):
    """[(L, Xr, Yr, Zr)] from the Imaris ResolutionLevel groups (real sizes)."""
    dataset = f["DataSet"]
    out = []
    for key in dataset.keys():
        if not key.startswith("ResolutionLevel"):
            continue
        L = int(key.split()[-1])
        tp = dataset[key].get("TimePoint 0")
        if tp is None:
            continue
        ch0 = tp.get("Channel 0")
        if ch0 is None:
            continue
        xr = int(attr_str(ch0, "ImageSizeX", "0") or 0)
        yr = int(attr_str(ch0, "ImageSizeY", "0") or 0)
        zr = int(attr_str(ch0, "ImageSizeZ", "0") or 0)
        if not (xr and yr and zr):
            data = ch0.get("Data")
            if data is None:
                continue
            zr, yr, xr = (zr or data.shape[0], yr or data.shape[1], xr or data.shape[2])
        out.append((L, xr, yr, zr))
    return sorted(out, key=lambda lv: lv[0])


def ims_channel_names(f, n_ch):
    """Channel display names from DataSetInfo/Channel {i}; '' when missing or a
    generic 'Channel N' placeholder, so the caller can fall back cleanly."""
    info = f.get("DataSetInfo", {})
    names = []
    for i in range(n_ch):
        ch = info.get(f"Channel {i}") if hasattr(info, "get") else None
        nm = re.sub(r"\x00.*", "", attr_str(ch, "Name", "")).strip() if ch is not None else ""
        if re.match(r"^ch(annel)?\s*\d+$", nm, re.IGNORECASE):
            nm = ""
        names.append(nm)
    return names


def choose_level(levels, n_ch, target_px, max_bytes):
    """Level whose long XY side is closest to target_px, stepping smaller if the
    in-flight volume would exceed max_bytes."""
    chosen = min(levels, key=lambda lv: abs(max(lv[1], lv[2]) - target_px))
    while chosen[1] * chosen[2] * chosen[3] * n_ch * 2 > max_bytes:
        smaller = [lv for lv in levels if lv[0] > chosen[0]]
        if not smaller:
            break
        chosen = min(smaller, key=lambda lv: lv[0])
    return chosen


def build_tiff_and_mips(ims_src, ds_dir, folder, channels_meta, tiff_path,
                        mip_paths_for, want_tiff, want_mip, force, dry):
    """Returns a status string. Reads ONE pyramid level (≈TARGET_PX), streams it
    into a disk-backed memmap in the system temp dir (low RAM, never litters
    download/), writes a calibrated OME-TIFF, and emits per-channel MIP PNGs."""
    import h5py

    tiff_done = tiff_path.exists() and not force
    if dry:
        return "would build tiff+mips"

    with h5py.File(str(ims_src), "r") as f:
        info = f.get("DataSetInfo", {}).get("Image", None)
        levels = list_levels(f)
        if not levels:
            return "no resolution levels"
        tp0 = f["DataSet"]["ResolutionLevel 0"]["TimePoint 0"]
        ch_keys = sorted([k for k in tp0.keys() if k.startswith("Channel")],
                         key=lambda s: int(s.split()[-1]))
        n_ch = len(ch_keys)

        # Channel names: prefer the curated catalog name, else the .ims name,
        # else a generic placeholder. Colours come from the catalog when present.
        cat = _pad(channels_meta, n_ch)
        ims_names = ims_channel_names(f, n_ch)
        ch_names = [(cat[i].get("name") or ims_names[i] or f"Channel {i+1}") for i in range(n_ch)]

        L, Xr, Yr, Zr = choose_level(levels, n_ch, TARGET_PX, MAX_TIFF_BYTES)

        # Physical extent is level-independent → voxel size = extent / level dims.
        ext = lambda lo, hi: (attr_float(info, hi, 1.0) - attr_float(info, lo, 0.0))
        vox = (
            ext("ExtMin0", "ExtMax0") / max(Xr, 1),
            ext("ExtMin1", "ExtMax1") / max(Yr, 1),
            ext("ExtMin2", "ExtMax2") / max(Zr, 1),
        )

        base = f["DataSet"][f"ResolutionLevel {L}"]["TimePoint 0"]
        tmp_dir = Path(tempfile.mkdtemp(prefix="lumen_bundle_"))
        memmap_path = tmp_dir / f"{folder}.vol.dat"
        arr = np.memmap(memmap_path, dtype=np.uint16, mode="w+", shape=(n_ch, Zr, Yr, Xr))
        mips = []
        try:
            for ci, ck in enumerate(ch_keys):
                data = base[ck]["Data"]
                for z in range(Zr):                     # plane-by-plane → low RAM
                    arr[ci, z] = data[z, :Yr, :Xr]
                mips.append(np.asarray(arr[ci]).max(axis=0))  # uint16 (Yr,Xr)
            arr.flush()

            status = []
            if want_tiff and not tiff_done:
                import tifffile
                tmp_tif = tiff_path.with_suffix(".tif.tmp")
                tifffile.imwrite(
                    str(tmp_tif), np.asarray(arr), bigtiff=True, ome=True,
                    photometric="minisblack", compression="zlib",
                    metadata={
                        "axes": "CZYX",
                        "PhysicalSizeX": vox[0], "PhysicalSizeXUnit": "µm",
                        "PhysicalSizeY": vox[1], "PhysicalSizeYUnit": "µm",
                        "PhysicalSizeZ": vox[2], "PhysicalSizeZUnit": "µm",
                        "Channel": {"Name": ch_names},
                    },
                )
                os.replace(tmp_tif, tiff_path)
                status.append(f"tiff L{L} {Xr}x{Yr}x{Zr} {fmt_size(tiff_path.stat().st_size)}")
            elif want_tiff:
                status.append("tiff skip (exists)")

            if want_mip:
                from PIL import Image
                made = 0
                for ci, mip in enumerate(mips):
                    out = mip_paths_for(ci, ch_names[ci])
                    if out.exists() and not force:
                        continue
                    rgb = hex_to_rgb(cat[ci].get("color"), THUMB_COLORS[ci % len(THUMB_COLORS)])
                    norm = _autoscale(mip)              # 0..1 float
                    img = np.zeros((mip.shape[0], mip.shape[1], 3), dtype=np.uint8)
                    for k in range(3):
                        img[:, :, k] = np.clip(norm * rgb[k], 0, 255).astype(np.uint8)
                    Image.fromarray(img, "RGB").save(str(out))
                    made += 1
                status.append(f"{made} MIP png")
            return "; ".join(status) or "nothing to do"
        finally:
            del arr
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _pad(channels_meta, n):
    cm = list(channels_meta or [])
    while len(cm) < n:
        cm.append({})
    return cm


def _autoscale(plane):
    """Robust 0..1 normalisation (1st–99.9th percentile) for a uint16 MIP."""
    p = plane.astype(np.float32)
    lo = float(np.percentile(p, 1.0))
    hi = float(np.percentile(p, 99.9))
    if hi <= lo:
        hi = float(p.max()) or 1.0
        lo = 0.0
    return np.clip((p - lo) / (hi - lo), 0.0, 1.0)


# ── Step 5 — README ─────────────────────────────────────────────────────────
def write_readme(out_path, ds, ims_src, force, dry):
    if out_path.exists() and not force:
        return "skip (exists)"
    if dry:
        return "would write"
    meta = ds["meta"]
    dims = meta.get("dimensions", {})
    vox = meta.get("voxel_size", {})
    chans = meta.get("channels", [])
    lines = [
        f"Dataset : {ds['folder']}",
        f"Type    : {ds['type']}",
        f"Stage   : {meta.get('stage', '?')}    Embryo: {meta.get('embryo', '?')}",
        "",
        "Dimensions (voxels) : "
        f"X={dims.get('x','?')}  Y={dims.get('y','?')}  Z={dims.get('z','?')}  "
        f"C={dims.get('c','?')}  T={dims.get('t','?')}",
        "Voxel size (µm)     : "
        f"X={vox.get('x','?')}  Y={vox.get('y','?')}  Z={vox.get('z','?')}",
        "",
        "Channels:",
    ]
    for i, c in enumerate(chans):
        lines.append(f"  C{i+1}: {c.get('name','?')}  color={c.get('color','?')}  "
                     f"gamma={c.get('gamma','?')}")
    lines += [
        "",
        "Files in this folder:",
        f"  {ds['folder']}_web.zip   archive of the web/preprocessed dataset "
        "(bricks + metadata + thumbnail)",
        f"  {ds['folder']}.ims       original Imaris acquisition"
        + (f"  ({fmt_size(ims_src.stat().st_size)})" if ims_src and ims_src.exists() else " (not available)"),
        f"  {ds['folder']}.ome.tif   multi-channel OME-TIFF (µm-calibrated, ~{TARGET_PX}px), "
        "from the .ims pyramid",
        f"  {ds['folder']}_C*_*_MIP.png   per-channel maximum-intensity projection",
        "",
        "Citation: cite the IRIBHM Microscopy Platform (Lumen3D, IRIBHM @ ULB) and "
        "the original experiment/publication when available.",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return "ok"


# ── helpers ─────────────────────────────────────────────────────────────────
def fmt_size(n):
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024


# ── main ────────────────────────────────────────────────────────────────────
def process(ds, args):
    folder = ds["folder"]
    dl = ds["dir"] / "download"
    print(f"\n=== {ds['id']} ===")
    if not args.dry_run:
        dl.mkdir(parents=True, exist_ok=True)

    # 1. archive FIRST (download/ is excluded regardless of order)
    if not args.no_archive:
        try:
            print(f"  [archive] {build_archive(ds['dir'], folder, dl / f'{folder}_web.zip', args.force, args.dry_run)}")
        except Exception as exc:
            print(f"  [archive] FAILED: {exc}")

    ims_src = find_ims(folder)
    if ims_src is None and not (args.no_ims and args.no_tiff):
        print(f"  [.ims] not found in RAW_DATA for '{folder}' — skipping ims/tiff/mip")

    # 2. original .ims (hard link)
    if not args.no_ims and ims_src is not None:
        try:
            print(f"  [.ims] {place_ims(ims_src, dl / f'{folder}.ims', args.force, args.dry_run)}")
        except Exception as exc:
            print(f"  [.ims] FAILED: {exc}")

    # 3/4. OME-TIFF + per-channel MIP
    if (not args.no_tiff or not args.no_mip) and ims_src is not None:
        channels_meta = ds["meta"].get("channels", [])
        def mip_path(ci, name):
            safe = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name)).strip("_") or f"C{ci+1}"
            return dl / f"{folder}_C{ci+1}_{safe}_MIP.png"
        try:
            print(f"  [tiff/mip] {build_tiff_and_mips(ims_src, ds['dir'], folder, channels_meta, dl / f'{folder}.ome.tif', mip_path, not args.no_tiff, not args.no_mip, args.force, args.dry_run)}")
        except Exception as exc:
            print(f"  [tiff/mip] FAILED: {exc}")

    # 5. README
    try:
        print(f"  [readme] {write_readme(dl / 'README.txt', ds, ims_src, args.force, args.dry_run)}")
    except Exception as exc:
        print(f"  [readme] FAILED: {exc}")


def main():
    global TARGET_PX, DATA_WEB, RAW_DATA_DIRS
    ap = argparse.ArgumentParser(description="Populate each dataset's download/ folder.")
    ap.add_argument("--datasets", help="case-insensitive substring filter on folder name")
    ap.add_argument("--types", default=",".join(DATASET_TYPES), help="comma list: fixed,live,tracking")
    ap.add_argument("--data-web", help="override the DATA_WEB directory (default: <repo>/DATA_WEB)")
    ap.add_argument("--raw-dir", help="directory to search first for the source .ims (prepended to RAW_DATA_DIRS)")
    ap.add_argument("--tiff-px", type=int, default=TARGET_PX, help="target long XY side of the OME-TIFF")
    ap.add_argument("--no-archive", action="store_true")
    ap.add_argument("--no-ims", action="store_true")
    ap.add_argument("--no-tiff", action="store_true")
    ap.add_argument("--no-mip", action="store_true")
    ap.add_argument("--force", action="store_true", help="rebuild artefacts that already exist")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    TARGET_PX = args.tiff_px
    if args.data_web:
        DATA_WEB = Path(args.data_web)
    if args.raw_dir:
        RAW_DATA_DIRS = [Path(args.raw_dir)] + RAW_DATA_DIRS
    types = tuple(t.strip() for t in args.types.split(",") if t.strip())

    datasets = load_datasets(args.datasets, types)
    if not datasets:
        print("No datasets matched.")
        return 1
    print(f"{len(datasets)} dataset(s) to process "
          f"(archive={not args.no_archive} ims={not args.no_ims} "
          f"tiff={not args.no_tiff} mip={not args.no_mip} target={TARGET_PX}px "
          f"dry_run={args.dry_run})")
    t0 = time.time()
    for ds in datasets:
        try:
            process(ds, args)
        except Exception as exc:
            print(f"  [dataset] FAILED: {exc}")
    print(f"\nDone in {time.time() - t0:.0f}s.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
