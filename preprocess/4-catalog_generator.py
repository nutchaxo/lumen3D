#!/usr/bin/env python3
import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from run_preprocess import merge_curated, atomic_write_json, read_json_file  # noqa: E402

COLORS = ["#00FF00", "#00AAFF", "#FF00FF", "#FF0000", "#FFFF00", "#00FFFF"]

# Embryonic-day token of the lab's file names, after a separator (or at the start):
#   E8-5, E10-5        day, dash, fraction digits      -> E8.5, E10.5
#   E10.5, E8,25       day, dot/comma, fraction digits -> E10.5, E8.25
#   E85, E825, E105    compact digits                  -> E8.5, E8.25, E10.5
#   E8, E10            a whole day                     -> E8, E10
# Mouse development runs to E19, so a compact token starting with 10-19 is a two-digit
# day (E105 = E10.5, E12 = E12); any other is a one-digit day followed by its fraction
# (E95 = E9.5, E80 = E8.0). After a dash only the fractions a stage is actually written
# with (.25, .5, .75) are read as one: in "E8-1-DAPI" or "E95-2-..." the number after the
# stage is the embryo, as the lab's own curation of those datasets records it.
_STAGE_RX = re.compile(r"(?:^|[-_ ])E(\d{1,3})(?:([.,])(\d{1,2})|-(25|5|75))?(?=$|[-_ ])",
                       re.IGNORECASE)
_EMBRYO_RX = re.compile(r"(?:^|[-_ ])(Em\d+)(?=$|[-_ ])", re.IGNORECASE)
_STAGE_EMBRYO_NUMBER_RX = re.compile(r"(?:^|[-_ ])E[\d.,]+-(\d{1,2})(?=$|[-_ ])", re.IGNORECASE)


def _split_compact(digits: str):
    if len(digits) == 1:
        return digits, ""
    if digits[0] == "1" and len(digits) >= 2:
        return digits[:2], digits[2:]
    return digits[0], digits[1:]


def _parse_stage(name: str):
    """(display, numeric) of the embryonic day encoded in a dataset name, or
    ("Unknown", 0.0) when the name carries none."""
    m = _STAGE_RX.search(name)
    if not m:
        return "Unknown", 0.0
    digits, sep, sep_frac, dash_frac = m.groups()
    if sep:
        day, frac = digits, sep_frac
    elif dash_frac:
        day, frac = digits, dash_frac
    else:
        day, frac = _split_compact(digits)
    day = str(int(day))
    display = f"E{day}.{frac}" if frac else f"E{day}"
    return display, float(f"{day}.{frac}") if frac else float(day)


def _parse_embryo(name: str):
    """Embryo label: an explicit `Em<n>` token anywhere in the name, else the number
    that directly follows the stage (`E95-1-...` is embryo 1)."""
    m = _EMBRYO_RX.search(name)
    if m:
        return m.group(1)
    stage = _STAGE_RX.search(name)
    if stage and not stage.group(4):
        n = _STAGE_EMBRYO_NUMBER_RX.search(name, stage.start())
        if n and n.start() == stage.start():
            return f"Em{int(n.group(1))}"
    return None


def _calibrated(vs) -> bool:
    return isinstance(vs, dict) and all(isinstance(vs.get(a), (int, float)) and vs.get(a) > 0
                                        for a in ("x", "y", "z"))


def merge_channels(existing, fresh):
    """Display settings the lab chose per channel (colour, window, gamma, name) survive a
    re-run as long as the acquisition still has the same number of channels; a changed
    channel set starts from the defaults, since the old settings belong to other data."""
    if not isinstance(existing, list) or len(existing) != len(fresh):
        return fresh
    merged = []
    for old, new in zip(existing, fresh):
        merged.append({**new, **old} if isinstance(old, dict) else new)
    return merged


CALIBRATION_KEYS = ("voxel_size", "physicalSizeUm", "optical_section_thickness_um",
                    "calibrationStatus", "calibrationNote")


def merge_volume_metadata(existing: dict, fresh: dict) -> dict:
    """metadata.json of a re-processed volume: measured facts from this run, the lab's
    curation from the published file (see run_preprocess.CURATED_KEYS)."""
    merged = merge_curated(existing, fresh)
    if not existing:
        return merged
    merged["channels"] = merge_channels(existing.get("channels"), fresh.get("channels") or [])
    # A file without calibration cannot measure it: a calibration the operator entered by
    # hand is kept rather than replaced by "missing". The 1/N um "voxel" earlier versions
    # derived from a missing extent (and labelled exact) is not one.
    vs = existing.get("voxel_size")
    dims = fresh.get("dimensions") or {}
    placeholder = _calibrated(vs) and all(
        dims.get(a) and abs(vs[a] - round(1.0 / dims[a], 6)) < 1e-12 for a in ("x", "y", "z"))
    if (fresh.get("calibrationStatus") == "metadata-missing" and _calibrated(vs)
            and not placeholder):
        for key in CALIBRATION_KEYS:
            if key in existing:
                merged[key] = existing[key]
    return merged


def generate_catalog_metadata(temp_dir: Path, output_dir: Path, existing_path: Path = None,
                              display_name: str = None):
    with open(temp_dir / "processing_meta.json", "r", encoding="utf-8") as fm:
        proc_meta = json.load(fm)

    lod_levels = proc_meta["lod_levels"]
    n_ch = proc_meta["n_channels"]
    n_tp = proc_meta["n_timepoints"]
    voxel_size = proc_meta["voxel_size"]
    channel_names = proc_meta["channel_names"]
    W = proc_meta["width"]
    H = proc_meta["height"]
    D = proc_meta["depth"]

    # The folder is the dataset's id; the name shown defaults to the source file's own
    # name, which the folder may have had to sanitise.
    dataset_name = output_dir.name
    shown_name = display_name or dataset_name
    stage, stage_num = _parse_stage(shown_name)
    embryo = _parse_embryo(shown_name)

    # The directory a dataset sits in IS its type ('3d', 'live'), so the type, the id
    # and the byte path all derive from the same string.
    dataset_type = output_dir.parent.name
    rel_path_str = f"DATA_WEB/{dataset_type}/{dataset_name}"

    # Histograms are written by step 3 with the manifest. A manifest produced by an
    # older step 3 still has an empty list; it is completed here.
    manifest_path = output_dir / "bricks" / "manifest.json"
    manifest = read_json_file(manifest_path)
    if manifest and not manifest.get("histograms"):
        _inject_histograms(temp_dir, manifest_path, manifest, lod_levels, n_ch, n_tp)
    elif not manifest:
        print(f"[WARNING] manifest.json not found to update histograms.")

    # Calibration. voxel = extent / N (step 1); without an extent the calibration is
    # undeclared and every derived size is 0 rather than a guess.
    vx = voxel_size["x"]
    vy = voxel_size["y"]
    vz = voxel_size["z"]
    calibrated = bool(vx and vy and vz)

    extent = proc_meta.get("extent") or {}
    ext_min = extent.get("min") or [0.0, 0.0, 0.0]
    ext_max = extent.get("max") or [W * vx, H * vy, D * vz]

    # The viewer models depth as (D-1) z-steps plus one slice thickness, and without
    # an explicit value it guesses that thickness as min(zStep, voxelX) — which for an
    # anisotropic stack under-reports the depth (here 329.50 um instead of the 333.87 um
    # Imaris states). Declaring the slice thickness equal to the z-step reproduces the
    # microscope's own extent exactly, which is mandatory for anything registered in
    # Imaris coordinates (cell tracks) to land on the right voxels.
    slice_thickness = (ext_max[2] - ext_min[2]) / max(D, 1)
    physical_size = {
        "x": ext_max[0] - ext_min[0],
        "y": ext_max[1] - ext_min[1],
        "z": ext_max[2] - ext_min[2],
        "sliceThickness": slice_thickness,
        "voxelX": vx,
        "voxelY": vy,
        "voxelZ": vz
    }

    interval = proc_meta.get("time_interval_minutes")
    timestamps = proc_meta.get("timestamps") or []

    # Setup default channels info for metadata.json
    channels_info = []
    for i in range(n_ch):
        ch_name = channel_names[i] if i < len(channel_names) else f"Channel {i+1}"
        channels_info.append({
            "name": ch_name,
            "color": COLORS[i % len(COLORS)],
            "min": 0.0,
            "max": 1.0,
            "gamma": 1.0
        })

    now = datetime.now().isoformat()
    metadata = {
        "id": f"{dataset_type}/{dataset_name}",
        "name": shown_name,
        "type": dataset_type,
        "stage": stage,
        "stageNumeric": stage_num,
        "embryo": embryo,
        "dimensions": {
            "x": W,
            "y": H,
            "z": D,
            "c": n_ch,
            "t": n_tp
        },
        "voxel_size": voxel_size,
        "physicalSizeUm": physical_size,
        "optical_section_thickness_um": round(slice_thickness, 6),
        "acquisitionExtentUm": {
            "unit": extent.get("unit", "um"),
            "min": [float(v) for v in ext_min],
            "max": [float(v) for v in ext_max]
        },
        "calibrationStatus": "exact" if calibrated else "metadata-missing",
        "calibrationNote": ("Voxel metadata was successfully extracted." if calibrated else
                            "Calibration metadata missing: the file declares no usable extent."),
        "channels": channels_info,
        "created": now,
        "lastModified": now,
        "configured": True,
        "folderName": dataset_name,
        "description": (
            f"Timelapse confocal acquisition: {stage} embryo, {n_tp} timepoints"
            f"{f' every {interval:g} min' if interval else ''}, {D} slices, {n_ch} channels."
            if n_tp > 1 else
            f"Confocal imaging stack: {stage} fixed embryo, {D} slices, {n_ch} channels."
        ),
        "thumbnail": f"{rel_path_str}/thumbnail.webp" if (output_dir / "thumbnail.webp").exists() else None,
        "volumeSources": [
            {
                "kind": "bricks",
                "label": "Chunked bricks (64³)",
                "priority": -1,
                "available": True,
                "multiscale": True,
                "path": rel_path_str,
                "manifestPath": f"{rel_path_str}/bricks/manifest.json"
            }
        ]
    }

    if n_tp > 1:
        norm = proc_meta.get("normalization") or {}
        metadata["timeline"] = {
            "count": n_tp,
            "intervalMinutes": interval,
            "timestamps": timestamps
        }
        # Photobleaching is reported, never baked in: the voxels stay on one linear
        # window (see 2-image_processor.py) so a frame that looks dimmer really is
        # dimmer. These per-frame signal levels let the viewer offer an OPTIONAL,
        # reversible display gain instead of silently rewriting the data.
        metadata["intensityNormalization"] = {
            "mode": norm.get("mode", "global"),
            "bounds": norm.get("bounds", {}),
            "signalLevels": norm.get("signalLevels", {})
        }

    # Re-processing keeps what the lab curated in the admin panel — orientation, display
    # settings, hand-corrected stage, hidden flag, gallery… (merge_volume_metadata).
    existing = read_json_file(existing_path if existing_path else output_dir / "metadata.json")
    if existing:
        metadata = merge_volume_metadata(existing, metadata)
        print(f"[CATALOG] Curation of the published metadata.json kept")

    atomic_write_json(output_dir / "metadata.json", metadata, indent=2, ensure_ascii=False)
    print(f"[CATALOG] Wrote metadata.json to {output_dir / 'metadata.json'}")


def _inject_histograms(temp_dir, manifest_path, manifest, lod_levels, n_ch, n_tp):
    import importlib.util
    spec = importlib.util.spec_from_file_location("lumen_chunk_packer",
                                                  str(HERE / "3-chunk_packer.py"))
    packer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(packer)
    coarsest = lod_levels[-1]["lod"]
    print(f"[CATALOG] Computing histograms on LOD {coarsest}"
          f"{f' for {n_tp} timepoints' if n_tp > 1 else ''}...")
    histograms = packer.histograms_for_timepoint(temp_dir, 0, n_ch, coarsest)
    manifest["histograms"] = histograms
    tp_manifest = manifest.get("timepoints")
    if isinstance(tp_manifest, dict):
        for t_idx in range(n_tp):
            key = f"t{t_idx:03d}"
            if key in tp_manifest:
                tp_manifest[key]["histograms"] = (
                    histograms if t_idx == 0
                    else packer.histograms_for_timepoint(temp_dir, t_idx, n_ch, coarsest))
    atomic_write_json(manifest_path, manifest, separators=(",", ":"))
    print(f"[CATALOG] Injected histograms into manifest.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Write a volume dataset's metadata.json.")
    ap.add_argument("temp_dir")
    ap.add_argument("output_dir")
    ap.add_argument("--existing", default=None,
                    help="published metadata.json whose curation is kept "
                         "(default: <output_dir>/metadata.json)")
    ap.add_argument("--display-name", default=None,
                    help="name shown for the dataset (default: the folder name)")
    args = ap.parse_args()

    try:
        generate_catalog_metadata(Path(args.temp_dir), Path(args.output_dir),
                                  Path(args.existing) if args.existing else None,
                                  args.display_name)
        print(f"[CATALOG] Catalog metadata generation complete.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] Catalog metadata generation failed: {e}", file=sys.stderr)
        sys.exit(1)
