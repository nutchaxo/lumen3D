#!/usr/bin/env python3
import json
import re
import sys
from datetime import datetime
from pathlib import Path
import h5py
import numpy as np

def attr_str(group, key, default=""):
    if group is None:
        return default
    v = group.attrs.get(key, default)
    if isinstance(v, (bytes, np.bytes_)):
        return v.decode("utf-8", errors="replace").strip()
    if isinstance(v, np.ndarray):
        try:
            return b"".join(bytes(c) if isinstance(c, (bytes, np.bytes_))
                            else c.tobytes() for c in v
                           ).decode("utf-8", errors="replace").strip()
        except Exception:
            return "".join(
                (c.decode("utf-8", errors="replace") if isinstance(c, (bytes, np.bytes_)) else str(c))
                for c in v
            ).strip()
    return str(v).strip()

def read_ims_metadata(file_path: Path) -> dict:
    with h5py.File(str(file_path), "r") as f:
        info = f.get("DataSetInfo", {}).get("Image", None)
        
        width = int(attr_str(info, "X", "1") or 1)
        height = int(attr_str(info, "Y", "1") or 1)
        depth = int(attr_str(info, "Z", "1") or 1)

        def _ext(key, fallback=0.0):
            try:
                return float(attr_str(info, key, str(fallback)))
            except ValueError:
                return fallback

        ext_min_x = _ext("ExtMin0")
        ext_max_x = _ext("ExtMax0", 1.0)
        ext_min_y = _ext("ExtMin1")
        ext_max_y = _ext("ExtMax1", 1.0)
        ext_min_z = _ext("ExtMin2")
        ext_max_z = _ext("ExtMax2", 1.0)

        vox_x = (ext_max_x - ext_min_x) / max(width, 1)
        vox_y = (ext_max_y - ext_min_y) / max(height, 1)
        vox_z = (ext_max_z - ext_min_z) / max(depth, 1)

        res0 = f.get("DataSet", {}).get("ResolutionLevel 0", {})
        timepoints = sorted(
            [k for k in res0.keys() if k.startswith("TimePoint")],
            key=lambda x: int(x.split()[-1])
        )
        n_tp = len(timepoints) or 1

        # Acquisition clock. Imaris stores one attribute per frame under
        # DataSetInfo/TimeInfo as "TimePoint1".."TimePointN" (1-based), formatted
        # "YYYY-MM-DD HH:MM:SS.mmm". A timelapse viewer needs the real wall-clock
        # times, not just frame indices, and the median inter-frame gap is what the
        # UI labels the acquisition interval with.
        time_info = f.get("DataSetInfo", {}).get("TimeInfo", None)
        timestamps = []
        for i in range(1, n_tp + 1):
            stamp = attr_str(time_info, f"TimePoint{i}", "") if time_info is not None else ""
            timestamps.append(stamp or None)
        interval_minutes = None
        parsed = []
        for stamp in timestamps:
            if not stamp:
                parsed.append(None)
                continue
            try:
                parsed.append(datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S.%f"))
            except ValueError:
                try:
                    parsed.append(datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S"))
                except ValueError:
                    parsed.append(None)
        gaps = [(b - a).total_seconds() / 60.0
                for a, b in zip(parsed, parsed[1:]) if a is not None and b is not None]
        if gaps:
            interval_minutes = round(float(np.median(gaps)), 4)
        timestamps_iso = [p.isoformat() if p is not None else None for p in parsed]

        channels = []
        if timepoints:
            tp0 = res0[timepoints[0]]
            channels = sorted(
                [k for k in tp0.keys() if k.startswith("Channel")],
                key=lambda x: int(x.split()[-1])
            )
        n_ch = len(channels) or 1

        channel_names = []
        for i in range(n_ch):
            ch_info = f.get("DataSetInfo", {}).get(f"Channel {i}", None)
            name_raw = attr_str(ch_info, "Name", "") if ch_info else ""
            name = re.sub(r'\x00.*', '', name_raw).strip()
            if not name or re.match(r"^ch(annel)?\s*\d+$", name, re.IGNORECASE):
                name = f"Channel {i+1}"
            channel_names.append(name)

        return {
            "width": width,
            "height": height,
            "depth": depth,
            "n_channels": n_ch,
            "n_timepoints": n_tp,
            "voxel_size": {
                "x": round(vox_x, 6),
                "y": round(vox_y, 6),
                "z": round(vox_z, 6)
            },
            # Microscope stage frame, in the acquisition unit (um). This is the frame
            # Imaris-derived object coordinates (spots, surfaces, cell tracks) live in,
            # so it is what an overlay has to be registered against.
            "extent": {
                "unit": attr_str(info, "Unit", "um") or "um",
                "min": [ext_min_x, ext_min_y, ext_min_z],
                "max": [ext_max_x, ext_max_y, ext_max_z]
            },
            "timestamps": timestamps_iso,
            "time_interval_minutes": interval_minutes,
            "channel_names": channel_names
        }

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python 1-ims_metadata.py <input_ims> <output_json>")
        sys.exit(1)
    
    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    
    try:
        meta = read_ims_metadata(input_path)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        print(f"[METADATA] Extracted metadata to {output_path}")
    except Exception as e:
        print(f"[ERROR] Failed to read metadata: {e}", file=sys.stderr)
        sys.exit(1)
