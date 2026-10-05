#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os
import sys
from pathlib import Path
import h5py
import numpy as np
from PIL import Image
from scipy.ndimage import median_filter, binary_opening, binary_dilation
from concurrent.futures import ProcessPoolExecutor
from tqdm import tqdm

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from run_preprocess import worker_count, thumbnail_lod, atomic_write_json  # noqa: E402
import bricks_v3_writer as v3  # noqa: E402

__version__ = "0.15.0"

# Dataset format the run produces: 4 (brick pyramid v3 + planes + layer MIPs, SPEC §12-13)
# by default; 2 (v2 bricks on the square 256·2^k ladder + planes) is kept for the
# migration tests, which build a format-2 dataset to migrate.
DEFAULT_DATASET_FORMAT = v3.FORMAT_VERSION

# How many timepoints are sampled to establish the shared window of a timelapse.
# Evenly spaced over the series and always including the first and the last frame.
GLOBAL_NORM_SAMPLES = 8

# ── Streaming geometry ─────────────────────────────────────────────────────────
# A channel is never held whole in memory. It is read from the .ims in tiles; each
# tile is levelled independently and written straight into the LOD0 file.
#
# Exactness of a tile against the whole-volume computation: every operation is local.
#   * the signal mask is binary_opening(iterations=1) — one erosion then one dilation —
#     followed by binary_dilation(iterations=3), all with the 6-connected cross. Each
#     erosion/dilation looks one voxel away, so a value computed at a tile edge that has
#     no real neighbours beyond it can be wrong there, and the error moves inward by one
#     voxel per operation: 1 + 1 + 3 = 5 voxels. A halo of MASK_HALO = 5 real voxels
#     around the core therefore yields the exact whole-volume mask inside the core;
#   * the 3x3x3 median reads one voxel away, which the same halo covers;
#   * window leveling is per voxel.
# At a face of the VOLUME the tile has no halo, its array edge is the volume edge, and
# scipy applies the same border rule it applies to the whole volume (border_value=0 for
# the morphology, 'reflect' for the median). The output is therefore byte-identical to
# levelling the whole channel at once, whatever the tiling.
MASK_HALO = 5
SUBSAMPLE_STEP = 4            # white point ranks vol[::4, ::4, ::4]
DEFAULT_TILE_MVOX = 24        # voxels per tile INCLUDING its halo, in millions

# Rough per-worker cost of a tile: the raw read (2 B for uint16), its float32 copy (4),
# the mask and its morphology temporaries (~3), the median, composite, clip and norm
# arrays (~16) — ~25 B per voxel, so the default tile costs ~600 MB per worker.


def _tile_budget() -> int:
    raw = os.environ.get("LUMEN_PREPROCESS_TILE_MVOX", "").strip()
    if raw:
        try:
            value = float(raw)
            if value > 0:
                return max(1, int(value * 1024 * 1024))
        except ValueError:
            pass
        print(f"[PROCESS] LUMEN_PREPROCESS_TILE_MVOX={raw!r} ignore (nombre > 0 attendu)", flush=True)
    return DEFAULT_TILE_MVOX * 1024 * 1024


def plan_tiles(shape, halo: int, budget: int):
    """Core boxes (z0, z1, y0, y1, x0, x1) covering the volume, each with its halo
    under `budget` voxels. Whole planes are preferred (one contiguous read per slab);
    Y then X are split only when a plane slab does not fit."""
    D, H, W = shape

    def cost(cz, cy, cx):
        return min(D, cz + 2 * halo) * min(H, cy + 2 * halo) * min(W, cx + 2 * halo)

    cz, cy, cx = min(D, 64), H, W
    while cost(cz, cy, cx) > budget:
        if cy >= cx and cy > 32:
            cy = -(-cy // 2)
        elif cx > 32:
            cx = -(-cx // 2)
        elif cz > 4:
            cz = -(-cz // 2)
        else:
            break
    return [(z, min(z + cz, D), y, min(y + cy, H), x, min(x + cx, W))
            for z in range(0, D, cz) for y in range(0, H, cy) for x in range(0, W, cx)]


def _halo_box(box, shape, halo):
    z0, z1, y0, y1, x0, x1 = box
    D, H, W = shape
    return (max(0, z0 - halo), min(D, z1 + halo), max(0, y0 - halo), min(H, y1 + halo),
            max(0, x0 - halo), min(W, x1 + halo))


def corner_boxes(shape):
    """The 8 corner cubes — pure camera background, no specimen there. Each is kept as
    its own box: when the volume is thinner than two cubes they overlap, and the
    whole-volume estimator counted those voxels once per cube."""
    D, H, W = shape
    cs = max(1, min(32, W // 4, H // 4, D // 4))
    zs = ((0, min(cs, D)), (max(0, D - cs), D))
    ys = ((0, min(cs, H)), (max(0, H - cs), H))
    xs = ((0, min(cs, W)), (max(0, W - cs), W))
    return [(z[0], z[1], y[0], y[1], x[0], x[1]) for z in zs for y in ys for x in xs]


def _intersect(a, b):
    box = (max(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), min(a[3], b[3]),
           max(a[4], b[4]), min(a[5], b[5]))
    return box if box[0] < box[1] and box[2] < box[3] and box[4] < box[5] else None


def _strided(block, origin):
    """The voxels of `block` (whose first voxel sits at volume index `origin`) that
    vol[::4, ::4, ::4] selects — the same lattice whatever the tiling."""
    z0, y0, x0 = origin
    s = SUBSAMPLE_STEP
    return block[(-z0) % s::s, (-y0) % s::s, (-x0) % s::s]


def subsample_size(shape) -> int:
    return math.prod(-(-n // SUBSAMPLE_STEP) for n in shape)


# ── Worker side ────────────────────────────────────────────────────────────────
# Workers read the .ims themselves (one open handle per process, reused across tiles)
# and write their output into the LOD files through memory maps, so nothing heavier
# than a tile box crosses a process pipe.
_H5_FILES = {}


def _h5_dataset(path: str, name: str):
    f = _H5_FILES.get(path)
    if f is None:
        # A larger chunk cache keeps a chunk decompressed while the neighbouring tile
        # rows of the same chunk are read.
        f = h5py.File(path, "r", rdcc_nbytes=64 * 1024 * 1024)
        _H5_FILES[path] = f
    return f[name]


def _close_h5_files():
    for f in _H5_FILES.values():
        try:
            f.close()
        except Exception:
            pass
    _H5_FILES.clear()


def sample_tile(args):
    """Pass 1 over one tile: its share of the white-point subsample and of the corner
    cubes, as float32 exactly as the whole-volume estimator saw them."""
    path, name, shape, box = args
    z0, z1, y0, y1, x0, x1 = box
    block = _h5_dataset(path, name)[z0:z1, y0:y1, x0:x1]
    sub = _strided(block, (z0, y0, x0)).astype(np.float32).ravel()
    corners = []
    for cb in corner_boxes(shape):
        part = _intersect(box, cb)
        if part is not None:
            corners.append(block[part[0] - z0:part[1] - z0, part[2] - y0:part[3] - y0,
                                 part[4] - x0:part[5] - x0].astype(np.float32).ravel())
    corner = np.concatenate(corners) if corners else np.empty(0, np.float32)
    return sub, corner


def level_tile(args):
    """Selective Masked Median Filtering + Window Leveling for one tile.

    Inside the signal mask the original (sharp) biological signal is kept as-is;
    outside the mask the background is replaced by a 3D median (size=3) that crushes
    shot-noise and isolated hot pixels without blurring the cells. Window Leveling then
    maps [bg_floor, sig_max] -> [0, 255] (uint8) — any value <= bg_floor collapses to an
    absolute 0, guaranteeing pure-black empty space for the SVR brick packer.

    The tile is read with its halo (see MASK_HALO) and only its core is written.
    Returns the number of masked voxels in the core and, when asked, the core's share
    of the white-point subsample.
    """
    (path, name, shape, box, bg_floor, sig_max, lod0_path, want_subsample) = args
    z0, z1, y0, y1, x0, x1 = box
    hz0, hz1, hy0, hy1, hx0, hx1 = _halo_box(box, shape, MASK_HALO)

    vol = _h5_dataset(path, name)[hz0:hz1, hy0:hy1, hx0:hx1].astype(np.float32)

    # Signal mask: threshold 10 % above the noise floor; a morphological opening drops
    # isolated hot pixels (so they get median-crushed below), then a 3-iteration
    # dilation guards the natural fluorescent fade-out around the biological signal so
    # the median filter never bites into cells.
    mask = np.greater(vol, bg_floor * 1.1)
    mask = binary_opening(mask, iterations=1)
    mask = binary_dilation(mask, iterations=3)

    cz0, cz1 = z0 - hz0, z1 - hz0
    cy0, cy1 = y0 - hy0, y1 - hy0
    cx0, cx1 = x0 - hx0, x1 - hx0
    core = (slice(cz0, cz1), slice(cy0, cy1), slice(cx0, cx1))

    # The median of a core voxel reads one voxel around it: filter the core plus that
    # ring only (clipped at the tile, which is the volume edge wherever no halo exists).
    mz0, my0, mx0 = max(0, cz0 - 1), max(0, cy0 - 1), max(0, cx0 - 1)
    ring = vol[mz0:min(vol.shape[0], cz1 + 1), my0:min(vol.shape[1], cy1 + 1),
               mx0:min(vol.shape[2], cx1 + 1)]
    smoothed = median_filter(ring, size=3)[cz0 - mz0:cz1 - mz0, cy0 - my0:cy1 - my0,
                                           cx0 - mx0:cx1 - mx0]
    block_data = vol[core]
    block_mask = mask[core]
    composite = np.where(block_mask, block_data, smoothed)

    if sig_max - bg_floor <= 0.0:
        sig_max = bg_floor + 1.0
    # Window Leveling [bg_floor, sig_max] -> [0, 255]
    clean = np.clip(composite, bg_floor, sig_max)
    norm = (clean - bg_floor) / (sig_max - bg_floor)
    block_u8 = (norm * 255.0).astype(np.uint8)

    out = np.memmap(lod0_path, dtype=np.uint8, mode="r+", shape=shape)
    try:
        out[z0:z1, y0:y1, x0:x1] = block_u8
        out.flush()
    finally:
        del out

    sub = _strided(block_data, (z0, y0, x0)).ravel().copy() if want_subsample else None
    return int(np.count_nonzero(block_mask)), sub


def downscale_planes(args):
    """Write planes [z0, z1) of every reduced LOD from the levelled LOD0 planes."""
    lod0_path, shape, z0, z1, targets = args
    D, H, W = shape
    src = np.memmap(lod0_path, dtype=np.uint8, mode="r", shape=shape)
    outs = [(w, h, np.memmap(p, dtype=np.uint8, mode="r+", shape=(D, h, w)))
            for (w, h, p) in targets]
    try:
        for z in range(z0, z1):
            pil_img = Image.fromarray(np.array(src[z]))
            for (w, h, dst) in outs:
                resized = pil_img.resize((w, h), Image.Resampling.BILINEAR)
                dst[z] = np.asarray(resized, dtype=np.uint8)
        for (_, _, dst) in outs:
            dst.flush()
    finally:
        del src
        outs.clear()
    return z1 - z0


# ── The 3-chunk_packer module, for packing each timepoint as soon as it is levelled ─
_PACKER = None


def _packer():
    global _PACKER
    if _PACKER is None:
        spec = importlib.util.spec_from_file_location("lumen_chunk_packer",
                                                      str(HERE / "3-chunk_packer.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _PACKER = module
    return _PACKER


# The packer's worker functions are reached through these module-level wrappers: a
# process pool can only call a function its workers can import by name, and this file
# is the one they import.
def encode_brick_batch(args):
    return _packer().encode_brick_batch(args)


def layer_max_grid(args):
    return _packer().layer_max_grid(args)


# ── Main side ──────────────────────────────────────────────────────────────────
def _run(executor, fn, tasks, desc):
    results = executor.map(fn, tasks) if executor is not None else map(fn, tasks)
    return list(tqdm(results, total=len(tasks), desc=desc, leave=False, ascii=True,
                     mininterval=2.0))


def sample_channel(executor, path, name, shape):
    """White-point subsample and corner samples of one channel volume, in one pass."""
    tiles = plan_tiles(shape, 0, _tile_budget())
    sub = np.empty(subsample_size(shape), dtype=np.float32)
    corners, cursor = [], 0
    for part, corner in _run(executor, sample_tile, [(path, name, shape, b) for b in tiles],
                             "Sampling"):
        sub[cursor:cursor + part.size] = part
        cursor += part.size
        corners.append(corner)
    return sub[:cursor], np.concatenate(corners)


def _estimate_global_bounds(executor, path, res0, tp_keys, c_idx, shape):
    """Shared [bg_floor, sig_max] window for one channel of a timelapse.

    Levelling each frame against its own percentiles makes the series flicker: as
    the specimen bleaches, a per-frame window keeps re-stretching a fading signal
    back to full range, so the apparent brightness stays constant while the real
    one collapses — visually wrong and quantitatively misleading. Pooling the
    corner noise and the sub-sampled signal over several frames yields ONE window,
    which is the same estimator the single-timepoint path uses, just evaluated on
    the pooled series. Frames then dim exactly as much as the specimen really did.
    """
    n_tp = len(tp_keys)
    count = min(GLOBAL_NORM_SAMPLES, n_tp)
    if count >= n_tp:
        sample_idx = list(range(n_tp))
    else:
        sample_idx = sorted({int(round(i * (n_tp - 1) / (count - 1))) for i in range(count)})

    corner_pool, signal_pool = [], []
    print(f"[PROCESS] Global normalization: sampling timepoints {sample_idx} for channel {c_idx}...",
          flush=True)
    for t_idx in sample_idx:
        ch_keys = sorted([k for k in res0[tp_keys[t_idx]].keys() if k.startswith("Channel")],
                         key=lambda x: int(x.split()[-1]))
        if c_idx >= len(ch_keys):
            continue
        name = res0[tp_keys[t_idx]][ch_keys[c_idx]]["Data"].name
        sub, corner = sample_channel(executor, path, name, shape)
        corner_pool.append(corner)
        signal_pool.append(sub)

    pooled = np.concatenate(signal_pool)
    bg_floor = float(np.percentile(np.concatenate(corner_pool), 99.0))

    # White point = "saturate the brightest 0.1 % OF THE SIGNAL", not of the volume.
    # The single-timepoint rule takes the 99.9th percentile of every voxel, which
    # assumes the specimen fills a good share of the frame. A timelapse of a sparse
    # fluorescent structure breaks that assumption: here the signal is 0.4 % of the
    # voxels, so a whole-volume percentile sits inside the background and clips 15 %
    # of the real signal to pure white. Ranking only the voxels above the noise floor
    # keeps the same intent and drops the clipped fraction to ~0.06 %.
    above = pooled[pooled > bg_floor]
    if above.size >= 1000:
        sig_max = float(np.percentile(above, 99.9))
        basis = f"{above.size} voxels above the noise floor"
    else:
        sig_max = float(np.percentile(pooled, 99.9))
        basis = "whole volume (too little signal to rank)"
    print(f"    global bg_floor={bg_floor:.2f}  sig_max={sig_max:.2f} "
          f"(pooled over {len(corner_pool)} timepoints, white point from {basis})", flush=True)
    _warn_window(bg_floor, sig_max, pooled)
    return bg_floor, sig_max


def _warn_window(bg_floor: float, sig_max: float, subsample) -> None:
    """Say so when the window is suspect. Nothing is changed: the window is what the
    estimator gives, and changing it silently would make two runs of one file differ."""
    if sig_max - bg_floor <= max(1.0, 0.01 * abs(bg_floor)):
        print(f"    [!] fenetre quasi nulle (sig_max - bg_floor = {sig_max - bg_floor:.3g}) : "
              f"signal tres epars, le volume sera presque binaire", flush=True)
    if subsample is not None and subsample.size:
        median = float(np.median(subsample))
        if bg_floor > median * 1.5 and bg_floor - median > 2.0:
            print(f"    [!] bruit des coins ({bg_floor:.2f}) bien au-dessus de la mediane du volume "
                  f"({median:.2f}) : un coin touche peut-etre l'echantillon (tuiles, rognage) "
                  f"et le signal faible sera coupe", flush=True)


def _allocate(path: Path, size: int) -> None:
    with open(path, "wb") as fh:
        fh.truncate(size)


def lod_ladder(W: int, H: int, D: int):
    """Format 2 (legacy): LOD0 at native size, then square 256·2^k levels below
    max(W, H), coarsest last, every level keeping all D planes."""
    lod_info = [{"lod": 0, "width": W, "height": H, "depth": D}]
    max_dim = max(W, H)
    target_dims = []
    curr_dim = 256
    while curr_dim < max_dim:
        target_dims.append(curr_dim)
        curr_dim *= 2
    target_dims.reverse()
    for lod, target_dim in enumerate(target_dims, start=1):
        lod_info.append({"lod": lod, "width": target_dim, "height": target_dim, "depth": D})
    return lod_info


def pyramid_levels(W: int, H: int, D: int, voxel_size):
    """Format-4 levels as LOD entries: level 0 native, then v3.level_ladder (X and Y
    halved, Z halved while that keeps the voxel from becoming coarser in Z than in XY)."""
    return [{"lod": lv["level"], "width": lv["dimensions"]["x"], "height": lv["dimensions"]["y"],
             "depth": lv["dimensions"]["z"], "voxelSize": lv["voxelSize"], "halveZ": lv["halveZ"]}
            for lv in v3.level_ladder((W, H, D), voxel_size)]


def reduce_levels(executor, temp_dir: Path, t_idx: int, c_idx: int, lod_info) -> None:
    """Levels 1… of one channel, each from the previous one (integer mean, half up), in
    z ranges over the pool: a worker holds two planes of the finer level at a time."""
    for prev, li in zip(lod_info, lod_info[1:]):
        src = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod{prev['lod']}.bin"
        dst = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod{li['lod']}.bin"
        src_shape = (prev["depth"], prev["height"], prev["width"])
        dst_shape = (li["depth"], li["height"], li["width"])
        _allocate(dst, li["depth"] * li["height"] * li["width"])
        step = max(1, -(-li["depth"] // (4 * worker_count())))
        _run(executor, v3.reduce_task,
             [(str(src), src_shape, str(dst), dst_shape, li["halveZ"], z, min(z + step, li["depth"]))
              for z in range(0, li["depth"], step)],
             f"Niveau {li['lod']} ({li['width']}x{li['height']}x{li['depth']})")


def process_channel(executor, path, name, shape, lod_info, temp_dir, t_idx, c_idx,
                    bounds=None, dataset_format=DEFAULT_DATASET_FORMAT):
    """Level one channel of one timepoint into its LOD files. `bounds` is the shared
    window of a timelapse; without it the window comes from this volume. Returns the
    99.9th percentile of the raw subsample (the frame's signal level)."""
    D, H, W = shape
    n_voxels = D * H * W
    want_subsample = bounds is not None

    # ─── Step 1 : Bound estimation (Corner Sampling) ──────────────────────
    # bg_floor = 99th percentile of the 8 volume corners (pure camera background,
    # no embryo there); sig_max = 99.9th percentile of the globally sub-sampled
    # volume (saturate the brightest 0.1 %).
    print("  Step 1: Estimation des bornes (Corner Sampling)...", flush=True)
    if bounds is None:
        sub, corner_data = sample_channel(executor, path, name, shape)
        bg_floor = float(np.percentile(corner_data, 99.0))
        print(f"    bg_floor (99e centile du bruit des coins): {bg_floor:.2f}", flush=True)
        frame_sig = float(np.percentile(sub, 99.9))
        sig_max = frame_sig
        print(f"    sig_max (99.9e centile global): {sig_max:.2f}", flush=True)
        _warn_window(bg_floor, sig_max, sub)
        del sub, corner_data
    else:
        bg_floor, sig_max = bounds

    # ─── Steps 2-3 : signal mask, masked median, window leveling, per tile ─
    print("  Step 2-3: Masque de signal + Masked Median Filtering + Window Leveling...",
          flush=True)
    lod0 = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod0.bin"
    _allocate(lod0, n_voxels)
    tiles = plan_tiles(shape, MASK_HALO, _tile_budget())
    tasks = [(path, name, shape, box, bg_floor, sig_max, str(lod0), want_subsample)
             for box in tiles]
    masked, parts = 0, []
    for count, part in _run(executor, level_tile, tasks, "Masked Median + Leveling"):
        masked += count
        if part is not None:
            parts.append(part)
    print(f"    Couverture du masque: {100.0 * masked / max(1, n_voxels):.2f}% des voxels",
          flush=True)
    if want_subsample:
        frame_sig = float(np.percentile(np.concatenate(parts), 99.9))
        print(f"    bornes globales: bg_floor={bg_floor:.2f} sig_max={sig_max:.2f} "
              f"(signal propre a cette frame: {frame_sig:.2f})", flush=True)
        del parts

    # ─── Step 4 : Exporting downscaled LOD levels ─────────────────────────
    print("  Step 4: Exporting downscaled LOD levels...", flush=True)
    if dataset_format >= v3.FORMAT_VERSION:
        reduce_levels(executor, temp_dir, t_idx, c_idx, lod_info)
        print(f"  Channel {c_idx} processed successfully.")
        return frame_sig
    targets = []
    for li in lod_info[1:]:
        p = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod{li['lod']}.bin"
        _allocate(p, li["width"] * li["height"] * D)
        targets.append((li["width"], li["height"], str(p)))
    if targets:
        step = max(1, -(-D // (4 * worker_count())))
        _run(executor, downscale_planes,
             [(str(lod0), shape, z, min(z + step, D), targets) for z in range(0, D, step)],
             "Exporting LODs")
    print(f"  Channel {c_idx} processed successfully.")
    return frame_sig


def _drop_packed_files(temp_dir: Path, t_idx: int, n_ch: int, lod_info) -> None:
    """Once a timepoint is in its packs only two of its LOD files are still read: the
    coarsest one (histograms, step 3) and, for the first frame, the thumbnail level."""
    keep = {lod_info[-1]["lod"]}
    if t_idx == 0:
        keep.add(thumbnail_lod(lod_info))
    for c_idx in range(n_ch):
        for li in lod_info:
            if li["lod"] in keep:
                continue
            p = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod{li['lod']}.bin"
            try:
                p.unlink()
            except FileNotFoundError:
                pass
            except PermissionError:
                print(f"[PROCESS] {p.name} encore ouvert, supprime en fin de traitement", flush=True)


def process_image(input_ims: Path, metadata_json: Path, temp_dir: Path, pack_into: Path = None,
                  executor=None, dataset_format: int = DEFAULT_DATASET_FORMAT):
    """Level every (timepoint, channel) of an .ims into temp LOD files.

    With `pack_into` (a dataset directory) each timepoint is packed into its bricks/ as
    soon as all its channels are levelled, and its LOD files are deleted: the temporary
    disk then holds one frame at a time instead of the whole acquisition. `executor`
    defaults to one process pool for the whole run.
    """
    with open(metadata_json, "r", encoding="utf-8") as f:
        meta = json.load(f)

    W, H, D = meta["width"], meta["height"], meta["depth"]
    n_ch = meta["n_channels"]
    n_tp = meta["n_timepoints"]
    shape = (D, H, W)
    temp_dir.mkdir(parents=True, exist_ok=True)
    path = str(input_ims)

    v4 = dataset_format >= v3.FORMAT_VERSION
    lod_info = pyramid_levels(W, H, D, meta.get("voxel_size")) if v4 else lod_ladder(W, H, D)
    print(f"[PROCESS] LOD levels to generate: {len(lod_info)} (dataset format {dataset_format})")
    for li in lod_info:
        print(f"  LOD {li['lod']}: {li['width']}x{li['height']}x{li['depth']}")

    own_pool = executor is None
    if own_pool:
        executor = ProcessPoolExecutor(max_workers=worker_count())

    f_ims = h5py.File(path, "r")
    try:
        res0 = f_ims["DataSet"]["ResolutionLevel 0"]
        tp_keys = sorted([k for k in res0.keys() if k.startswith("TimePoint")],
                         key=lambda x: int(x.split()[-1]))

        # A timelapse is levelled against ONE window per channel (see
        # _estimate_global_bounds); a single-timepoint dataset keeps the historical
        # per-volume estimate so previously published datasets reprocess identically.
        is_timelapse = n_tp > 1
        global_bounds = {}
        if is_timelapse:
            for c_idx in range(n_ch):
                global_bounds[c_idx] = _estimate_global_bounds(executor, path, res0, tp_keys,
                                                               c_idx, shape)

        # Per-(timepoint, channel) brightness of the RAW signal, recorded but never
        # baked into the voxels: bleaching correction stays a reversible display choice.
        signal_levels = {}
        bricks_dir = Path(pack_into) / "bricks" if pack_into else None

        for t_idx, tp_key in enumerate(tp_keys):
            ch_keys = sorted([k for k in res0[tp_key].keys() if k.startswith("Channel")],
                             key=lambda x: int(x.split()[-1]))
            for c_idx, ch_key in enumerate(ch_keys):
                print(f"[PROCESS] Processing Channel {c_idx} (T {t_idx})...", flush=True)
                name = res0[tp_key][ch_key]["Data"].name
                frame_sig = process_channel(executor, path, name, shape, lod_info, temp_dir,
                                            t_idx, c_idx, global_bounds.get(c_idx),
                                            dataset_format)
                signal_levels[f"t{t_idx:03d}_c{c_idx}"] = round(frame_sig, 4)

            if bricks_dir is not None:
                key = f"t{t_idx:03d}" if is_timelapse else ""
                if v4:
                    packed = _packer().pack_timepoint_v3(temp_dir, bricks_dir, t_idx, lod_info,
                                                         n_ch, executor, key)
                else:
                    levels, transport = _packer().pack_timepoint(
                        temp_dir, bricks_dir, t_idx, lod_info, n_ch, executor, key,
                        encode_fn=encode_brick_batch, layer_fn=layer_max_grid)
                    packed = {"levels": levels, "brickTransport": transport}
                atomic_write_json(temp_dir / f"pack_t{t_idx:03d}.json", packed,
                                  separators=(",", ":"))
                _drop_packed_files(temp_dir, t_idx, n_ch, lod_info)
    finally:
        f_ims.close()
        _close_h5_files()
        if own_pool:
            executor.shutdown()

    # Save the LOD info for next step
    atomic_write_json(temp_dir / "processing_meta.json", {
        "lod_levels": lod_info,
        "voxel_size": meta["voxel_size"],
        "channel_names": meta["channel_names"],
        "width": W,
        "height": H,
        "depth": D,
        "n_channels": n_ch,
        "n_timepoints": n_tp,
        "datasetFormat": dataset_format,
        "extent": meta.get("extent"),
        "timestamps": meta.get("timestamps"),
        "time_interval_minutes": meta.get("time_interval_minutes"),
        "normalization": {
            "mode": "global" if is_timelapse else "per-volume",
            "bounds": {f"c{c}": {"bgFloor": round(b[0], 4), "sigMax": round(b[1], 4)}
                       for c, b in global_bounds.items()},
            "signalLevels": signal_levels
        }
    }, indent=2)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Level an .ims into temporary LOD volumes.")
    ap.add_argument("input_ims")
    ap.add_argument("metadata_json")
    ap.add_argument("temp_dir")
    ap.add_argument("--pack-into", default=None,
                    help="dataset directory: pack each timepoint into its bricks/ as soon as "
                         "it is levelled, then delete its temporary LOD files")
    ap.add_argument("--format", type=int, choices=(2, 4), default=DEFAULT_DATASET_FORMAT,
                    help="dataset format to produce (default 4; 2 = the legacy v2 bricks)")
    args = ap.parse_args()

    try:
        process_image(Path(args.input_ims), Path(args.metadata_json), Path(args.temp_dir),
                      Path(args.pack_into) if args.pack_into else None,
                      dataset_format=args.format)
        print(f"[PROCESS] Image processing complete.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] Image processing failed: {e}", file=sys.stderr)
        sys.exit(1)
