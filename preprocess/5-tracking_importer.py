#!/usr/bin/env python3
"""Attach an Imaris cell-tracking analysis to a preprocessed volume dataset.

Reads a `.imaris_track` container (gzip + JSON, signature IMARIS_TRACKER_V1) produced
by the lab's Imaris analysis scripts and writes, into the dataset directory:

    tracks.json[.gz]   trajectories in the schema the viewer consumes
    model.glb          the pre-baked population surfaces, if one was exported

and injects into `metadata.json` a `registration` block holding the per-timepoint
rigid transform that maps RAW acquisition coordinates onto the STABILISED frame.

Why the transform matters
-------------------------
The tracking is stabilised (the analysis removes the specimen's global motion by a
sequential Kabsch alignment) but the images are not. Because that stabilisation is a
rigid body motion, the very same transform re-expresses the image volume in the
stabilised frame — so the viewer can overlay tracks on images by warping the sampling
coordinates, with no voxel resampling and no loss.

The transform is taken from the container when the exporter declared it, and otherwise
recovered by orthogonal Procrustes on the raw/stabilised point pairs, which is exact
whenever the stabilisation really was rigid. The residual of that fit is recorded and
surfaced in the QC summary: if it is not ~0, the stabilisation was NOT a rigid motion
and must not be pushed onto the images.
"""
import argparse
import gzip
import json
import math
import shutil
import sys
from collections import Counter, OrderedDict
from datetime import datetime
from pathlib import Path

import numpy as np

__version__ = "0.1.0"

SIGNATURE = "IMARIS_TRACKER_V1"
# A Procrustes fit residual under this is machine noise: the stabilisation is rigid and
# the recovered matrix can be applied to the images. Above it, we refuse to claim so.
RIGID_TOLERANCE_UM = 0.05
MIN_FIT_POINTS = 4


def _sig(value, digits=4):
    """Round to significant digits: a residual of 1.2e-12 is the headline QC result and
    fixed-decimal rounding would flatten it to a meaningless 0.0."""
    if value is None:
        return None
    return float(f"{float(value):.{digits}g}")


def _read_container(path: Path) -> dict:
    """Load the gzip+JSON container, tolerating the optional text signature line."""
    with gzip.open(path, "rb") as fh:
        blob = fh.read()
    head = blob[:64]
    if head.startswith(SIGNATURE.encode()):
        nl = blob.index(b"\n")
        blob = blob[nl + 1:]
    doc = json.loads(blob.decode("utf-8"))
    if doc.get("signature") != SIGNATURE:
        raise ValueError(f"{path.name}: not an {SIGNATURE} container "
                         f"(signature={doc.get('signature')!r})")
    if not isinstance(doc.get("data"), dict):
        raise ValueError(f"{path.name}: missing 'data' object")
    return doc


def _procrustes(A: np.ndarray, B: np.ndarray):
    """Least-squares rotation+translation with B ~= A @ R.T + b, det(R) = +1."""
    ca, cb = A.mean(0), B.mean(0)
    U, _, Vt = np.linalg.svd((A - ca).T @ (B - cb))
    D = np.diag([1.0, 1.0, float(np.sign(np.linalg.det(Vt.T @ U.T)))])
    R = Vt.T @ D @ U.T
    return R, cb - R @ ca


def _matrix_column_major(R: np.ndarray, b: np.ndarray):
    """THREE.Matrix4.fromArray() consumes column-major order."""
    m = np.eye(4)
    m[:3, :3] = R
    m[:3, 3] = b
    return [round(float(v), 9) for v in m.T.reshape(-1)]


def _rotation_degrees(R: np.ndarray) -> float:
    return float(np.degrees(np.arccos(np.clip((np.trace(R) - 1.0) / 2.0, -1.0, 1.0))))


def _validate_cells(cells) -> None:
    """Reject a malformed container outright rather than mount it half-way."""
    if not isinstance(cells, list) or not cells:
        raise ValueError("data.cells must be a non-empty array")
    for i, c in enumerate(cells):
        for key in ("id", "t", "x", "y", "z"):
            if key not in c:
                raise ValueError(f"cell #{i}: missing required field '{key}'")
        n = len(c["t"])
        for key in ("x", "y", "z"):
            if len(c[key]) != n:
                raise ValueError(f"cell #{i} (id={c['id']}): '{key}' has {len(c[key])} "
                                 f"values for {n} timepoints")
        for key in ("x_raw", "y_raw", "z_raw"):
            if key in c and len(c[key]) != n:
                raise ValueError(f"cell #{i} (id={c['id']}): '{key}' length mismatch")


def _split_ids(value) -> list:
    """Lineage fields come through as '' | '24' | '24/25'."""
    if value is None:
        return []
    text = str(value).strip()
    if not text or text.lower() in ("nan", "none"):
        return []
    return [part.strip() for part in text.replace(",", "/").split("/") if part.strip()]


def build_tracks_document(doc: dict):
    """Convert the container into the viewer's tracks.json schema."""
    data = doc["data"]
    cells = data["cells"]
    _validate_cells(cells)

    timepoints = sorted(float(t) for t in data.get("timepoints", []))
    if not timepoints:
        timepoints = sorted({float(t) for c in cells for t in c["t"]})

    out_cells = OrderedDict()
    has_raw = False
    for c in cells:
        cid = str(c["id"])
        positions, raw_positions, markers = {}, {}, {}
        marker_list = c.get("marker_color") or []
        cell_has_raw = all(k in c for k in ("x_raw", "y_raw", "z_raw"))
        has_raw = has_raw or cell_has_raw
        for i, t in enumerate(c["t"]):
            key = str(int(t)) if float(t).is_integer() else str(float(t))
            positions[key] = [float(c["x"][i]), float(c["y"][i]), float(c["z"][i])]
            if cell_has_raw:
                raw_positions[key] = [float(c["x_raw"][i]), float(c["y_raw"][i]), float(c["z_raw"][i])]
            marker = marker_list[i] if i < len(marker_list) else ""
            if marker:
                markers[key] = marker

        daughters = _split_ids(c.get("daughter_cells"))
        parents = _split_ids(c.get("parent_cell"))
        entry = {
            "id": cid,
            "track_id": c.get("track_id"),
            "region": c.get("region") or "Unknown",
            "color": c.get("color"),
            "positions": positions,
            "parent": parents[0] if parents else "",
            "daughters": daughters,
            "is_mitosis": bool(daughters),
            # A cell that inherits from two mothers is a fusion, not a division.
            "is_fusion": len(parents) > 1,
        }
        if cell_has_raw:
            entry["raw_positions"] = raw_positions
        if markers:
            entry["markers"] = markers
        out_cells[cid] = entry

    tracks = {
        "schema": "iribhm-tracks-v1",
        "source": doc.get("dataset_name"),
        "sourceId": doc.get("dataset_id"),
        "generated": doc.get("date_generation"),
        "timepoints": timepoints,
        "cells": out_cells,
    }
    if isinstance(data.get("layout"), dict):
        tracks["layout"] = data["layout"]
    return tracks, has_raw


def solve_registration(doc: dict, timepoint_offset: int):
    """Per-timepoint rigid transform mapping raw acquisition coords -> stabilised frame."""
    data = doc["data"]
    cells = data["cells"]

    declared = {}
    stab_block = data.get("stabilization")
    if isinstance(stab_block, dict):
        for row in stab_block.get("transforms", []) or []:
            if row.get("matrix") and row.get("t") is not None:
                declared[float(row["t"])] = row

    pairs = {}
    for c in cells:
        if not all(k in c for k in ("x_raw", "y_raw", "z_raw")):
            continue
        for i, t in enumerate(c["t"]):
            pairs.setdefault(float(t), []).append((
                (c["x_raw"][i], c["y_raw"][i], c["z_raw"][i]),
                (c["x"][i], c["y"][i], c["z"][i]),
            ))

    if not pairs and not declared:
        return None

    transforms, warnings = [], []
    worst = 0.0
    residuals = []
    identity_after_drift = []
    for t in sorted(set(pairs) | set(declared)):
        row = {
            "t": t,
            "index": int(round(t)) + timepoint_offset,
        }
        if t in declared:
            src = declared[t]
            row.update({
                "matrix": [float(v) for v in src["matrix"]],
                "rotationDeg": src.get("rotationDeg"),
                "translationUm": src.get("translationUm"),
                "nPoints": src.get("nRefs"),
                "residualUm": src.get("maxResidualUm"),
                "source": "declared",
                "exact": True,
            })
            transforms.append(row)
            continue

        P = np.array([p[0] for p in pairs[t]], float)
        Q = np.array([p[1] for p in pairs[t]], float)
        if len(P) < MIN_FIT_POINTS:
            warnings.append(f"t={t:g}: only {len(P)} paired points, transform not solvable")
            row.update({"matrix": None, "nPoints": int(len(P)), "residualUm": None,
                        "source": "unsolved", "exact": False})
            transforms.append(row)
            continue

        R, b = _procrustes(P, Q)
        residual = float(np.sqrt((((P @ R.T) + b - Q) ** 2).sum(1).mean()))
        worst = max(worst, residual)
        residuals.append(residual)
        rot = _rotation_degrees(R)
        row.update({
            "matrix": _matrix_column_major(R, b),
            "rotationDeg": round(rot, 4),
            "translationUm": [round(float(v), 6) for v in b],
            "nPoints": int(len(P)),
            "residualUm": _sig(residual),
            "source": "procrustes",
            "exact": residual <= RIGID_TOLERANCE_UM,
        })
        # The analysis skips the alignment when too few reference cells are shared with
        # the previous frame, which leaves that frame in RAW space — an identity sitting
        # in the middle of a drifting series. Silent, and it breaks the overlay for that
        # frame, so it is reported rather than papered over.
        if rot < 1e-6 and np.allclose(b, 0.0, atol=1e-6):
            identity_after_drift.append(t)
        transforms.append(row)

    solved = [r for r in transforms if r.get("matrix")]
    if len(identity_after_drift) > 1:
        interior = [t for t in identity_after_drift if t != min(pairs)]
        if interior:
            warnings.append(
                "identity transform on non-reference timepoints "
                + ", ".join(f"{t:g}" for t in interior)
                + " — the analysis likely skipped their alignment (too few reference "
                  "cells); those frames stay in raw space")
    rigid = bool(solved) and worst <= RIGID_TOLERANCE_UM
    if not rigid and residuals:
        warnings.append(f"max Procrustes residual {worst:.4g} um exceeds the "
                        f"{RIGID_TOLERANCE_UM} um rigid tolerance — the stabilisation is "
                        f"not a rigid motion and must not be applied to the images")

    return {
        "method": "tracking-declared" if declared else "tracking-procrustes",
        "coordinateSpace": "acquisition-um",
        "convention": "p_stabilized = M . p_raw ; matrix is column-major for THREE.Matrix4.fromArray",
        "timepointOffset": timepoint_offset,
        "appliedToVolume": rigid,
        "transforms": transforms,
        "qcSummary": {
            "rigid": rigid,
            "toleranceUm": RIGID_TOLERANCE_UM,
            "maxResidualUm": _sig(worst) if residuals else None,
            "meanResidualUm": _sig(float(np.mean(residuals))) if residuals else None,
            "timepointsSolved": len(solved),
            "timepointsTotal": len(transforms),
            "warnings": warnings,
        },
    }


def _occupied_boxes_um(dataset_dir: Path, extent: dict, dims: dict):
    """Per-timepoint bounding box, in um, of the bricks that actually hold signal.

    Read from bricks/manifest.json, which already records `nonEmpty` per brick after
    empty-space skipping. Using the occupied region rather than the whole acquisition
    box matters: the stabilised specimen barely moves, so its union stays tight, while
    the union of the full imaged boxes is several times larger and would make the
    renderer sweep mostly empty space.
    """
    manifest_path = dataset_dir / "bricks" / "manifest.json"
    if not manifest_path.exists() or not extent or not dims:
        return None
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

    lo = np.array(extent["min"], float)
    hi = np.array(extent["max"], float)
    grid = np.array([dims.get("x", 1), dims.get("y", 1), dims.get("z", 1)], float)
    voxel = (hi - lo) / np.maximum(grid, 1.0)

    def box_from_levels(levels):
        level = next((l for l in levels or [] if l.get("level") == 0), None)
        if not level:
            return None
        mins, maxs = [], []
        for chunk in level.get("chunks", []):
            if chunk.get("nonEmpty") is False:
                continue
            mins.append(chunk["min"])
            maxs.append(chunk["max"])
        if not mins:
            return None
        return (lo + np.array(mins, float).min(0) * voxel,
                lo + np.array(maxs, float).max(0) * voxel)

    rows = manifest.get("timepoints")
    if isinstance(rows, dict):
        out = {}
        for key, row in rows.items():
            box = box_from_levels(row.get("levels") or manifest.get("levels"))
            if box:
                out[int(key[1:]) if key.startswith("t") else int(key)] = box
        return out or None
    box = box_from_levels(manifest.get("levels"))
    return {0: box} if box else None


def _image_box_union(registration: dict, extent: dict, occupied=None):
    """Union, over every timepoint, of the imaged content carried into stabilised space.

    In stabilised mode the specimen stands still and the imaged box moves around it, so
    the box the renderer must cover is this union rather than the acquisition box.
    Falls back to the full acquisition box when brick occupancy is unavailable.
    """
    if not registration or not extent:
        return None
    default_lo = np.array(extent["min"], float)
    default_hi = np.array(extent["max"], float)
    pts = []
    for row in registration["transforms"]:
        m = row.get("matrix")
        if not m:
            continue
        box = (occupied or {}).get(row.get("index"))
        blo, bhi = box if box else (default_lo, default_hi)
        corners = np.array([[x, y, z] for x in (blo[0], bhi[0])
                            for y in (blo[1], bhi[1]) for z in (blo[2], bhi[2])])
        M = np.array(m, float).reshape(4, 4).T
        pts.append(corners @ M[:3, :3].T + M[:3, 3])
    if not pts:
        return None
    allp = np.vstack(pts)
    return {
        "min": [round(float(v), 4) for v in allp.min(0)],
        "max": [round(float(v), 4) for v in allp.max(0)],
        "basis": "occupied-bricks" if occupied else "acquisition-box",
    }


def _bounds(points):
    if not points:
        return None
    arr = np.array(points, float)
    return {"min": [round(float(v), 4) for v in arr.min(0)],
            "max": [round(float(v), 4) for v in arr.max(0)]}


def import_tracking(track_path: Path, dataset_dir: Path, glb_path: Path = None,
                    timepoint_offset: int = -1, write_gzip: bool = True):
    doc = _read_container(track_path)
    tracks, has_raw = build_tracks_document(doc)

    metadata_path = dataset_dir / "metadata.json"
    if not metadata_path.exists():
        raise FileNotFoundError(f"{metadata_path} not found — run the volume pipeline first")
    with open(metadata_path, "r", encoding="utf-8") as fh:
        metadata = json.load(fh)

    registration = solve_registration(doc, timepoint_offset)
    if registration is None:
        print("[TRACKING] No raw/stabilised pairs and no declared transform: "
              "the overlay will be available but the volume cannot be stabilised.")

    # --- Write tracks.json (+ .gz) ---
    payload = json.dumps(tracks, ensure_ascii=False, separators=(",", ":"))
    (dataset_dir / "tracks.json").write_text(payload, encoding="utf-8")
    gz_note = ""
    if write_gzip:
        with gzip.open(dataset_dir / "tracks.json.gz", "wb", compresslevel=9) as fh:
            fh.write(payload.encode("utf-8"))
        gz_note = f", {(dataset_dir / 'tracks.json.gz').stat().st_size/1e6:.2f} MB gzipped"
    print(f"[TRACKING] tracks.json: {len(tracks['cells'])} cells, "
          f"{len(tracks['timepoints'])} timepoints, {len(payload)/1e6:.2f} MB{gz_note}")

    # --- Copy the surface GLB ---
    surface_rel = None
    if glb_path is None:
        candidate = track_path.with_suffix(".glb")
        glb_path = candidate if candidate.exists() else None
    if glb_path and glb_path.exists():
        shutil.copy2(glb_path, dataset_dir / "model.glb")
        surface_rel = "model.glb"
        print(f"[TRACKING] model.glb: {(dataset_dir / 'model.glb').stat().st_size/1e6:.1f} MB")
    else:
        print("[TRACKING] no surface GLB found — the overlay will render cells and trails only")

    # --- Region inventory (drives the legend and the region colour palette) ---
    region_counts = Counter(c["region"] for c in tracks["cells"].values())
    region_colors = {}
    for c in tracks["cells"].values():
        region_colors.setdefault(c["region"], c.get("color"))

    stab_pts, raw_pts = [], []
    for c in tracks["cells"].values():
        stab_pts.extend(c["positions"].values())
        raw_pts.extend((c.get("raw_positions") or {}).values())

    metadata["tracking"] = {
        "schema": "iribhm-tracks-v1",
        "source": track_path.name,
        "sourceDataset": doc.get("dataset_name"),
        "generated": doc.get("date_generation"),
        "imported": datetime.now().isoformat(),
        "tracksPath": "tracks.json",
        "surfacePath": surface_rel,
        "cellCount": len(tracks["cells"]),
        "timepointCount": len(tracks["timepoints"]),
        "hasRawCoordinates": has_raw,
        "mitosisCount": sum(1 for c in tracks["cells"].values() if c["is_mitosis"]),
        "fusionCount": sum(1 for c in tracks["cells"].values() if c["is_fusion"]),
        "regions": [{"name": name, "cells": n, "color": region_colors.get(name)}
                    for name, n in region_counts.most_common()],
        "boundsUm": {"stabilized": _bounds(stab_pts), "raw": _bounds(raw_pts)},
    }

    if registration:
        extent = metadata.get("acquisitionExtentUm")
        occupied = _occupied_boxes_um(dataset_dir, extent, metadata.get("dimensions"))
        union = _image_box_union(registration, extent, occupied)
        if union:
            registration["imageBoxUnionUm"] = union
            span = [union["max"][i] - union["min"][i] for i in range(3)]
            acq = [extent["max"][i] - extent["min"][i] for i in range(3)]
            ratio = (span[0] * span[1] * span[2]) / max(acq[0] * acq[1] * acq[2], 1e-9)
            print(f"[TRACKING] display box ({union['basis']}): "
                  f"{span[0]:.0f} x {span[1]:.0f} x {span[2]:.0f} um, "
                  f"{ratio:.2f}x the acquisition volume")
        metadata["registration"] = registration

        qc = registration["qcSummary"]
        verdict = "rigide (exacte)" if qc["rigid"] else "NON rigide"
        print(f"[TRACKING] registration: {qc['timepointsSolved']}/{qc['timepointsTotal']} "
              f"timepoints, residu max {qc['maxResidualUm']:.3g} um -> {verdict}")
        for w in qc["warnings"]:
            print(f"[TRACKING]   [!] {w}")

    metadata["lastModified"] = datetime.now().isoformat()
    with open(metadata_path, "w", encoding="utf-8") as fh:
        json.dump(metadata, fh, indent=2, ensure_ascii=False)
    print(f"[TRACKING] Updated {metadata_path}")
    return metadata


def main():
    ap = argparse.ArgumentParser(
        description="Attach an Imaris .imaris_track analysis to a preprocessed volume dataset.")
    ap.add_argument("track", help="path to the .imaris_track container")
    ap.add_argument("dataset", help="dataset directory, e.g. DATA_WEB/live/<name>")
    ap.add_argument("--glb", default=None,
                    help="surface GLB to attach (default: <track>.glb next to the container)")
    ap.add_argument("--timepoint-offset", type=int, default=-1,
                    help="added to the tracking timepoint to get the volume frame index "
                         "(default -1: Imaris counts frames from 1, the brick pyramid from 0)")
    ap.add_argument("--no-gzip", action="store_true", help="skip writing tracks.json.gz")
    args = ap.parse_args()

    try:
        import_tracking(Path(args.track), Path(args.dataset),
                        Path(args.glb) if args.glb else None,
                        timepoint_offset=args.timepoint_offset,
                        write_gzip=not args.no_gzip)
        print("[TRACKING] Import complete.")
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] Tracking import failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
