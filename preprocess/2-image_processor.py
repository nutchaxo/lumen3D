#!/usr/bin/env python3
import json
import sys
from pathlib import Path
import h5py
import numpy as np
from PIL import Image
from scipy.ndimage import median_filter, binary_opening, binary_dilation
from concurrent.futures import ProcessPoolExecutor
from contextlib import ExitStack
from multiprocessing import shared_memory
import os
from tqdm import tqdm

__version__ = "0.14.0"

# How many timepoints are sampled to establish the shared window of a timelapse.
# Evenly spaced over the series and always including the first and the last frame.
GLOBAL_NORM_SAMPLES = 8


def _corner_samples(vol, W, H, D):
    """The 8 corner cubes — pure camera background, no specimen there."""
    corner_size = max(1, min(32, W // 4, H // 4, D // 4))
    corners = [
        vol[:corner_size, :corner_size, :corner_size],
        vol[:corner_size, :corner_size, -corner_size:],
        vol[:corner_size, -corner_size:, :corner_size],
        vol[:corner_size, -corner_size:, -corner_size:],
        vol[-corner_size:, :corner_size, :corner_size],
        vol[-corner_size:, :corner_size, -corner_size:],
        vol[-corner_size:, -corner_size:, :corner_size],
        vol[-corner_size:, -corner_size:, -corner_size:]
    ]
    return np.concatenate([c.flatten() for c in corners])


def _estimate_global_bounds(res0, tp_keys, c_idx, W, H, D):
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
        vol = res0[tp_keys[t_idx]][ch_keys[c_idx]]["Data"][:D, :H, :W].astype(np.float32)
        corner_pool.append(_corner_samples(vol, W, H, D))
        signal_pool.append(vol[::4, ::4, ::4].flatten())
        del vol

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
    return bg_floor, sig_max

def process_z_block(args):
    """Selective Masked Median Filtering + Window Leveling for one Z-block.

    Inside the signal mask the original (sharp) biological signal is kept as-is;
    outside the mask the background is replaced by a 3D median (size=3) that
    crushes shot-noise and isolated hot pixels without blurring the cells. The
    block carries a ±1 Z halo so the median sees real neighbours across block
    seams; the halo is stripped before writing back. Finally a Window Leveling maps
    [bg_floor, sig_max] -> [0, 255] (uint8) — any value <= bg_floor collapses to
    an absolute 0, guaranteeing pure-black empty space for the SVR brick packer.

    The volume, the mask and the output buffer live in shared memory: the worker
    receives only names and indices. Shipping the blocks themselves through the
    process pool moved ~285 MB per timepoint across Windows pipes and exhausted the
    OS ("WinError 1450: insufficient system resources") the moment the pipeline had
    more than one frame to grind through.
    """
    (vol_name, mask_name, out_name, shape, z_start, z_end,
     halo_lo, halo_hi, bg_floor, sig_max) = args

    vol_shm = shared_memory.SharedMemory(name=vol_name)
    mask_shm = shared_memory.SharedMemory(name=mask_name)
    out_shm = shared_memory.SharedMemory(name=out_name)
    try:
        vol = np.ndarray(shape, dtype=np.float32, buffer=vol_shm.buf)
        mask = np.ndarray(shape, dtype=bool, buffer=mask_shm.buf)
        out = np.ndarray(shape, dtype=np.uint8, buffer=out_shm.buf)

        if sig_max - bg_floor <= 0.0:
            sig_max = bg_floor + 1.0

        zs, ze = z_start - halo_lo, z_end + halo_hi
        block_data = vol[zs:ze]
        block_mask = mask[zs:ze]

        # Masked compositing: keep signal inside the mask, smooth the rest
        smoothed = median_filter(block_data, size=3)
        composite = np.where(block_mask, block_data, smoothed)

        # Window Leveling [bg_floor, sig_max] -> [0, 255]
        clean = np.clip(composite, bg_floor, sig_max)
        norm = (clean - bg_floor) / (sig_max - bg_floor)
        block_u8 = (norm * 255.0).astype(np.uint8)

        # Strip the Z halo before reassembly
        z_hi = block_u8.shape[0] - halo_hi
        out[z_start:z_end] = block_u8[halo_lo:z_hi]
        return z_start
    finally:
        vol_shm.close()
        mask_shm.close()
        out_shm.close()

def process_image(input_ims: Path, metadata_json: Path, temp_dir: Path):
    with open(metadata_json, "r", encoding="utf-8") as f:
        meta = json.load(f)
        
    W, H, D = meta["width"], meta["height"], meta["depth"]
    n_ch = meta["n_channels"]
    n_tp = meta["n_timepoints"]
    
    temp_dir.mkdir(parents=True, exist_ok=True)
    
    # Open IMS file
    f_ims = h5py.File(str(input_ims), "r")
    res0 = f_ims["DataSet"]["ResolutionLevel 0"]
    tp_keys = sorted([k for k in res0.keys() if k.startswith("TimePoint")], key=lambda x: int(x.split()[-1]))
    
    # We will save downscaled shapes in processing_meta.json
    lod_info = []
    
    # Determine downscaling LOD levels
    lod = 0
    lod_info.append({
        "lod": lod,
        "width": W,
        "height": H,
        "depth": D
    })
    
    max_dim = max(W, H)
    target_dims = []
    curr_dim = 256
    while curr_dim < max_dim:
        target_dims.append(curr_dim)
        curr_dim *= 2
        
    target_dims.reverse()
    
    for target_dim in target_dims:
        lod += 1
        lod_info.append({
            "lod": lod,
            "width": target_dim,
            "height": target_dim,
            "depth": D
        })
        
    print(f"[PROCESS] LOD levels to generate: {len(lod_info)}")
    for li in lod_info:
        print(f"  LOD {li['lod']}: {li['width']}x{li['height']}x{li['depth']}")

    # A timelapse is levelled against ONE window per channel (see
    # _estimate_global_bounds); a single-timepoint dataset keeps the historical
    # per-volume estimate so previously published datasets reprocess identically.
    is_timelapse = n_tp > 1
    global_bounds = {}
    if is_timelapse:
        for c_idx in range(n_ch):
            global_bounds[c_idx] = _estimate_global_bounds(res0, tp_keys, c_idx, W, H, D)

    # Per-(timepoint, channel) brightness of the RAW signal, recorded but never
    # baked into the voxels: bleaching correction stays a reversible display choice.
    signal_levels = {}

    shape = (D, H, W)
    n_voxels = D * H * W

    for t_idx, tp_key in enumerate(tp_keys):
        ch_keys = sorted([k for k in res0[tp_key].keys() if k.startswith("Channel")], key=lambda x: int(x.split()[-1]))

        for c_idx, ch_key in enumerate(ch_keys):
          print(f"[PROCESS] Processing Channel {c_idx} (T {t_idx})...", flush=True)
          ds = res0[tp_key][ch_key]["Data"]

          # The volume, its mask and the levelled output are allocated in shared
          # memory so the worker pool addresses them by name instead of pickling
          # slices across process pipes (see process_z_block).
          with ExitStack() as stack:
            vol_shm = shared_memory.SharedMemory(create=True, size=n_voxels * 4)
            mask_shm = shared_memory.SharedMemory(create=True, size=n_voxels)
            out_shm = shared_memory.SharedMemory(create=True, size=n_voxels)
            # ExitStack unwinds LIFO, so registering unlink before close before the pool
            # tears down in the only order that is safe: workers gone, then views closed,
            # then the blocks released. (SharedMemory is not a context manager before 3.13.)
            for shm in (vol_shm, mask_shm, out_shm):
                stack.callback(shm.unlink)
            for shm in (vol_shm, mask_shm, out_shm):
                stack.callback(shm.close)
            executor = stack.enter_context(ProcessPoolExecutor(max_workers=os.cpu_count()))

            vol = np.ndarray(shape, dtype=np.float32, buffer=vol_shm.buf)
            mask = np.ndarray(shape, dtype=bool, buffer=mask_shm.buf)
            vol_u8 = np.ndarray(shape, dtype=np.uint8, buffer=out_shm.buf)

            print(f"  Loading 3D volume ({W}x{H}x{D}) in memory as Float32...", flush=True)
            # Read entire volume directly to allow h5py C-core to optimize chunk reads
            # Extremely fast compared to reading slice-by-slice in Python
            vol[:] = ds[:D, :H, :W]

            # ─── Step 1 : Bound estimation (Corner Sampling) ──────────────────
            # bg_floor = 99th percentile of the 8 volume corners (pure camera
            # background, no embryo there); sig_max = 99.9th percentile of the
            # globally sub-sampled volume (saturate the brightest 0.1 %).
            print("  Step 1: Estimation des bornes (Corner Sampling)...", flush=True)
            down_vol = vol[::4, ::4, ::4]
            frame_sig = float(np.percentile(down_vol, 99.9))
            if is_timelapse:
                bg_floor, sig_max = global_bounds[c_idx]
                print(f"    bornes globales: bg_floor={bg_floor:.2f} sig_max={sig_max:.2f} "
                      f"(signal propre a cette frame: {frame_sig:.2f})", flush=True)
            else:
                corner_data = _corner_samples(vol, W, H, D)
                bg_floor = float(np.percentile(corner_data, 99.0))
                print(f"    bg_floor (99e centile du bruit des coins): {bg_floor:.2f}", flush=True)
                sig_max = frame_sig
                print(f"    sig_max (99.9e centile global): {sig_max:.2f}", flush=True)
            signal_levels[f"t{t_idx:03d}_c{c_idx}"] = round(frame_sig, 4)
            del down_vol

            # ─── Step 2 : Signal mask ─────────────────────────────────────────
            # Threshold 10 % above the noise floor; a morphological opening drops
            # isolated hot pixels (so they get median-crushed below), then a
            # 3-iteration dilation guards the natural fluorescent fade-out around
            # the biological signal so the median filter never bites into cells.
            print("  Step 2: Construction du masque de signal...", flush=True)
            np.greater(vol, bg_floor * 1.1, out=mask)
            mask[:] = binary_opening(mask, iterations=1)
            mask[:] = binary_dilation(mask, iterations=3)
            print(f"    Couverture du masque: {100.0 * mask.mean():.2f}% des voxels", flush=True)

            # ─── Step 3 : Masked median filtering + Window Leveling ───────────
            # Parallel over Z-blocks; each block carries a ±1 Z halo for the
            # 3D median so there is no seam between blocks.
            print("  Step 3: Masked Median Filtering + Window Leveling...", flush=True)
            z_chunk_size = max(4, D // (os.cpu_count() * 2))
            tasks = []
            for z_start in range(0, D, z_chunk_size):
                z_end = min(z_start + z_chunk_size, D)
                halo_lo = 1 if z_start > 0 else 0
                halo_hi = 1 if z_end < D else 0
                tasks.append((vol_shm.name, mask_shm.name, out_shm.name, shape,
                              z_start, z_end, halo_lo, halo_hi, bg_floor, sig_max))

            for _ in tqdm(executor.map(process_z_block, tasks), total=len(tasks),
                          desc="Masked Median + Leveling", leave=False, ascii=True, mininterval=2.0):
                pass

            # ─── Step 4 : Exporting downscaled LOD levels ─────────────────────
            print("  Step 4: Exporting downscaled LOD levels...", flush=True)
            lod_files = {}
            for li in lod_info:
                lod_num = li["lod"]
                lod_file = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod{lod_num}.bin"
                lod_files[lod_num] = open(lod_file, "wb")

            for z in tqdm(range(D), desc="Exporting LODs", leave=False, ascii=True, mininterval=2.0):
                slice_u8 = vol_u8[z]
                # Write native LOD0
                lod_files[0].write(slice_u8.tobytes())
                # Write downscaled LODs
                pil_img = Image.fromarray(slice_u8, mode="L")
                for li in lod_info[1:]:
                    lod_num = li["lod"]
                    resized = pil_img.resize((li["width"], li["height"]), Image.Resampling.BILINEAR)
                    resized_arr = np.asarray(resized, dtype=np.uint8)
                    lod_files[lod_num].write(resized_arr.tobytes())

            # Close all file handles
            for f_handle in lod_files.values():
                f_handle.close()
            # vol / mask / vol_u8 are views on the shared blocks; ExitStack closes and
            # unlinks them as the `with` unwinds. Drop the views first so no numpy
            # object still references a buffer that is about to be released.
            del vol, mask, vol_u8
            print(f"  Channel {c_idx} processed successfully.")

    f_ims.close()
    
    # Save the LOD info for next step
    with open(temp_dir / "processing_meta.json", "w", encoding="utf-8") as fm:
        json.dump({
            "lod_levels": lod_info,
            "voxel_size": meta["voxel_size"],
            "channel_names": meta["channel_names"],
            "width": W,
            "height": H,
            "depth": D,
            "n_channels": n_ch,
            "n_timepoints": n_tp,
            "extent": meta.get("extent"),
            "timestamps": meta.get("timestamps"),
            "time_interval_minutes": meta.get("time_interval_minutes"),
            "normalization": {
                "mode": "global" if is_timelapse else "per-volume",
                "bounds": {f"c{c}": {"bgFloor": round(b[0], 4), "sigMax": round(b[1], 4)}
                           for c, b in global_bounds.items()},
                "signalLevels": signal_levels
            }
        }, fm, indent=2)

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python 2-image_processor.py <input_ims> <metadata_json> <temp_dir>")
        sys.exit(1)
        
    input_ims = Path(sys.argv[1])
    metadata_json = Path(sys.argv[2])
    temp_dir = Path(sys.argv[3])
    
    try:
        process_image(input_ims, metadata_json, temp_dir)
        print(f"[PROCESS] Image processing complete.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] Image processing failed: {e}", file=sys.stderr)
        sys.exit(1)
