#!/usr/bin/env python3
"""
2D importer — one colour photograph → one `2d` dataset.

Input : 2D TIFFs as exported by ImageJ/Fiji from a Leica .lif (a composite of
        three 8-bit planes with Red/Green/Blue LUTs), plain RGB TIFFs, or single
        greyscale TIFFs. No Z, no T: a 2D dataset is a picture, not a volume.
Output: DATA_WEB/2d/<dataset>/
          image.webp      native resolution, what the viewer shows once loaded
          preview.webp    long side 640 px, painted first so the page never waits
          thumbnail.webp  512² padded square, the explorer/catalog convention
          metadata.json   type "2d" — stage, pixel size, acquisition
          download/       (--with-downloads) the original TIFF + README.txt

Everything measurable is read from the file, never guessed: the pixel size comes
from the TIFF resolution tags (ImageJ writes them in microns) and the acquisition
fields from the Leica block ImageJ embeds. What the file cannot tell — the
reporter line, the staining — is taken from the command line and preserved on
re-import so lab curation is never overwritten (see `merge_curated`).

    python 2d_importer.py --input <dir|file.tif> --output DATA_WEB \
        [--line DLL4xCD1] [--staining X-gal] [--only "*E8.0*"] [--with-downloads] [--force]
"""
import argparse
import fnmatch
import json
import os
import re
import shutil
import struct
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image

__version__ = "0.18.0"

# The directory a dataset sits in IS its type: DATA_WEB/2d/<folder> is dataset '2d/<folder>'.
DATASET_TYPE = "2d"
PREVIEW_LONG_SIDE = 640
THUMB_SIZE = 512
THUMB_BACKGROUND = (8, 10, 18)
NATIVE_QUALITY = 90
PREVIEW_QUALITY = 80

IJ_METADATA_TAG = 50839
IJ_METADATA_COUNTS_TAG = 50838
X_RESOLUTION_TAG = 282
IMAGE_DESCRIPTION_TAG = 270

# Keys the lab edits by hand in the admin panel. A re-import refreshes what the
# file measures and leaves these alone.
CURATED_KEYS = ("name", "description", "stage", "stageNumeric", "embryo", "line",
                "staining", "reporter", "hidden", "gallery", "tags", "notes", "created")


# ── ImageJ metadata ────────────────────────────────────────────────────────────
def read_ij_metadata(im) -> dict:
    """Decode the ImageJ private tag into {'info': [str], 'labl': [str],
    'luts': [bytes], 'rang': [bytes]}. Absent or malformed → {}."""
    blob = im.tag_v2.get(IJ_METADATA_TAG)
    counts = im.tag_v2.get(IJ_METADATA_COUNTS_TAG)
    if not blob or not counts or bytes(blob[:4]) != b"IJIJ":
        return {}
    blob = bytes(blob)
    header_len = counts[0]
    kinds = [(blob[p:p + 4], struct.unpack(">I", blob[p + 4:p + 8])[0])
             for p in range(4, header_len, 8)]
    out, pos, idx = {}, header_len, 1
    for kind, n in kinds:
        items = []
        for _ in range(n):
            if idx >= len(counts):
                return out
            chunk = blob[pos:pos + counts[idx]]
            pos += counts[idx]
            idx += 1
            items.append(chunk.decode("utf-16-be", "replace")
                         if kind in (b"info", b"labl") else chunk)
        out[kind.decode("ascii", "replace")] = items
    return out


def read_planes(im) -> list:
    planes = []
    for i in range(getattr(im, "n_frames", 1)):
        im.seek(i)
        planes.append(np.array(im))
    im.seek(0)
    return planes


def compose_rgb(planes: list, luts: list) -> np.ndarray:
    """Additive composite, exactly what ImageJ's composite mode displays:
    out = Σ lut_c[plane_c]. Plain RGB and greyscale files pass straight through."""
    first = planes[0]
    if first.ndim == 3:
        return np.ascontiguousarray(first[:, :, :3])
    acc = np.zeros(first.shape + (3,), dtype=np.float32)
    for c, plane in enumerate(planes):
        lut = _lut_table(luts, c, len(planes))
        acc += lut[_to_uint8(plane)]
    return np.clip(acc, 0, 255).astype(np.uint8)


def _lut_table(luts: list, index: int, n_planes: int) -> np.ndarray:
    """256×3 colour table for plane `index`. ImageJ stores R,G,B ramps of 256
    bytes each; without LUTs, three planes are taken as R/G/B, one as grey."""
    if index < len(luts) and len(luts[index]) == 768:
        raw = np.frombuffer(luts[index], dtype=np.uint8)
        return raw.reshape(3, 256).T.astype(np.float32)
    ramp = np.arange(256, dtype=np.float32)
    table = np.zeros((256, 3), dtype=np.float32)
    if n_planes == 3:
        table[:, index] = ramp
    else:
        table[:] = ramp[:, None]
    return table


def _to_uint8(plane: np.ndarray) -> np.ndarray:
    if plane.dtype == np.uint8:
        return plane
    hi = float(plane.max()) or 1.0
    return (plane.astype(np.float32) * (255.0 / hi)).astype(np.uint8)


# ── Calibration ────────────────────────────────────────────────────────────────
def pixel_size_um(im, description: str) -> tuple:
    """(µm per pixel, status). ImageJ writes XResolution in pixels per `unit`;
    we only trust it when the unit is declared in microns."""
    xres = im.tag_v2.get(X_RESOLUTION_TAG)
    unit = re.search(r"^unit=(\S+)", description, re.MULTILINE)
    unit = unit.group(1).lower() if unit else ""
    if xres and float(xres) > 0 and unit in ("micron", "microns", "um", "µm", "\\u00b5m"):
        return 1.0 / float(xres), "exact"
    return None, "unknown"


# ── Leica block ────────────────────────────────────────────────────────────────
LEICA_FIELDS = {
    "Zoom": ("zoom", float),
    "Magnification": ("magnification", float),
    "ObjectiveName": ("objective", str),
    "NumericalAperture": ("numericalAperture", float),
    "ExposureTime": ("exposureS", float),
    "IndividualCameraInfo|Gain": ("gain", float),
    "MicroscopeModel": ("microscope", str),
    "FullCameraName": ("camera", str),
}


def leica_fields(info: str, series: str) -> dict:
    """Acquisition settings of one series. The Leica block repeats a key once per
    job block (`LDM_Block_…`) and once at the top level for the exposure that was
    actually taken; the top-level line wins, first block line as fallback."""
    # Every line of a series starts with `<series> Image…`; the trailing "Image"
    # keeps `E8.0 x3.2 240913` from also matching `E8.0 x3.2 240913 2`.
    prefix = series + " Image"
    lines = [l[len(series) + 1:] for l in info.splitlines() if l.startswith(prefix)]
    out = {}
    for suffix, (name, cast) in LEICA_FIELDS.items():
        value = _pick_value(lines, suffix)
        if value is not None:
            out[name] = value if cast is str else _safe_float(value)
    if "exposureS" in out:
        out["exposureMs"] = round(out.pop("exposureS") * 1000.0, 3)
    if out.get("camera"):
        out["camera"] = out["camera"].split("-")[0]
    return {k: v for k, v in out.items() if v not in (None, "", 0.0)}


def _pick_value(lines: list, suffix: str):
    """LAS X writes "0" for a setting that does not apply to a block; those
    placeholders never beat a real value."""
    hits = [(k, v.strip()) for k, _, v in (l.partition(" = ") for l in lines)
            if k.rstrip().endswith(suffix) and v.strip() not in ("", "0")]
    if not hits:
        return None
    top = [v for k, v in hits if "LDM_Block" not in k]
    return (top or [v for _, v in hits])[0]


def _safe_float(text: str):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


# ── File-name conventions ──────────────────────────────────────────────────────
STAGE_RX = re.compile(r"\bE(\d(?:[.,]\d{1,2})?)\b")
ZOOM_RX = re.compile(r"\bx(\d+(?:[.,]\d+)?)\b", re.IGNORECASE)
DATE_RX = re.compile(r"\b(\d{6})\b")
LINE_RX = re.compile(r"\b([A-Za-z0-9]+x[A-Za-z][A-Za-z0-9]*)\b")


def parse_filename(stem: str, line_override: str = None) -> dict:
    """`<lif> - <stage> x<zoom> <dissection yymmdd> [<n> [<m>]]` as the lab names
    its exports. Missing parts stay None; nothing is invented."""
    lif, sep, series = stem.partition(".lif - ")
    if not sep:
        lif, series = "", stem
    stage_m = STAGE_RX.search(series) or STAGE_RX.search(lif)
    zoom_m = ZOOM_RX.search(series)
    dates = [d for d in DATE_RX.findall(series) if _valid_yymmdd(d)]
    tail = series[zoom_m.end():] if zoom_m else ""
    index = " ".join(t for t in tail.split() if t.isdigit() and t not in dates)
    line_m = LINE_RX.search(lif) or LINE_RX.search(series)
    stage = stage_m.group(1).replace(",", ".") if stage_m else None
    return {
        "lif": (lif + ".lif") if lif else None,
        "series": series.strip(),
        "stage": f"E{stage}" if stage else None,
        "stageNumeric": float(stage) if stage else None,
        "zoom": float(zoom_m.group(1).replace(",", ".")) if zoom_m else None,
        "dissectionDate": _iso_date(dates[0]) if dates else None,
        "index": index or None,
        "line": line_override or (line_m.group(1) if line_m else None),
    }


def _valid_yymmdd(text: str) -> bool:
    try:
        datetime.strptime(text, "%y%m%d")
        return True
    except ValueError:
        return False


def _iso_date(yymmdd: str) -> str:
    return datetime.strptime(yymmdd, "%y%m%d").strftime("%Y-%m-%d")


def dataset_folder_name(parsed: dict) -> str:
    """`<line>-<stage>-x<zoom>-<yymmdd>-<index>`, stage without its dot
    (E7.75 → E775) as the platform's other datasets spell it."""
    parts = [parsed.get("line"),
             parsed["stage"].replace(".", "") if parsed.get("stage") else None,
             f"x{parsed['zoom']:g}" if parsed.get("zoom") else None,
             parsed["dissectionDate"].replace("-", "")[2:] if parsed.get("dissectionDate") else None,
             parsed.get("index")]
    if not (parsed.get("zoom") or parsed.get("dissectionDate")):
        parts.append(parsed.get("series"))
    return slugify("-".join(p for p in parts if p)) or "photograph"


def slugify(text: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^A-Za-z0-9._-]+", "-", text)).strip("-.")


# ── Outputs ────────────────────────────────────────────────────────────────────
def write_images(rgb: np.ndarray, out_dir: Path) -> dict:
    native = Image.fromarray(rgb, mode="RGB")
    native.save(out_dir / "image.webp", "WEBP", quality=NATIVE_QUALITY, method=6)

    preview = native.copy()
    preview.thumbnail((PREVIEW_LONG_SIDE, PREVIEW_LONG_SIDE), Image.Resampling.LANCZOS)
    preview.save(out_dir / "preview.webp", "WEBP", quality=PREVIEW_QUALITY, method=6)

    _write_square_thumbnail(native, out_dir / "thumbnail.webp")
    return {"native": "image.webp", "width": native.width, "height": native.height,
            "preview": "preview.webp", "previewWidth": preview.width,
            "previewHeight": preview.height}


def _write_square_thumbnail(img: Image.Image, path: Path) -> None:
    scaled = img.copy()
    scaled.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (THUMB_SIZE, THUMB_SIZE), THUMB_BACKGROUND)
    canvas.paste(scaled, ((THUMB_SIZE - scaled.width) // 2, (THUMB_SIZE - scaled.height) // 2))
    canvas.save(path, "WEBP", quality=88, method=6)


def build_metadata(folder: str, parsed: dict, image: dict, px_um, cal_status: str,
                   acquisition: dict, source: Path, staining: str) -> dict:
    now = datetime.now().isoformat()
    w, h = image["width"], image["height"]
    physical = ({"x": round(w * px_um, 3), "y": round(h * px_um, 3)} if px_um else None)
    stage_txt = parsed["stage"] or "Unknown"
    return {
        "id": f"{DATASET_TYPE}/{folder}", "name": folder, "type": DATASET_TYPE,
        "stage": stage_txt, "stageNumeric": parsed["stageNumeric"] or 0.0,
        "embryo": None, "line": parsed.get("line"), "staining": staining or "",
        "date": parsed.get("dissectionDate"),
        "dimensions": {"x": w, "y": h, "z": 1, "c": 3, "t": 1},
        "pixelSizeUm": ({"x": round(px_um, 6), "y": round(px_um, 6)} if px_um else None),
        "physicalSizeUm": physical,
        "calibrationStatus": cal_status,
        "calibrationNote": ("Pixel size read from the ImageJ resolution tags (microns)."
                            if cal_status == "exact" else
                            "No calibrated resolution in the file — scale bar and measurements unavailable."),
        "image": image,
        "acquisition": {"modality": "brightfield-stereo", "sourceFile": source.name,
                        "lifFile": parsed.get("lif"), "series": parsed.get("series"),
                        "dissectionDate": parsed.get("dissectionDate"),
                        "zoomNominal": parsed.get("zoom"), **acquisition},
        "channels": [],
        "description": _description(stage_txt, parsed, acquisition),
        "created": now, "lastModified": now, "configured": True,
        "folderName": folder,
        "thumbnail": f"DATA_WEB/{DATASET_TYPE}/{folder}/thumbnail.webp",
        "hidden": False,
    }


def _description(stage: str, parsed: dict, acq: dict) -> str:
    bits = [f"Colour photograph, {stage} embryo"]
    if parsed.get("line"):
        bits.append(parsed["line"])
    if acq.get("microscope"):
        bits.append(f"{acq['microscope']} stereomicroscope")
    if parsed.get("zoom"):
        bits.append(f"zoom x{parsed['zoom']:g}")
    return ", ".join(bits) + "."


def merge_curated(existing: dict, fresh: dict) -> dict:
    """Re-import refreshes measurements, keeps what the lab edited."""
    merged = dict(fresh)
    for key in CURATED_KEYS:
        if key in existing:
            merged[key] = existing[key]
    merged["lastModified"] = fresh["lastModified"]
    return merged


def write_download(source: Path, out_dir: Path, meta: dict) -> None:
    dl = out_dir / "download"
    dl.mkdir(exist_ok=True)
    target = dl / source.name
    if target.exists():
        target.unlink()
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
    (dl / "README.txt").write_text(_readme(source, meta), encoding="utf-8")


def _readme(source: Path, meta: dict) -> str:
    acq = meta["acquisition"]
    px = meta.get("pixelSizeUm")
    lines = [
        f"{meta['name']}",
        "=" * len(meta["name"]),
        "",
        f"Type        : 2D photograph ({acq.get('modality')})",
        f"Stage       : {meta['stage']}",
        f"Line        : {meta.get('line') or '-'}",
        f"Staining    : {meta.get('staining') or '-'}",
        f"Image       : {meta['dimensions']['x']} x {meta['dimensions']['y']} px, RGB 8-bit",
        f"Pixel size  : {px['x']:.4f} um/px" if px else "Pixel size  : unknown",
        f"Source      : {source.name}",
        f"LIF file    : {acq.get('lifFile') or '-'}  (series {acq.get('series') or '-'})",
        f"Microscope  : {acq.get('microscope') or '-'}  camera {acq.get('camera') or '-'}",
        f"Zoom        : {acq.get('zoom') or acq.get('zoomNominal') or '-'}",
        f"Exposure    : {acq.get('exposureMs') or '-'} ms, gain {acq.get('gain') or '-'}",
        f"Dissection  : {acq.get('dissectionDate') or '-'}",
        "",
        "The TIFF is the untouched ImageJ export; image.webp beside it is the",
        "display copy used by the viewer (lossy, quality 90).",
    ]
    return "\n".join(lines) + "\n"


# ── Orchestration ──────────────────────────────────────────────────────────────
def import_tiff(source: Path, output_root: Path, args) -> Path:
    with Image.open(source) as im:
        ij = read_ij_metadata(im)
        description = str(im.tag_v2.get(IMAGE_DESCRIPTION_TAG, ""))
        px_um, cal_status = pixel_size_um(im, description)
        rgb = compose_rgb(read_planes(im), ij.get("luts", []))

    parsed = parse_filename(source.stem, args.line)
    folder = dataset_folder_name(parsed)
    out_dir = output_root / DATASET_TYPE / folder
    meta_path = out_dir / "metadata.json"
    if meta_path.exists() and not args.force:
        print(f"  [skip] {folder} exists (use --force to re-import)")
        return out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    image = write_images(rgb, out_dir)
    info = (ij.get("info") or [""])[0]
    series = _series_name(ij, parsed)
    acquisition = leica_fields(info, series) if series else {}
    fresh = build_metadata(folder, parsed, image, px_um, cal_status, acquisition, source, args.staining)
    meta = merge_curated(_load_json(meta_path), fresh) if meta_path.exists() else fresh
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    if args.with_downloads:
        write_download(source, out_dir, meta)

    px_txt = f"{px_um:.3f} um/px" if px_um else "uncalibrated"
    print(f"  [ok] {folder}  {image['width']}x{image['height']}  {meta['stage']}  {px_txt}")
    return out_dir


def _series_name(ij: dict, parsed: dict) -> str:
    """ImageJ labels each plane `c:1/3 - <series>`; the Leica block is keyed by
    that series name, which is also the one the lab may have renamed in LAS X."""
    labels = ij.get("labl") or []
    if labels and " - " in labels[0]:
        return labels[0].split(" - ", 1)[1].strip()
    return parsed.get("series") or ""


def _load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def collect_inputs(input_path: Path, only: str) -> list:
    if input_path.is_file():
        files = [input_path]
    else:
        files = sorted(p for p in input_path.iterdir()
                       if p.suffix.lower() in (".tif", ".tiff") and p.is_file())
    if only:
        files = [f for f in files if fnmatch.fnmatch(f.name, only)]
    return files


def main() -> int:
    ap = argparse.ArgumentParser(description="2D photograph importer (one TIFF → one dataset)")
    ap.add_argument("--input", required=True, help="Directory of TIFFs, or one TIFF.")
    ap.add_argument("--output", required=True, help="DATA_WEB directory of the web platform.")
    ap.add_argument("--only", default=None, help="Glob on the file name (e.g. '*E8.0*').")
    ap.add_argument("--line", default=None, help="Reporter/strain line label (default: parsed from the .lif name).")
    ap.add_argument("--staining", default="", help="Staining label stored in metadata (e.g. X-gal).")
    ap.add_argument("--with-downloads", action="store_true", help="Place the original TIFF + README under download/.")
    ap.add_argument("--force", action="store_true", help="Re-import over an existing dataset (curation is preserved).")
    args = ap.parse_args()

    files = collect_inputs(Path(args.input), args.only)
    if not files:
        print("[2d] no TIFF matched.")
        return 1
    print(f"[2d] importer v{__version__} - {len(files)} file(s) -> {Path(args.output) / DATASET_TYPE}")
    failures = 0
    for source in files:
        try:
            import_tiff(source, Path(args.output), args)
        except Exception as exc:  # one bad export must not stop the batch
            failures += 1
            print(f"  [fail] {source.name}: {exc}")
    print(f"[2d] done - {len(files) - failures} imported, {failures} failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
