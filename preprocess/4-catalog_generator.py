#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path
import numpy as np

COLORS = ["#00FF00", "#00AAFF", "#FF00FF", "#FF0000", "#FFFF00", "#00FFFF"]

def _parse_stage(name: str):
    for pattern in (r"-(E(\d(?:\.?\d+)?))($|-)", r"^(E(\d(?:\.?\d+)?))(-|$)"):
        m = re.search(pattern, name, re.IGNORECASE)
        if m:
            raw = m.group(2).replace(".", "")
            display = f"E{raw}" if len(raw) == 1 else f"E{raw[0]}.{raw[1:]}"
            numeric = float(raw) if len(raw) == 1 else float(f"{raw[0]}.{raw[1:]}")
            return display, numeric
    return "Unknown", 0.0

def _parse_embryo(name: str):
    m = re.search(r"-(Em\d+)-", name, re.IGNORECASE)
    return m.group(1) if m else None

def generate_catalog_metadata(temp_dir: Path, output_dir: Path):
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
    
    # Parse stage and embryo from folder name
    dataset_name = output_dir.name
    stage, stage_num = _parse_stage(dataset_name)
    embryo = _parse_embryo(dataset_name)
    
    # Path relative to DATA_WEB root
    # e.g., "fixed/Egfl7..."
    type_dir = output_dir.parent.name
    rel_path_str = f"DATA_WEB/{type_dir}/{dataset_name}"
    
    # 1. Compute Histograms on the highest LOD level to save time and RAM
    highest_lod = lod_levels[-1]["lod"]
    lod_w = lod_levels[-1]["width"]
    lod_h = lod_levels[-1]["height"]

    def _histograms_for_timepoint(t_idx: int):
        out = []
        for c_idx in range(n_ch):
            bin_file = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod{highest_lod}.bin"
            if bin_file.exists():
                vol_data = np.fromfile(str(bin_file), dtype=np.uint8)
                counts, edges = np.histogram(vol_data, bins=64, range=(0, 255))

                mean_val = float(vol_data.mean()) if vol_data.size else 0.0
                std_val = float(vol_data.std()) if vol_data.size else 0.0
                max_val = int(vol_data.max()) if vol_data.size else 0

                out.append({
                    "counts": counts.astype(np.int64).tolist(),
                    "edges": edges.astype(np.float64).tolist(),
                    "total": int(vol_data.size),
                    "max": max_val,
                    "mean": mean_val,
                    "std": std_val,
                    "backgroundFloor": 0
                })
                del vol_data
            else:
                print(f"[WARNING] Bin file for histogram not found: {bin_file}")
                out.append({
                    "counts": [0] * 64,
                    "edges": list(range(65)),
                    "total": 0,
                    "max": 0,
                    "mean": 0.0,
                    "std": 0.0,
                    "backgroundFloor": 0
                })
        return out

    print(f"[CATALOG] Computing histograms on LOD {highest_lod} ({lod_w}x{lod_h}x{D})"
          f"{f' for {n_tp} timepoints' if n_tp > 1 else ''}...")
    histograms = _histograms_for_timepoint(0)

    # 2. Update bricks/manifest.json with calculated histograms
    manifest_path = output_dir / "bricks" / "manifest.json"
    if manifest_path.exists():
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        manifest["histograms"] = histograms
        # A timelapse carries one histogram set per frame: the channel panel reads
        # the row of the timepoint on screen, and a shared set would mis-scale the
        # sliders as the specimen bleaches.
        tp_manifest = manifest.get("timepoints")
        if isinstance(tp_manifest, dict):
            for t_idx in range(n_tp):
                key = f"t{t_idx:03d}"
                if key in tp_manifest:
                    tp_manifest[key]["histograms"] = (histograms if t_idx == 0
                                                      else _histograms_for_timepoint(t_idx))
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        print(f"[CATALOG] Injected histograms into manifest.json")
    else:
        print(f"[WARNING] manifest.json not found to update histograms.")

    # 3. Calculate Physical Calibration
    vx = voxel_size["x"]
    vy = voxel_size["y"]
    vz = voxel_size["z"]

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

    # Build metadata.json
    metadata = {
        "id": f"{type_dir}/{dataset_name}",
        "name": dataset_name,
        "type": type_dir,
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
        "calibrationStatus": "exact" if (vx and vy and vz) else "metadata-missing",
        "calibrationNote": "Voxel metadata was successfully extracted." if (vx and vy and vz) else "Calibration metadata missing.",
        "channels": channels_info,
        "created": __import__("datetime").datetime.now().isoformat(),
        "lastModified": __import__("datetime").datetime.now().isoformat(),
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


    with open(output_dir / "metadata.json", "w", encoding="utf-8") as fm:
        json.dump(metadata, fm, indent=2, ensure_ascii=False)
        
    print(f"[CATALOG] Wrote metadata.json to {output_dir / 'metadata.json'}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python 4-catalog_generator.py <temp_dir> <output_dir>")
        sys.exit(1)
        
    temp_dir = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    
    try:
        generate_catalog_metadata(temp_dir, output_dir)
        print(f"[CATALOG] Catalog metadata generation complete.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] Catalog metadata generation failed: {e}", file=sys.stderr)
        sys.exit(1)
