#!/usr/bin/env python3
import json
import sys
from pathlib import Path
import h5py
import numpy as np
from PIL import Image
from skimage.restoration import estimate_sigma
from skimage.filters import threshold_otsu
from skimage.morphology import disk
from scipy.ndimage import binary_fill_holes, binary_closing, binary_dilation, gaussian_filter
import scipy.ndimage
from concurrent.futures import ProcessPoolExecutor
import os
from tqdm import tqdm

def process_z_block(args):
    z_start, z_end, block_data, bg_floor, sig_max = args
    
    # Min-Max Scaling directly from [bg_floor, sig_max] to [0, 255]
    if sig_max - bg_floor <= 0.0:
        sig_max = bg_floor + 1.0
        
    clean_16b = np.clip(block_data, bg_floor, sig_max)
    norm = (clean_16b - bg_floor) / (sig_max - bg_floor)
    block_u8 = (norm * 255.0).astype(np.uint8)
    return z_start, block_u8

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

    for t_idx, tp_key in enumerate(tp_keys):
        ch_keys = sorted([k for k in res0[tp_key].keys() if k.startswith("Channel")], key=lambda x: int(x.split()[-1]))
        
        for c_idx, ch_key in enumerate(ch_keys):
            print(f"[PROCESS] Processing Channel {c_idx} (T {t_idx})...", flush=True)
            ds = res0[tp_key][ch_key]["Data"]
            
            print(f"  Loading 3D volume ({W}x{H}x{D}) in memory as Float32...", flush=True)
            # Read entire volume directly to allow h5py C-core to optimize chunk reads
            # Extremely fast compared to reading slice-by-slice in Python
            vol = ds[:D, :H, :W].astype(np.float32)

            # Étape 1 : Estimation des bornes (16-bits)
            print("  Step 1: Estimation des bornes (Corner Sampling)...", flush=True)
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
            corner_data = np.concatenate([c.flatten() for c in corners])
            bg_floor = float(np.percentile(corner_data, 50.0))
            print(f"    bg_floor (Bruit de fond médian des coins): {bg_floor:.2f}", flush=True)
            
            print("  Step 2: Estimating global sig_max...", flush=True)
            # Utiliser une version sous-échantillonnée pour la vitesse
            down_vol = vol[::4, ::4, ::4]
            sig_max = float(np.percentile(down_vol, 99.9))
            del down_vol
            print(f"    sig_max (Signal max 99.9ème centile global): {sig_max:.2f}", flush=True)
            
            print("  Step 3: Multithreaded Normalization...", flush=True)
            vol_u8 = np.zeros((D, H, W), dtype=np.uint8)
            # Pas de overlap nécessaire car pas de filtre médian
            z_chunk_size = max(4, D // (os.cpu_count() * 2))
            tasks = []
            for z_start in range(0, D, z_chunk_size):
                z_end = min(z_start + z_chunk_size, D)
                block_data = np.copy(vol[z_start:z_end])
                tasks.append((z_start, z_end, block_data, bg_floor, sig_max))
                
            with ProcessPoolExecutor(max_workers=os.cpu_count()) as executor:
                for result in tqdm(executor.map(process_z_block, tasks), total=len(tasks), desc="Normalizing Z-Blocks", leave=False, ascii=True, mininterval=2.0):
                    z_start_res, block_u8 = result
                    z_end_res = z_start_res + block_u8.shape[0]
                    vol_u8[z_start_res:z_end_res] = block_u8
                    
            del vol

            # 6. Step 5: Exporting downscaled LOD levels
            print("  Step 5: Exporting downscaled LOD levels...", flush=True)
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
            del vol_u8
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
            "n_timepoints": n_tp
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
