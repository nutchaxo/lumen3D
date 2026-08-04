#!/usr/bin/env python3
"""Generate the demo inputs shipped inside the downloadable pipeline bundle.

The bundle has to be runnable the moment it is unzipped, on a machine that has
never seen lab data. That means it must carry a valid input for BOTH pipelines:

    examples/ims/<name>.ims                     -> preprocess (Imaris HDF5 volume)
    examples/tracking/<sample>/<...>30min<...>.xlsx  -> tracking (Imaris Excel export)

Both are synthesised from ONE simulated embryo, so the demo is coherent: the
nuclei burned into the .ims volume sit exactly where the tracking spreadsheet
says the cells are, and both cover the same four timepoints. A technician can
therefore run the volume pipeline, run the tracking pipeline, and attach the
result with ``5-tracking_importer.py`` without supplying anything of their own.

The output is committed under ``preprocess/examples/``: a deployed host (shared
PHP, no Python, no h5py) could never generate it on demand, and ``preprocess/``
is outside the release allowlist so the fixtures cost a release nothing — the
finished bundle that build_pipeline_bundle.py assembles from them is what ships.

Usage:
    python tools/gen_pipeline_examples.py [--out preprocess/examples]
"""

import argparse
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]

# The dataset name is parsed by 4-catalog_generator.py, so it has to satisfy two
# regexes that are easy to get wrong:
#   stage  -(E(\d(?:\.?\d+)?))($|-)  -> "-E85-" yields display "E8.5" / numeric 8.5.
#          "-E8-5-" would NOT: the digit group stops at "8" and the stage reads E8.
#   embryo -(Em\d+)-                 -> needs hyphens on BOTH sides, so a trailing
#          "-Em1" would silently produce no embryo id.
# The "30min" token is load-bearing for the OTHER pipeline: Analysis.py scrapes the
# frame interval out of the .xlsx filename with r'(\d+)min' and, when it finds
# nothing, blocks forever on an interactive input() prompt.
DATASET_NAME = "Demo-Lumen3D-E85-Em1-30min-2ch-4tp"
SAMPLE_NAME = "DEMO-E85-Em1"
XLSX_NAME = "Live-Demo-Lumen3D-E85-Em1-30min-Positions-Analysis.xlsx"

# Deliberately small: the point is a fast, complete round-trip, not realistic size.
# 96 keeps max(W,H) under the 256 floor of the LOD ladder in 2-image_processor.py,
# so only LOD 0 is generated and the demo finishes in seconds.
WIDTH, HEIGHT, DEPTH = 96, 96, 24
N_TIMEPOINTS = 4
VOXEL_UM = (2.0, 2.0, 4.0)          # anisotropic, as a real confocal stack is
CHANNEL_NAMES = ("DAPI", "Egfl7-eGFP")
FRAME_INTERVAL_MIN = 30             # must match the "30min" token above
ACQUISITION_START = datetime(2026, 5, 12, 9, 0, 0)

N_CELLS = 48
REGIONS = ("Anterior", "Posterior", "Lateral")
SEED = 20260512

# Imaris allocates track ids far above object ids so the two id spaces never collide —
# a real export shows spot 489179 inside track 1000489179. Scene8 label sets address
# objects by bare id, so reproducing that separation is what keeps the fixture honest.
TRACK_ID_BASE = 1_000_000_000


def _extent_um():
    """Physical bounds of the volume, in micrometres (the Imaris stage frame)."""
    return (WIDTH * VOXEL_UM[0], HEIGHT * VOXEL_UM[1], DEPTH * VOXEL_UM[2])


# ---------------------------------------------------------------------------
#  1. The simulated embryo — one source of truth for both outputs
# ---------------------------------------------------------------------------

def simulate_cells(rng):
    """Simulate N_CELLS nuclei over N_TIMEPOINTS, and return flat per-row records.

    The motion is deliberately built as (global rigid drift) ∘ (local wander) so the
    tracking pipeline has something real to do: its Kabsch stabilisation should
    recover and remove the rigid part, leaving only the local component. A tracking
    demo where every cell is static would exercise none of that.

    One track divides mid-sequence. Imaris does not start new tracks for the daughters:
    the track branches, so from the division onwards it holds two spots per timepoint —
    that shape, and not a change of TrackID, is what Analysis.py's mitosis detection
    keys on (verified against the lab's own exports).
    """
    ext_x, ext_y, ext_z = _extent_um()
    margin = 12.0

    # Cells are seeded on a hollow-ish ellipsoid shell so the population has an
    # actual surface for the reconstruction step to fit, rather than a point cloud.
    centre = np.array([ext_x / 2, ext_y / 2, ext_z / 2])
    radii = np.array([ext_x / 2 - margin, ext_y / 2 - margin, ext_z / 2 - margin])

    phi = rng.uniform(0, 2 * np.pi, N_CELLS)
    cos_theta = rng.uniform(-1, 1, N_CELLS)
    sin_theta = np.sqrt(1 - cos_theta ** 2)
    shell = 0.72 + 0.28 * rng.random(N_CELLS)        # thickness of the shell
    base = np.stack([
        centre[0] + radii[0] * shell * sin_theta * np.cos(phi),
        centre[1] + radii[1] * shell * sin_theta * np.sin(phi),
        centre[2] + radii[2] * shell * cos_theta,
    ], axis=1)

    regions = np.array([REGIONS[i % len(REGIONS)] for i in range(N_CELLS)])

    # Per-cell persistent drift direction: local motion has to be correlated in time,
    # otherwise the velocity/directionality metrics are pure noise.
    wander_dir = rng.normal(size=(N_CELLS, 3))
    wander_dir /= np.linalg.norm(wander_dir, axis=1, keepdims=True)
    wander_speed = rng.uniform(0.4, 1.6, (N_CELLS, 1))       # µm per frame

    dividing_cell = int(rng.integers(0, N_CELLS))
    division_t = N_TIMEPOINTS // 2

    records = []

    for t in range(N_TIMEPOINTS):
        # Global rigid motion of the whole specimen: a small yaw about Z plus a
        # translation. This is the component the stabilisation must cancel.
        angle = np.deg2rad(2.5 * t)
        drift = np.array([1.8 * t, -1.1 * t, 0.6 * t])
        rot = np.array([
            [np.cos(angle), -np.sin(angle), 0.0],
            [np.sin(angle), np.cos(angle), 0.0],
            [0.0, 0.0, 1.0],
        ])

        local = base + wander_dir * wander_speed * t
        local += rng.normal(scale=0.25, size=local.shape)     # measurement jitter
        world = (local - centre) @ rot.T + centre + drift

        for i in range(N_CELLS):
            x, y, z = world[i]
            # Imaris never reports an object outside the acquired stage volume.
            x = float(np.clip(x, 0.0, ext_x))
            y = float(np.clip(y, 0.0, ext_y))
            z = float(np.clip(z, 0.0, ext_z))

            if i == dividing_cell and t >= division_t:
                # The two daughters, offset symmetrically along the division axis, both
                # inside the mother's track.
                for d in range(2):
                    off = 3.5 * (1 if d == 0 else -1)
                    records.append({
                        "ID": len(records) + 1,
                        "TrackID": TRACK_ID_BASE + i + 1,
                        "Time": t + 1,          # Imaris timepoints are 1-based
                        "Position X": round(x + off, 4),
                        "Position Y": round(y + off * 0.4, 4),
                        "Position Z": round(z, 4),
                        "Region": regions[i],
                    })
                continue

            records.append({
                "ID": len(records) + 1,
                "TrackID": TRACK_ID_BASE + i + 1,
                "Time": t + 1,
                "Position X": round(x, 4),
                "Position Y": round(y, 4),
                "Position Z": round(z, 4),
                "Region": regions[i],
            })

    return records


# ---------------------------------------------------------------------------
#  2. The tracking input — an Imaris-style Excel export
# ---------------------------------------------------------------------------

def write_xlsx(records, path: Path):
    """Write the flat single-sheet table Analysis.py expects.

    Analysis.py reads it with a bare ``pd.read_excel(file)`` — first sheet, header on
    row 1, no skiprows — so this is the FLATTENED export, not Imaris's raw multi-sheet
    Statistics workbook with its preamble rows. The headers below are Imaris's own
    spellings; Analysis.py lowercases them and resolves them through its alias map
    ("Position X" -> x, "Time" -> timepoint, "ID" -> cell_id, "TrackID" -> track_id),
    so using them here also exercises that mapping.
    """
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Position"

    columns = ["ID", "TrackID", "Time", "Position X", "Position Y", "Position Z", "Region"]
    ws.append(columns)
    for rec in records:
        ws.append([rec[c] for c in columns])

    for idx, col in enumerate(columns, start=1):
        ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = max(12, len(col) + 4)

    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(path))
    return path


# ---------------------------------------------------------------------------
#  3. The preprocessing input — a minimal but valid Imaris .ims
# ---------------------------------------------------------------------------

def _imaris_attr(value: str):
    """Encode an attribute the way Imaris does: an array of single characters.

    Imaris does not store "96" as a string attribute, it stores it as a length-2
    array of |S1. 1-ims_metadata.py:attr_str handles bytes, ndarray-of-bytes and
    plain values alike, but writing the native shape is what makes this file
    genuinely representative rather than merely parseable by our own reader.

    frombuffer, not array(list(...)): iterating a bytes object yields ints, and
    numpy renders an int into an S1 slot as the FIRST DIGIT of its decimal form —
    "96" would silently become "55".
    """
    return np.frombuffer(str(value).encode("ascii"), dtype="S1")


def _render_volume(records, t_index, rng):
    """Rasterise one timepoint into (DAPI, GFP) uint16 volumes of shape (Z, Y, X)."""
    shape = (DEPTH, HEIGHT, WIDTH)
    dapi = np.zeros(shape, dtype=np.float32)
    gfp = np.zeros(shape, dtype=np.float32)

    zz, yy, xx = np.mgrid[0:DEPTH, 0:HEIGHT, 0:WIDTH].astype(np.float32)

    frame = [r for r in records if r["Time"] == t_index + 1]
    for rec in frame:
        # µm -> voxel indices. Anisotropic, so each axis divides by its own pitch.
        cx = rec["Position X"] / VOXEL_UM[0]
        cy = rec["Position Y"] / VOXEL_UM[1]
        cz = rec["Position Z"] / VOXEL_UM[2]

        # A nucleus is a small anisotropic gaussian; sigma_z is larger because the
        # axial PSF of a confocal is always worse than the lateral one.
        d2 = (((xx - cx) / 2.2) ** 2 + ((yy - cy) / 2.2) ** 2 + ((zz - cz) / 1.3) ** 2)
        blob = np.exp(-0.5 * d2)
        dapi += blob * rng.uniform(0.75, 1.0)

        # The reporter is expressed by roughly half the population, and brightly.
        if rec["TrackID"] % 2 == 0:
            gfp += blob * rng.uniform(0.6, 1.0)

    # A vessel-like tubular sheet gives channel 1 a connected structure rather than
    # isolated dots, so empty-space skipping in 3-chunk_packer.py keeps real bricks.
    wave = np.sin((xx / WIDTH) * 3.0 * np.pi + t_index * 0.35) * (HEIGHT * 0.18)
    tube = np.exp(-0.5 * (((yy - (HEIGHT / 2 + wave)) / 3.0) ** 2
                          + ((zz - DEPTH / 2) / 3.5) ** 2))
    gfp += tube * 0.55

    # Detector offset + shot noise. Without a non-zero floor the background
    # subtraction in 2-image_processor.py has nothing to estimate.
    dapi += rng.normal(loc=0.035, scale=0.012, size=shape)
    gfp += rng.normal(loc=0.030, scale=0.010, size=shape)

    def to_u16(arr):
        arr = np.clip(arr, 0.0, None)
        peak = float(arr.max()) or 1.0
        # Leave headroom below the 16-bit ceiling: a real acquisition is not
        # clipped at full scale, and window-levelling should have room to work.
        return (arr / peak * 52000.0).astype(np.uint16)

    return to_u16(dapi), to_u16(gfp)


def _write_scene8(f, records):
    """Write the same tracking a second time, as the Imaris objects Surpass would save.

    A real Imaris file carries its Spots and Tracks inside the volume, under Scene8, and
    the preprocessing pipeline reads them from there when no analysis sits beside the file.
    Reproducing that layout is what lets the shipped demo exercise the embedded-tracking
    path, not just the spreadsheet one.

    The layout is index-based throughout: SpotTimeOffset and Track0 hold half-open ranges
    of ROW POSITIONS into the Spot and TrackObject0 tables, never object ids — so the Spot
    table below is written grouped by timepoint, and TrackObject0 grouped by track.
    """
    import h5py

    times = sorted({int(r["Time"]) for r in records})
    by_time = {t: [r for r in records if int(r["Time"]) == t] for t in times}

    spot_rows, time_offsets, position = [], [], 0
    for frame, t in enumerate(times):
        for rec in by_time[t]:
            spot_rows.append((int(rec["ID"]), float(rec["Position X"]),
                              float(rec["Position Y"]), float(rec["Position Z"]), 3.0))
        # Imaris counts Scene8 frames from 0 while every statistics export counts from 1.
        time_offsets.append((frame, position, position + len(by_time[t])))
        position += len(by_time[t])

    time_of_spot = {int(r["ID"]): int(r["Time"]) for r in records}
    tracks = {}
    for rec in records:
        tracks.setdefault(int(rec["TrackID"]), []).append(int(rec["ID"]))

    track_rows, track_objects, track_edges = [], [], []
    for tid in sorted(tracks):
        members = sorted(tracks[tid], key=lambda sid: time_of_spot[sid])
        obj_begin, edge_begin = len(track_objects), len(track_edges)
        track_objects.extend((sid,) for sid in members)
        track_edges.extend((a, b) for a, b in zip(members, members[1:]))
        track_rows.append((tid, obj_begin, len(track_objects), edge_begin, len(track_edges)))

    region_of_spot = {int(r["ID"]): str(r["Region"]) for r in records}
    region_of_track = {tid: region_of_spot[sorted(m, key=lambda s: time_of_spot[s])[0]]
                       for tid, m in tracks.items()}

    # Both classification levels, as the lab's files carry them: one painting the spots,
    # one painting whole tracks. Labels of every group live in one flat LabelValues table
    # that LabelGroupNames closes with cumulative end offsets.
    groups = (("Point Locations", region_of_spot), ("Tracks Location", region_of_track))
    label_values, group_names, label_sets, set_label_ids, set_object_ids = [], [], [], [], []
    for gname, mapping in groups:
        for region in REGIONS:
            objects = sorted(obj for obj, value in mapping.items() if value == region)
            if not objects:
                continue
            set_label_ids.append((len(label_values),))
            set_object_ids.extend((obj,) for obj in objects)
            label_sets.append((len(set_label_ids), len(set_object_ids)))
            label_values.append((region.encode("ascii"),))
        group_names.append((gname.encode("ascii"), len(label_values)))

    points = f.create_group("Scene8/Content/Points0")
    f["Scene8/Content"].attrs["NumberOfPoints"] = np.int64(1)
    points.attrs["Name"] = _imaris_attr("Spots 1")
    points.attrs["CreatorName"] = _imaris_attr("Surpass")
    points.attrs["Unit"] = _imaris_attr("um")
    points.attrs["Id"] = np.int64(200001)

    def table(name, rows, dtype):
        points.create_dataset(name, data=np.array(rows, dtype=dtype))

    table("Spot", spot_rows, [("ID", "<i8"), ("PositionX", "<f4"), ("PositionY", "<f4"),
                              ("PositionZ", "<f4"), ("Radius", "<f4")])
    table("SpotTimeOffset", time_offsets,
          [("ID", "<i8"), ("IndexBegin", "<i8"), ("IndexEnd", "<i8")])
    table("Track0", track_rows,
          [("ID", "<i8"), ("IndexTrackObjectBegin", "<i8"), ("IndexTrackObjectEnd", "<i8"),
           ("IndexTrackEdgeBegin", "<i8"), ("IndexTrackEdgeEnd", "<i8")])
    table("TrackObject0", track_objects, [("ID_Object", "<i8")])
    table("TrackEdge0", track_edges, [("ID_ObjectA", "<i8"), ("ID_ObjectB", "<i8")])
    table("MainTrackTable", [(b"0", b"Track0", b"TrackObject0", b"TrackEdge0")],
          [("ObjectsName", "S256"), ("TrackName", "S256"),
           ("TrackObjectName", "S256"), ("TrackEdgeName", "S256")])
    table("LabelValues", label_values, [("LabelValue", "S256")])
    table("LabelGroupNames", group_names,
          [("LabelGroupName", "S256"), ("EndLabelValue", "<i8")])
    table("LabelSets", label_sets, [("EndLabelIDs", "<i8"), ("EndObjectIDs", "<i8")])
    table("LabelSetLabelIDs", set_label_ids, [("IDLabel", "<i8")])
    table("LabelSetObjectIDs", set_object_ids, [("IDObject", "<i8")])

    return len(spot_rows), len(track_rows)


def write_ims(records, path: Path):
    """Write the Imaris HDF5 container the preprocessing pipeline consumes.

    Only the subset the pipeline actually reads is populated — DataSetInfo/{Image,
    Channel i,TimeInfo}, a single ResolutionLevel 0, and the Scene8 objects the
    tracking step looks for. Imaris's own multi-resolution pyramid is ignored by the
    pipeline (it builds its own LODs), so synthesising it would be dead weight.
    """
    import h5py

    rng = np.random.default_rng(SEED + 1)
    ext_x, ext_y, ext_z = _extent_um()

    path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(str(path), "w") as f:
        info = f.create_group("DataSetInfo")

        image = info.create_group("Image")
        for key, value in (
            ("X", WIDTH), ("Y", HEIGHT), ("Z", DEPTH),
            ("ExtMin0", "0.000"), ("ExtMin1", "0.000"), ("ExtMin2", "0.000"),
            ("ExtMax0", f"{ext_x:.3f}"), ("ExtMax1", f"{ext_y:.3f}"), ("ExtMax2", f"{ext_z:.3f}"),
            ("Unit", "um"),
            ("Name", DATASET_NAME),
        ):
            image.attrs[key] = _imaris_attr(value)

        for c_idx, name in enumerate(CHANNEL_NAMES):
            ch = info.create_group(f"Channel {c_idx}")
            ch.attrs["Name"] = _imaris_attr(name)

        # Wall-clock per frame, 1-based, in Imaris's exact format. The pipeline takes
        # the median gap as the acquisition interval, so these must be consistent
        # with the "30min" promised by the filenames.
        time_info = info.create_group("TimeInfo")
        time_info.attrs["DatasetTimePoints"] = _imaris_attr(N_TIMEPOINTS)
        time_info.attrs["FileTimePoints"] = _imaris_attr(N_TIMEPOINTS)
        for t in range(N_TIMEPOINTS):
            stamp = ACQUISITION_START + timedelta(minutes=FRAME_INTERVAL_MIN * t)
            time_info.attrs[f"TimePoint{t + 1}"] = _imaris_attr(
                stamp.strftime("%Y-%m-%d %H:%M:%S.000"))

        res0 = f.create_group("DataSet/ResolutionLevel 0")
        for t in range(N_TIMEPOINTS):
            tp = res0.create_group(f"TimePoint {t}")
            dapi, gfp = _render_volume(records, t, rng)
            for c_idx, data in enumerate((dapi, gfp)):
                ch = tp.create_group(f"Channel {c_idx}")
                # gzip because the committed fixture rides in the git repo and in
                # every release artifact; synthetic data compresses ~10x.
                ch.create_dataset("Data", data=data, chunks=(min(16, DEPTH), 32, 32),
                                  compression="gzip", compression_opts=6)

        _write_scene8(f, records)
    return path


# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(REPO_ROOT / "preprocess" / "examples"),
                        help="destination directory for the generated fixtures")
    args = parser.parse_args()

    out = Path(args.out).resolve()
    rng = np.random.default_rng(SEED)

    print(f"[gen] simulating {N_CELLS} cells over {N_TIMEPOINTS} timepoints…")
    records = simulate_cells(rng)

    xlsx_path = out / "tracking" / SAMPLE_NAME / XLSX_NAME
    write_xlsx(records, xlsx_path)
    print(f"[gen] {xlsx_path.relative_to(out)}  ({len(records)} rows, "
          f"{xlsx_path.stat().st_size / 1024:.1f} KiB)")

    ims_path = out / "ims" / f"{DATASET_NAME}.ims"
    write_ims(records, ims_path)
    print(f"[gen] {ims_path.relative_to(out)}  ({WIDTH}x{HEIGHT}x{DEPTH}, "
          f"{len(CHANNEL_NAMES)} ch, {N_TIMEPOINTS} tp, "
          f"{ims_path.stat().st_size / 1024 / 1024:.2f} MiB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
