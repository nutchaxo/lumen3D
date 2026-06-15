#!/usr/bin/env python3
import json
import math
import sys
import gzip
import hashlib
from pathlib import Path
import numpy as np
from PIL import Image
import io
from concurrent.futures import ProcessPoolExecutor
import os

def process_chunk(args):
    chunk_data, ch_meta, BRICK_SIZE = args
    non_zero = np.count_nonzero(chunk_data)
    valid_voxels = max(1, ch_meta["validVoxelCount"])
    occ = float(non_zero) / float(valid_voxels)
    
    is_non_empty = occ > 0.0005
    if not is_non_empty:
        return (ch_meta["idx"], occ, False, None)
        
    padded = np.zeros((BRICK_SIZE, BRICK_SIZE, BRICK_SIZE), dtype=np.uint8)
    d, h, w = chunk_data.shape
    padded[:d, :h, :w] = chunk_data
    
    mosaic = np.zeros((512, 512), dtype=np.uint8)
    for z in range(64):
        row = z // 8
        col = z % 8
        mosaic[row*64:(row+1)*64, col*64:(col+1)*64] = padded[z]
        
    img = Image.fromarray(mosaic)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", lossless=True)
    return (ch_meta["idx"], occ, True, buf.getvalue())

def build_packs(temp_dir: Path, output_dir: Path):
    with open(temp_dir / "processing_meta.json", "r", encoding="utf-8") as fm:
        proc_meta = json.load(fm)
        
    lod_levels = proc_meta["lod_levels"]
    n_ch = proc_meta["n_channels"]
    n_tp = proc_meta["n_timepoints"]
    voxel_size = proc_meta["voxel_size"]
    channel_names = proc_meta["channel_names"]
    
    bricks_dir = output_dir / "bricks"
    bricks_dir.mkdir(parents=True, exist_ok=True)
    
    # Grid configuration
    BRICK_SIZE = 64
    CHUNKS_PER_PACK = 128
    
    brick_to_pack = {}
    pack_hashes = {}
    levels_manifest = []
    
    # Process each LOD
    for li in lod_levels:
        lod_num = li["lod"]
        W, H, D = li["width"], li["height"], li["depth"]
        
        nx = math.ceil(W / BRICK_SIZE)
        ny = math.ceil(H / BRICK_SIZE)
        nz = math.ceil(D / BRICK_SIZE)
        
        # Build logical grid of chunks for this level
        chunks_grid = []
        for bz in range(nz):
            for by in range(ny):
                for bx in range(nx):
                    ox, oy, oz = bx * BRICK_SIZE, by * BRICK_SIZE, bz * BRICK_SIZE
                    ew = min(BRICK_SIZE, W - ox)
                    eh = min(BRICK_SIZE, H - oy)
                    ed = min(BRICK_SIZE, D - oz)
                    chunks_grid.append({
                        "bx": bx,
                        "by": by,
                        "bz": bz,
                        "min": [int(ox), int(oy), int(oz)],
                        "max": [int(ox + ew), int(oy + eh), int(oz + ed)],
                        "validVoxelCount": int(ew * eh * ed)
                    })
                    
        BACKGROUND_THRESHOLD = 0
        is_core = [False] * len(chunks_grid)
        for c_idx in range(n_ch):
            t_idx = 0
            bin_file = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod{lod_num}.bin"
            if not bin_file.exists():
                continue
            volume_data = np.memmap(
                str(bin_file),
                dtype=np.uint8,
                mode="r",
                shape=(D, H, W)
            )
            for i, ch in enumerate(chunks_grid):
                ox, oy, oz = ch["min"]
                ex, ey, ez = ch["max"]
                chunk_slice = volume_data[oz:ez, oy:ey, ox:ex]
                if chunk_slice.size > 0:
                    if np.max(chunk_slice) > BACKGROUND_THRESHOLD:
                        is_core[i] = True
            del volume_data

        core_coords = set()
        for i, ch in enumerate(chunks_grid):
            if is_core[i]:
                core_coords.add((ch["bx"], ch["by"], ch["bz"]))

        active_coords = set()
        for (bx, by, bz) in core_coords:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        nx_coord = bx + dx
                        ny_coord = by + dy
                        nz_coord = bz + dz
                        if 0 <= nx_coord < nx and 0 <= ny_coord < ny and 0 <= nz_coord < nz:
                            active_coords.add((nx_coord, ny_coord, nz_coord))

        active_chunks_grid = [ch for ch in chunks_grid if (ch["bx"], ch["by"], ch["bz"]) in active_coords]
        print(f"[PACKER] LOD {lod_num}: Grid {nx}x{ny}x{nz} ({len(chunks_grid)} chunks, {len(active_chunks_grid)} active after thresholding)")

        # We will track occupancy union across all channels for the active chunk grid
        occupancy_union = [0.0] * len(active_chunks_grid)
        
        # For each channel, open the processed raw binary volume
        for c_idx in range(n_ch):
            # Since n_tp = 1 by default for fixed datasets, we just do t=0
            t_idx = 0
            bin_file = temp_dir / f"t{t_idx:03d}_c{c_idx}_lod{lod_num}.bin"
            
            if not bin_file.exists():
                print(f"[WARNING] Processed file not found: {bin_file}")
                continue
                
            # Memory map the volume
            volume_data = np.memmap(
                str(bin_file),
                dtype=np.uint8,
                mode="r",
                shape=(D, H, W)
            )
            
            # Setup packer for this LOD + Channel
            channel_lod_dir = bricks_dir / f"lod{lod_num}" / f"c{c_idx}"
            channel_lod_dir.mkdir(parents=True, exist_ok=True)
            
            current_pack_idx = 0
            current_pack_file = None
            current_pack_offset = 0
            chunks_in_current_pack = 0
            
            def get_pack_file(idx):
                p_file = channel_lod_dir / f"pack_{idx:02d}.bin"
                return p_file, open(p_file, "wb")

            pack_file_path, current_pack_file = get_pack_file(current_pack_idx)
            
            # Prepare arguments for multiprocessing
            tasks = []
            for i, ch in enumerate(active_chunks_grid):
                ch_meta = {"idx": i, "bx": ch["bx"], "by": ch["by"], "bz": ch["bz"], "validVoxelCount": ch["validVoxelCount"]}
                ox, oy, oz = ch["min"]
                ex, ey, ez = ch["max"]
                chunk_data = np.copy(volume_data[oz:ez, oy:ey, ox:ex])
                tasks.append((chunk_data, ch_meta, BRICK_SIZE))
                
            from tqdm import tqdm
            with ProcessPoolExecutor(max_workers=os.cpu_count()) as executor:
                # We use executor.map to maintain the order of active_chunks_grid
                for result in tqdm(executor.map(process_chunk, tasks), total=len(tasks), desc="Compressing WebP", leave=False, ascii=True, mininterval=2.0):
                    idx, occ, is_non_empty, compressed_bytes = result
                    occupancy_union[idx] = max(occupancy_union[idx], occ)
                    
                    if is_non_empty:
                        # Check if we need to roll over to a new pack file
                        if chunks_in_current_pack >= CHUNKS_PER_PACK:
                            current_pack_file.close()
                            # Record hash of completed pack
                            pack_rel_path = pack_file_path.relative_to(bricks_dir).as_posix()
                            pack_hashes[pack_rel_path] = hashlib.sha256(pack_file_path.read_bytes()).hexdigest()
                            
                            current_pack_idx += 1
                            pack_file_path, current_pack_file = get_pack_file(current_pack_idx)
                            current_pack_offset = 0
                            chunks_in_current_pack = 0
                            
                        # Write compressed bytes to current pack file
                        current_pack_file.write(compressed_bytes)
                        
                        # Save mapping in brickToPack
                        ch = active_chunks_grid[idx]
                        bx, by, bz = ch["bx"], ch["by"], ch["bz"]
                        brick_rel_key = f"lod{lod_num}/c{c_idx}/x{bx:03d}_y{by:03d}_z{bz:03d}.webp"
                        pack_rel_path = pack_file_path.relative_to(bricks_dir).as_posix()
                        
                        brick_to_pack[brick_rel_key] = {
                            "url": pack_rel_path,
                            "offset": int(current_pack_offset),
                            "length": int(len(compressed_bytes))
                        }
                        
                        current_pack_offset += len(compressed_bytes)
                        chunks_in_current_pack += 1
            
            # Close the final pack file for this channel
            if current_pack_file:
                current_pack_file.close()
                pack_rel_path = pack_file_path.relative_to(bricks_dir).as_posix()
                pack_hashes[pack_rel_path] = hashlib.sha256(pack_file_path.read_bytes()).hexdigest()
                
            # Close memmap file handle
            del volume_data
            
        # Build level chunks list for manifest
        manifest_chunks = []
        non_empty_count = 0
        for i, ch in enumerate(active_chunks_grid):
            is_non_empty = occupancy_union[i] > 0.0005
            if is_non_empty:
                non_empty_count += 1
            manifest_chunks.append({
                "id": f"{ch['bz']}_{ch['by']}_{ch['bx']}",
                "min": ch["min"],
                "max": ch["max"],
                "occupiedRatio": round(occupancy_union[i], 6),
                "nonEmpty": is_non_empty
            })
            
        levels_manifest.append({
            "level": lod_num,
            "scale": 1.0 / (2 ** lod_num),
            "dimensions": {"x": W, "y": H, "z": D},
            "brickSize": BRICK_SIZE,
            "gridSize": {"x": nx, "y": ny, "z": nz},
            "brickCount": len(chunks_grid),
            "chunks": manifest_chunks,
            "nonEmptyCount": non_empty_count
        })

    # Assemble and write manifest.json
    manifest = {
        "version": 2,
        "schema": "iribhm-bricks-v2",
        "dataset": output_dir.name,
        "datasetType": "fixed",
        "channels": n_ch,
        "brickSize": BRICK_SIZE,
        "brickPacking": {"mode": "grid", "cols": 8, "rows": 8},
        "voxelSize": voxel_size,
        "createdAt": __import__("datetime").datetime.now().isoformat(),
        "levels": levels_manifest,
        "histograms": [], # Will be populated by step 4 or dynamic scan
        "hashes": {},     # Left empty as we use pack transport
        "timepoints": None,
        "brickTransport": {
            "mode": "packs",
            "encoding": "webp-lossless",
            "packSize": CHUNKS_PER_PACK,
            "brickToPack": brick_to_pack,
            "packHashes": pack_hashes
        }
    }
    
    with open(bricks_dir / "manifest.json", "w", encoding="utf-8") as fm:
        json.dump(manifest, fm, indent=2)
        
    print(f"[PACKER] Wrote manifest.json to {bricks_dir / 'manifest.json'}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python 3-chunk_packer.py <temp_dir> <output_dir>")
        sys.exit(1)
        
    temp_dir = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    
    try:
        build_packs(temp_dir, output_dir)
        print(f"[PACKER] Chunk packaging complete.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[ERROR] Chunk packaging failed: {e}", file=sys.stderr)
        sys.exit(1)
