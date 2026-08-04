#!/usr/bin/env python3
"""Find the cell-tracking analysis that belongs to an .ims volume, whatever shape it came in.

Three shapes exist in the lab, and a dataset may carry any one of them:

  1. ``<stem>.imaris_track``   the tracking pipeline's own output (gzip+JSON container).
                               Already carries stabilised AND raw coordinates, lineage and
                               event markers, and usually a sibling ``<stem>.glb`` surface.
  2. the ``.ims`` itself       Imaris keeps its Spots/Tracks objects in ``Scene8/Content``.
                               Nothing has to sit next to the volume for this to work.
  3. ``<stem>.xls`` / ``.xlsx`` the Imaris "export statistics on all tabs" workbook, whose
                               ``Position`` sheet holds one row per spot per timepoint.

Preference order is (1) > (2) > (3): the container is the richest (it is a finished analysis,
surfaces included), Scene8 comes next because it is *inside* the volume — no sidecar to lose,
no sheet-name ambiguity — and the workbook last, as the fallback for volumes whose Scene8
objects were stripped or never saved.

Sources (2) and (3) are raw observations: they carry spot positions, track membership and a
classification, but no unique cell identity, no lineage and no stabilisation. Those are
produced here by calling the lab's own analysis code (``SCRIPTS/Analysis.py``) rather than a
second implementation — a dataset must yield the same tracks whether it went through the
tracking pipeline or through this shortcut.

CLI (diagnostics):
    python tracking_sources.py <file.ims|file.xls|file.xlsx> [--list] [--out <container>]
"""
import argparse
import gzip
import importlib.util
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path

import numpy as np

__version__ = "0.1.0"

SIGNATURE = "IMARIS_TRACKER_V1"
SCRIPT_DIR = Path(__file__).resolve().parent

CONTAINER_SUFFIX = ".imaris_track"
EXCEL_SUFFIXES = (".xls", ".xlsx", ".xlsm")

# Imaris numbers acquisition frames from 1 in every statistics export, and the whole
# downstream chain (the containers the tracking pipeline writes, the importer's default
# --timepoint-offset of -1) is built on that. Scene8 indexes its timepoints from 0, so the
# only place the two conventions meet is here.
SCENE8_TIME_BASE = 1

# Column headers Imaris emits on the Position sheet that are never the classification.
# Whatever single header is left over IS the classification, whose name the biologist chose
# ("Region", "Set 1", "Point Locations", "Endothelial cells", … all seen in the wild).
_POSITION_RESERVED = {
    "position x", "position y", "position z", "unit", "category", "collection",
    "time", "time index", "trackid", "track id", "id", "birth", "death",
    "referenceframe", "reference frame", "class", "image", "channel", "level",
}


# ─────────────────────────────────────────────────────────────────────────────
#  Discovery
# ─────────────────────────────────────────────────────────────────────────────

class TrackingSource:
    """One candidate tracking analysis for a dataset."""

    #: preference order, lowest first
    RANK = {"container": 0, "scene8": 1, "excel": 2}

    def __init__(self, kind: str, path: Path, detail: str = "", glb: Path = None):
        self.kind = kind
        self.path = Path(path)
        self.detail = detail
        self.glb = Path(glb) if glb else None

    @property
    def rank(self) -> int:
        return self.RANK.get(self.kind, 99)

    def describe(self) -> str:
        label = {"container": "conteneur .imaris_track",
                 "scene8": "objets Imaris embarques (Scene8)",
                 "excel": "classeur statistiques Imaris"}.get(self.kind, self.kind)
        suffix = f" — {self.detail}" if self.detail else ""
        return f"{label}: {self.path.name}{suffix}"

    def __repr__(self):
        return f"<TrackingSource {self.kind} {self.path.name}>"


def _sidecar_candidates(ims_path: Path, suffixes):
    """Files sharing the volume's stem, beside it or in a folder named after it.

    The lab ships analyses either flat next to the .ims or grouped one-folder-per-sample
    (that is how ``INPUT STATISTICS.zip`` unpacks), so both layouts are searched.
    """
    stem = ims_path.stem
    seen, out = set(), []
    for base in (ims_path.parent, ims_path.parent / stem):
        if not base.is_dir():
            continue
        for suffix in suffixes:
            for cand in (base / f"{stem}{suffix}", base / f"{stem}_analysis{suffix}"):
                if cand.is_file() and cand not in seen:
                    seen.add(cand)
                    out.append(cand)
    return out


def discover(ims_path) -> list:
    """Every tracking source that exists for this volume, best first."""
    ims_path = Path(ims_path)
    found = []

    for cand in _sidecar_candidates(ims_path, (CONTAINER_SUFFIX,)):
        glb = cand.with_suffix(".glb")
        found.append(TrackingSource("container", cand,
                                    "surfaces .glb incluses" if glb.exists() else "",
                                    glb if glb.exists() else None))

    if ims_path.suffix.lower() == ".ims":
        summary = probe_scene8(ims_path)
        if summary:
            found.append(TrackingSource("scene8", ims_path, summary))

    for cand in _sidecar_candidates(ims_path, EXCEL_SUFFIXES):
        found.append(TrackingSource("excel", cand))

    found.sort(key=lambda s: s.rank)
    return found


# ─────────────────────────────────────────────────────────────────────────────
#  Source 2 — Imaris Scene8 objects, read straight out of the .ims
# ─────────────────────────────────────────────────────────────────────────────

def _h5_text(value) -> str:
    """Imaris writes strings both as one byte blob and as an array of single characters."""
    if isinstance(value, (bytes, np.bytes_)):
        return value.decode("utf-8", "replace").strip()
    if isinstance(value, np.ndarray):
        parts = [bytes(c) if isinstance(c, (bytes, np.bytes_)) else str(c).encode("utf-8")
                 for c in value.ravel()]
        return b"".join(parts).decode("utf-8", "replace").strip()
    return str(value).strip()


def _pick_points_group(content):
    """The Spots object holding the tracking. Imaris allows several; take the largest."""
    best = None
    for name in content.keys():
        group = content.get(name)
        if not hasattr(group, "keys") or "Spot" not in group:
            continue
        n_spots = int(group["Spot"].shape[0])
        if n_spots and (best is None or n_spots > best[1]):
            best = (name, n_spots, group)
    return best


def _track_table_names(group):
    """Dataset names of the track tables, as declared by MainTrackTable.

    Imaris writes ``Track0``/``TrackObject0``/``TrackEdge0`` in practice, but the names are
    data, not convention — MainTrackTable is the index that resolves them.
    """
    table = group.get("MainTrackTable")
    if table is not None and table.shape[0]:
        row = table[0]
        names = (_h5_text(row[1]), _h5_text(row[2]), _h5_text(row[3]))
        if all(n in group for n in names):
            return names
    if "Track0" in group and "TrackObject0" in group:
        return ("Track0", "TrackObject0", "TrackEdge0")
    return None


def probe_scene8(ims_path) -> str:
    """One-line summary of the tracking inside an .ims, or "" when there is none."""
    try:
        import h5py
    except ImportError:
        return ""
    try:
        with h5py.File(str(ims_path), "r") as f:
            content = f.get("Scene8/Content")
            if content is None:
                return ""
            picked = _pick_points_group(content)
            if picked is None:
                return ""
            name, n_spots, group = picked
            names = _track_table_names(group)
            if not names:
                return ""
            n_tracks = int(group[names[0]].shape[0])
            if not n_tracks:
                return ""
            n_tp = int(group["SpotTimeOffset"].shape[0]) if "SpotTimeOffset" in group else 0
            obj_name = _h5_text(group.attrs.get("Name", name))
            return f"{n_spots} spots, {n_tracks} pistes, {n_tp} timepoints ({obj_name})"
    except Exception:
        return ""


def _scene8_labels(group, spot_ids: set, track_ids: set):
    """Resolve the biologist's classification into ``object id -> label``.

    Imaris stores it as a flat, cumulative index: LabelValues holds every label of every
    group back to back, LabelGroupNames closes each group with an end offset, and LabelSets
    closes each (labels, objects) assignment the same way. A group is applied either to
    spots or to tracks, and both usually exist ("Point Locations" / "Track Locations").
    """
    def _rows(name):
        ds = group.get(name)
        return ds[:] if ds is not None and ds.shape[0] else []

    values = [_h5_text(r[0]) for r in _rows("LabelValues")]
    if not values:
        return {}, {}

    group_of_label, prev = {}, 0
    for row in _rows("LabelGroupNames"):
        gname, end = _h5_text(row[0]), int(row[1])
        for i in range(prev, min(end, len(values))):
            group_of_label[i] = gname
        prev = end

    label_ids = [int(r[0]) for r in _rows("LabelSetLabelIDs")]
    object_ids = [int(r[0]) for r in _rows("LabelSetObjectIDs")]

    spot_labels, track_labels = {}, {}
    prev_l = prev_o = 0
    for row in _rows("LabelSets"):
        end_l, end_o = int(row[0]), int(row[1])
        objs = object_ids[prev_o:end_o]
        for li in label_ids[prev_l:end_l]:
            if li >= len(values):
                continue
            gname = group_of_label.get(li, "")
            name = values[li]
            for obj in objs:
                target = spot_labels if obj in spot_ids else (track_labels if obj in track_ids else None)
                if target is None:
                    continue
                target.setdefault(gname, {}).setdefault(obj, name)
        prev_l, prev_o = end_l, end_o

    # A group classifies spots or tracks, never both. Imaris keeps the two id spaces
    # disjoint, but an id seen in both would otherwise split one group across the two
    # tables and shrink it; the side holding the most objects is the group's real target.
    for gname in set(spot_labels) & set(track_labels):
        if len(spot_labels[gname]) >= len(track_labels[gname]):
            track_labels.pop(gname)
        else:
            spot_labels.pop(gname)
    return spot_labels, track_labels


def read_scene8(ims_path) -> dict:
    """Flat per-spot table read from the .ims itself. Returns None when there is no tracking."""
    import h5py

    ims_path = Path(ims_path)
    with h5py.File(str(ims_path), "r") as f:
        content = f.get("Scene8/Content")
        if content is None:
            return None
        picked = _pick_points_group(content)
        if picked is None:
            return None
        obj_key, _, group = picked
        names = _track_table_names(group)
        if not names:
            return None
        track_name, trackobj_name, _edge_name = names

        spot = group["Spot"][:]
        if not len(spot):
            return None
        tracks = group[track_name][:]
        if not len(tracks):
            return None
        track_objects = group[trackobj_name][:]
        time_offsets = group["SpotTimeOffset"][:] if "SpotTimeOffset" in group else []

        # Spot -> timepoint. SpotTimeOffset slices the Spot table POSITIONALLY, one slice per
        # frame; spot ids are not ordered and must not be used as indices here.
        time_of_spot = {}
        for row in time_offsets:
            frame, begin, end = int(row[0]), int(row[1]), int(row[2])
            for s in spot[begin:end]:
                time_of_spot[int(s[0])] = frame + SCENE8_TIME_BASE

        # Spot -> track, same positional slicing into the track-object table.
        track_of_spot = {}
        for row in tracks:
            tid, begin, end = int(row[0]), int(row[1]), int(row[2])
            for obj in track_objects[begin:end]:
                track_of_spot[int(obj[0])] = tid

        spot_ids = {int(s[0]) for s in spot}
        track_ids = {int(t[0]) for t in tracks}
        spot_labels, track_labels = _scene8_labels(group, spot_ids, track_ids)

        # A spot-level classification is the ground truth; a track-level one is second best
        # (it paints every spot of a track with the track's label). Widest coverage wins.
        region_of_spot, region_source = {}, None
        if spot_labels:
            gname, mapping = max(spot_labels.items(), key=lambda kv: len(kv[1]))
            region_of_spot = dict(mapping)
            region_source = f"{gname} (spots)"
        elif track_labels:
            gname, mapping = max(track_labels.items(), key=lambda kv: len(kv[1]))
            region_of_spot = {sid: mapping[tid] for sid, tid in track_of_spot.items() if tid in mapping}
            region_source = f"{gname} (pistes)"

        rows = []
        untimed = 0
        for s in spot:
            sid = int(s[0])
            frame = time_of_spot.get(sid)
            if frame is None:
                untimed += 1
                continue
            rows.append({
                "cell_id": sid,
                "timepoint": float(frame),
                "x": float(s[1]),
                "y": float(s[2]),
                "z": float(s[3]),
                "track_id": track_of_spot.get(sid),
                "region": region_of_spot.get(sid, "Unknown"),
            })

    return {
        "rows": rows,
        "regionSource": region_source,
        "warnings": ([f"{untimed} spots sans timepoint ignores"] if untimed else []),
        "provenance": {
            "kind": "scene8",
            "file": ims_path.name,
            "object": obj_key,
            "spots": len(rows),
            "tracks": len(tracks),
            "regionColumn": region_source,
            "timeBase": SCENE8_TIME_BASE,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
#  Source 3 — the Imaris statistics workbook
# ─────────────────────────────────────────────────────────────────────────────

def _read_workbook(path: Path):
    """[(sheet name, [rows of values])] for .xls (BIFF) and .xlsx alike."""
    suffix = path.suffix.lower()
    if suffix == ".xls":
        try:
            import xlrd
        except ImportError as exc:
            raise RuntimeError(
                "lecture d'un .xls Imaris : le paquet 'xlrd' est requis (pip install xlrd)"
            ) from exc
        book = xlrd.open_workbook(str(path), on_demand=True)
        try:
            for index, name in enumerate(book.sheet_names()):
                sheet = book.sheet_by_index(index)
                yield name, [sheet.row_values(r) for r in range(sheet.nrows)]
                book.unload_sheet(index)
        finally:
            book.release_resources()
        return

    try:
        import openpyxl
    except ImportError as exc:
        raise RuntimeError(
            "lecture d'un .xlsx Imaris : le paquet 'openpyxl' est requis (pip install openpyxl)"
        ) from exc
    book = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
    try:
        for sheet in book.worksheets:
            yield sheet.title, [list(row) for row in sheet.iter_rows(values_only=True)]
    finally:
        book.close()


def _header_index(rows, needles):
    """Row index of the header line, searched in the first few rows.

    Imaris prefixes each sheet with its own title line, so the header is on row 2 there,
    while a hand-flattened table has it on row 1. Both are accepted.
    """
    for i, row in enumerate(rows[:6]):
        cells = {str(c).strip().lower() for c in row if c is not None}
        if all(n in cells for n in needles):
            return i
    return None


def _pick_position_sheet(path: Path):
    """The sheet carrying one row per spot per timepoint, plus its header row."""
    fallback = None
    for name, rows in _read_workbook(path):
        if not rows:
            continue
        head = _header_index(rows, ("position x", "position y", "position z"))
        if head is not None:
            return name, rows, head, "imaris-statistics"
        if fallback is None:
            head = _header_index(rows, ("x", "y", "z"))
            if head is not None:
                fallback = (name, rows, head, "flat-table")
    return fallback if fallback else (None, None, None, None)


def read_excel(path) -> dict:
    """Flat per-spot table read from an Imaris statistics workbook."""
    path = Path(path)
    sheet_name, rows, head, layout = _pick_position_sheet(path)
    if rows is None:
        raise ValueError(f"{path.name}: aucune feuille de positions (Position X/Y/Z) trouvee")

    header = [str(c).strip() if c is not None else "" for c in rows[head]]
    lower = [h.lower() for h in header]

    def col(*aliases):
        for alias in aliases:
            if alias in lower:
                return lower.index(alias)
        return None

    ix = col("position x", "x", "x_um")
    iy = col("position y", "y", "y_um")
    iz = col("position z", "z", "z_um")
    it = col("time", "timepoint", "time index", "frame", "t")
    iid = col("id", "cell_id", "spot_id", "object_id")
    itrack = col("trackid", "track_id", "track id")

    if None in (ix, iy, iz):
        raise ValueError(f"{path.name} / {sheet_name}: colonnes de position introuvables")

    # Whatever header Imaris did not put there itself is the biologist's classification.
    ireg = col("region", "group", "population", "class")
    region_name = header[ireg] if ireg is not None else None
    if ireg is None:
        for i, name in enumerate(lower):
            if name and name not in _POSITION_RESERVED:
                ireg, region_name = i, header[i]
                break

    out, skipped = [], 0
    for raw in rows[head + 1:]:
        if raw is None or len(raw) <= max(ix, iy, iz):
            skipped += 1
            continue
        try:
            x, y, z = float(raw[ix]), float(raw[iy]), float(raw[iz])
        except (TypeError, ValueError):
            skipped += 1
            continue
        entry = {"x": x, "y": y, "z": z}
        entry["timepoint"] = _as_float(raw[it]) if it is not None else 1.0
        entry["cell_id"] = _as_float(raw[iid]) if iid is not None else float(len(out) + 1)
        entry["track_id"] = _as_float(raw[itrack]) if itrack is not None else None
        region = raw[ireg] if ireg is not None and ireg < len(raw) else None
        entry["region"] = str(region).strip() if region not in (None, "") else "Unknown"
        if entry["timepoint"] is None or entry["cell_id"] is None:
            skipped += 1
            continue
        out.append(entry)

    if not out:
        raise ValueError(f"{path.name} / {sheet_name}: aucune ligne exploitable")

    return {
        "rows": out,
        "regionSource": region_name,
        "warnings": ([f"{skipped} lignes ignorees (valeurs manquantes)"] if skipped else []),
        "provenance": {
            "kind": "excel",
            "file": path.name,
            "sheet": sheet_name,
            "layout": layout,
            "spots": len(out),
            "regionColumn": region_name,
        },
    }


def _as_float(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ─────────────────────────────────────────────────────────────────────────────
#  Raw table -> IMARIS_TRACKER_V1 container
# ─────────────────────────────────────────────────────────────────────────────

_ANALYSIS_MODULE = None


def _analysis_dirs():
    env = os.environ.get("LUMEN3D_TRACKING_SCRIPTS")
    if env:
        yield Path(env)
    yield SCRIPT_DIR.parent / "SCRIPTS"              # repo layout
    yield SCRIPT_DIR.parent / "tracking" / "SCRIPTS"  # pipeline bundle layout
    yield SCRIPT_DIR / "SCRIPTS"


def load_analysis():
    """Import the lab's Analysis.py as a library.

    Cell identity across a division, lineage and the Kabsch stabilisation are scientific
    choices that already have one implementation; a dataset taken through this shortcut must
    come out identical to one taken through the tracking pipeline, so that implementation is
    imported rather than mirrored.
    """
    global _ANALYSIS_MODULE
    if _ANALYSIS_MODULE is not None:
        return _ANALYSIS_MODULE

    for directory in _analysis_dirs():
        script = directory / "Analysis.py"
        if not script.is_file():
            continue
        # export_html.py is imported by Analysis.py as a top-level sibling.
        sys.path.insert(0, str(directory.resolve()))
        try:
            spec = importlib.util.spec_from_file_location("lumen_tracking_analysis", str(script))
            module = importlib.util.module_from_spec(spec)
            sys.modules.setdefault("lumen_tracking_analysis", module)
            spec.loader.exec_module(module)
        except Exception as exc:
            sys.path.pop(0)
            raise RuntimeError(f"{script} n'a pas pu etre importe : {exc}") from exc
        _ANALYSIS_MODULE = module
        return module

    raise RuntimeError(
        "Analysis.py introuvable (cherche dans "
        + ", ".join(str(d) for d in _analysis_dirs())
        + "). Definissez LUMEN3D_TRACKING_SCRIPTS sur le dossier SCRIPTS du pipeline de tracking."
    )


def _padded_range(vmin, vmax, pad=0.05):
    span = vmax - vmin
    if span == 0:
        span = 1
    return [float(vmin - span * pad), float(vmax + span * pad)]


def build_container(table: dict, dataset_name: str, verbose: bool = True) -> dict:
    """Turn a flat per-spot table into an IMARIS_TRACKER_V1 document.

    Mirrors, step for step, what ``Analysis.process_sample`` does between reading the workbook
    and calling ``export_html.export_imaris_track`` — which is the schema written here.
    """
    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError(
            "l'extraction du tracking depuis un .ims/.xls demande 'pandas' (pip install pandas)"
        ) from exc

    A = load_analysis()

    df = pd.DataFrame(table["rows"], columns=["cell_id", "timepoint", "x", "y", "z",
                                              "track_id", "region"])
    df = A.standardize_input_dataframe(df, sample_name=dataset_name)
    df = A.assign_synthetic_track_ids(df)

    assigner = A.CellIDAssigner()
    result = assigner.assign_ids(df)

    result["marker_color"] = ""
    for tp, cid in assigner.mitosis_markers:
        result.loc[(result["timepoint"] == tp) & (result["unique_cell_id"] == cid), "marker_color"] = "red"
    for tp, cid in assigner.fusion_markers:
        result.loc[(result["timepoint"] == tp) & (result["unique_cell_id"] == cid), "marker_color"] = "black"

    if verbose:
        print(f"  [TRACKING] {len(result)} spots, {result['track_id'].nunique()} pistes, "
              f"{result['unique_cell_id'].nunique()} cellules, "
              f"{len(assigner.daughter_map)} mitoses")
    result, _diagnostics = A.stabilize_coordinates(result, assigner)

    palette = A.REGION_PALETTE
    regions = sorted({str(r) for r in result["region"].unique()}, key=str)
    region_colors = {r: palette[i % len(palette)] for i, r in enumerate(regions)}

    cells = []
    for cid, grp in result.groupby("unique_cell_id"):
        grp = grp.sort_values("timepoint")
        region = str(grp["region"].iloc[0])
        parents = grp["parent_cell"].dropna()
        daughters = grp["daughter_cells"].dropna()
        cells.append({
            "id": int(cid),
            "track_id": int(grp["track_id"].iloc[0]) if grp["track_id"].notna().any() else None,
            "region": region,
            "color": region_colors[region],
            "t": [float(v) for v in grp["timepoint"]],
            "x": [float(v) for v in grp["x_stab"]],
            "y": [float(v) for v in grp["y_stab"]],
            "z": [float(v) for v in grp["z_stab"]],
            "x_raw": [float(v) for v in grp["x"]],
            "y_raw": [float(v) for v in grp["y"]],
            "z_raw": [float(v) for v in grp["z"]],
            "marker_color": list(grp["marker_color"]),
            "parent_cell": str(parents.iloc[0]) if len(parents) else "",
            "daughter_cells": str(daughters.iloc[0]) if len(daughters) else "",
        })

    provenance = dict(table.get("provenance") or {})
    provenance.update({
        "extractedBy": f"tracking_sources.py {__version__}",
        "cells": len(cells),
        "stabilization": "sequential-kabsch (Analysis.stabilize_coordinates)",
    })

    return {
        "signature": SIGNATURE,
        "dataset_id": str(uuid.uuid4()),
        "dataset_name": dataset_name,
        "date_generation": datetime.now().isoformat(),
        "data": {
            "timepoints": sorted(float(t) for t in result["timepoint"].unique()),
            "cells": cells,
            "layout": {
                "x_range": _padded_range(result["x_stab"].min(), result["x_stab"].max()),
                "y_range": _padded_range(result["y_stab"].min(), result["y_stab"].max()),
                "z_range": _padded_range(result["z_stab"].min(), result["z_stab"].max()),
            },
            "provenance": provenance,
        },
    }


def write_container(doc: dict, path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(str(path), "wb") as fh:
        fh.write(SIGNATURE.encode() + b"\n")
        fh.write(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    return path


# ─────────────────────────────────────────────────────────────────────────────
#  Top level
# ─────────────────────────────────────────────────────────────────────────────

def read_source(source: TrackingSource) -> dict:
    if source.kind == "scene8":
        return read_scene8(source.path)
    if source.kind == "excel":
        return read_excel(source.path)
    raise ValueError(f"source {source.kind} is already a container")


def _merge_regions_from_excel(table: dict, ims_path: Path, verbose: bool) -> None:
    """Fill in a missing classification from a sidecar workbook, matched on spot id.

    A volume can hold its Spots objects while the classification was only ever applied in the
    copy the biologist exported statistics from. The ids are Imaris object ids and identify
    the same spots across both files, so the labels can be carried over without touching a
    single coordinate.
    """
    if table.get("regionSource"):
        return
    for cand in _sidecar_candidates(ims_path, EXCEL_SUFFIXES):
        try:
            side = read_excel(cand)
        except Exception:
            continue
        if not side.get("regionSource"):
            continue
        labels = {int(r["cell_id"]): r["region"] for r in side["rows"] if r.get("region")}
        hits = 0
        for row in table["rows"]:
            label = labels.get(int(row["cell_id"]))
            if label and label != "Unknown":
                row["region"] = label
                hits += 1
        if hits:
            table["regionSource"] = f"{side['regionSource']} (via {cand.name})"
            table["provenance"]["regionColumn"] = table["regionSource"]
            table["provenance"]["regionFile"] = cand.name
            if verbose:
                print(f"  [TRACKING] classification reprise de {cand.name} "
                      f"({hits}/{len(table['rows'])} spots)")
            return


def resolve(ims_path, workdir, dataset_name=None, verbose=True):
    """Return ``(container path, source, glb path)`` for a volume, or None if it has no tracking.

    A ``.imaris_track`` is used as it stands; the other two sources are converted into one,
    written under ``workdir`` so the dataset directory only ever receives what the importer
    puts there.
    """
    ims_path = Path(ims_path)
    dataset_name = dataset_name or ims_path.stem
    sources = discover(ims_path)
    if not sources:
        return None

    errors = []
    for source in sources:
        try:
            if source.kind == "container":
                if verbose:
                    print(f"  [TRACKING] source : {source.describe()}")
                return source.path, source, source.glb
            if verbose:
                print(f"  [TRACKING] source : {source.describe()}")
            table = read_source(source)
            if not table or not table.get("rows"):
                errors.append(f"{source.kind}: aucune donnee exploitable")
                continue
            if source.kind == "scene8":
                _merge_regions_from_excel(table, ims_path, verbose)
            for warning in table.get("warnings") or []:
                print(f"  [TRACKING] [!] {warning}")
            if verbose and table.get("regionSource"):
                print(f"  [TRACKING] classification : {table['regionSource']}")
            doc = build_container(table, dataset_name, verbose=verbose)
            out = write_container(doc, Path(workdir) / f"{dataset_name}{CONTAINER_SUFFIX}")
            return out, source, None
        except Exception as exc:
            errors.append(f"{source.kind}: {exc}")
            if verbose:
                print(f"  [TRACKING] [!] {source.kind} inutilisable : {exc}")

    if errors and verbose:
        print("  [TRACKING] [!] aucune source exploitable")
    return None


def materialize(path, workdir, dataset_name=None) -> Path:
    """Path to a ready-to-import container for an operator-designated file.

    A ``.imaris_track`` is handed back untouched; anything else is converted under ``workdir``.
    """
    path = Path(path)
    if path.suffix.lower() == CONTAINER_SUFFIX:
        return path
    dataset_name = dataset_name or path.stem
    doc = load_document(path)
    return write_container(doc, Path(workdir) / f"{dataset_name}{CONTAINER_SUFFIX}")


def load_document(path) -> dict:
    """Read any supported tracking input into an IMARIS_TRACKER_V1 document."""
    path = Path(path)
    if path.suffix.lower() == CONTAINER_SUFFIX:
        with gzip.open(str(path), "rb") as fh:
            blob = fh.read()
        if blob.startswith(SIGNATURE.encode()):
            blob = blob[blob.index(b"\n") + 1:]
        return json.loads(blob.decode("utf-8"))

    if path.suffix.lower() == ".ims":
        table = read_scene8(path)
        if not table:
            raise ValueError(f"{path.name}: aucun objet de tracking dans Scene8")
        _merge_regions_from_excel(table, path, verbose=True)
    elif path.suffix.lower() in EXCEL_SUFFIXES:
        table = read_excel(path)
    else:
        raise ValueError(f"{path.name}: format non supporte "
                         f"(.imaris_track, .ims, {', '.join(EXCEL_SUFFIXES)})")

    for warning in table.get("warnings") or []:
        print(f"[TRACKING] [!] {warning}")
    return build_container(table, path.stem)


def main():
    ap = argparse.ArgumentParser(
        description="Detecte et normalise l'analyse de tracking associee a un volume Imaris.")
    ap.add_argument("input", help=".ims, .xls/.xlsx ou .imaris_track")
    ap.add_argument("--list", action="store_true",
                    help="lister les sources detectees sans rien convertir")
    ap.add_argument("--out", default=None,
                    help="ecrire le conteneur .imaris_track normalise a ce chemin")
    args = ap.parse_args()

    path = Path(args.input)
    if args.list:
        sources = discover(path)
        if not sources:
            print("Aucune source de tracking detectee.")
            return 1
        for i, source in enumerate(sources, 1):
            print(f"  {i}. {source.describe()}")
        return 0

    doc = load_document(path)
    data = doc["data"]
    print(f"cellules   : {len(data['cells'])}")
    print(f"timepoints : {len(data['timepoints'])} ({data['timepoints'][0]:g}..{data['timepoints'][-1]:g})")
    prov = data.get("provenance") or {}
    if prov:
        print("provenance : " + ", ".join(f"{k}={v}" for k, v in prov.items()))
    if args.out:
        write_container(doc, args.out)
        print(f"ecrit      : {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
