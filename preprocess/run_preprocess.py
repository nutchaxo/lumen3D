#!/usr/bin/env python3
import argparse
import fnmatch
import json
import os
import shutil
import sys
import traceback
from datetime import datetime
from pathlib import Path
import numpy as np
from PIL import Image

__version__ = "0.13.0"

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_EXE = sys.executable

# Hex colors to RGB mapping for composite thumbnail (matches channel colors)
THUMB_COLORS = [
    (0, 255, 102),    # green
    (255, 61, 255),   # magenta
    (47, 107, 255),   # blue
    (255, 48, 48),    # red
    (255, 255, 0),    # yellow
    (255, 0, 255),    # purple
    (0, 255, 255)     # cyan
]

def build_thumbnail(temp_dir: Path, output_dir: Path, proc_meta: dict) -> None:
    """
    Computes a Maximum Intensity Projection (MIP) for each channel from processed
    low-res volumes and composites them into a stunning false-color RGB thumbnail.
    """
    n_ch = proc_meta["n_channels"]
    lod_levels = proc_meta["lod_levels"]
    D = proc_meta["depth"]
    
    # We use LOD1 or LOD2 to speed up MIP computation (max 512/1024 width)
    target_lod = 0
    for li in lod_levels:
        if max(li["width"], li["height"]) <= 1024:
            target_lod = li["lod"]
            break
            
    li = lod_levels[target_lod]
    w_lod, h_lod = li["width"], li["height"]
    
    mips = []
    for c in range(n_ch):
        bin_file = temp_dir / f"t000_c{c}_lod{target_lod}.bin"
        if not bin_file.exists():
            continue
        # Load processed volume
        vol = np.fromfile(str(bin_file), dtype=np.uint8).reshape((D, h_lod, w_lod))
        # Compute Maximum Intensity Projection along Z axis
        mip = vol.max(axis=0)
        mips.append(mip)
        
    if not mips:
        print("[THUMBNAIL] Warning: No channel binary files found to build thumbnail.")
        return

    # Composite MIPs into false-color RGB
    composite = np.zeros((h_lod, w_lod, 3), dtype=np.float32)
    for i, mip in enumerate(mips):
        r, g, b = THUMB_COLORS[i % len(THUMB_COLORS)]
        norm = mip.astype(np.float32) / 255.0
        composite[:, :, 0] += norm * r
        composite[:, :, 1] += norm * g
        composite[:, :, 2] += norm * b

    composite = np.clip(composite, 0, 255).astype(np.uint8)
    img = Image.fromarray(composite, mode="RGB")
    
    # Resize to 512x512 preserving aspect ratio
    THUMB_SIZE = 512
    scale = THUMB_SIZE / max(w_lod, h_lod)
    new_w, new_h = max(1, round(w_lod * scale)), max(1, round(h_lod * scale))
    img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    
    # Pad to square with dark background (#080a12)
    out = Image.new("RGB", (THUMB_SIZE, THUMB_SIZE), (8, 10, 18))
    off_x = (THUMB_SIZE - new_w) // 2
    off_y = (THUMB_SIZE - new_h) // 2
    out.paste(img, (off_x, off_y))
    
    thumb_path = output_dir / "thumbnail.webp"
    out.save(str(thumb_path), "WEBP", quality=88, method=6)
    print(f"[THUMBNAIL] Wrote thumbnail to {thumb_path}")

def run_step(script_name: str, *args) -> None:
    import subprocess
    cmd = [PYTHON_EXE, str(SCRIPT_DIR / script_name), *args]
    print(f"\n[RUNNING] {' '.join(cmd)}")
    subprocess.run(cmd, check=True)

def process_ims_file(ims_path: Path, output_root: Path) -> None:
    dataset_name = ims_path.stem
    print(f"\n" + "=" * 80)
    print(f"[START] Processing dataset: {dataset_name}")
    print(f"  Source : {ims_path}")
    t0 = datetime.now()
    
    # Setup directories
    temp_dir = output_root / f".temp_preprocess_{dataset_name}"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True, exist_ok=True)
    
    # Target fixed dataset dir
    dataset_output_dir = output_root / "fixed" / dataset_name
    if dataset_output_dir.exists():
        bricks_dir = dataset_output_dir / "bricks"
        if bricks_dir.exists():
            shutil.rmtree(bricks_dir)
    dataset_output_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        # Step 1: Extraction of metadata
        temp_meta_json = temp_dir / "meta.json"
        run_step("1-ims_metadata.py", str(ims_path), str(temp_meta_json))
        
        # Step 2: Normalization, Background subtraction, Downscaling
        run_step("2-image_processor.py", str(ims_path), str(temp_meta_json), str(temp_dir))
        
        # Step 3: Compute thumbnail MIP
        with open(temp_dir / "processing_meta.json", "r", encoding="utf-8") as fm:
            proc_meta = json.load(fm)
        build_thumbnail(temp_dir, dataset_output_dir, proc_meta)
        
        # Step 4: Chunking 64³ & Pack building
        run_step("3-chunk_packer.py", str(temp_dir), str(dataset_output_dir))
        
        # Step 5: Catalog metadata (dataset.json / metadata.json)
        run_step("4-catalog_generator.py", str(temp_dir), str(dataset_output_dir))
        
        elapsed = (datetime.now() - t0).total_seconds()
        print(f"[SUCCESS] Dataset {dataset_name} finished in {elapsed:.0f}s!")
    except Exception as e:
        print(f"[ERROR] Failed to process dataset {dataset_name}: {e}", file=sys.stderr)
        traceback.print_exc()
    finally:
        # Clean up temporary processing binary files to free space
        if temp_dir.exists():
            shutil.rmtree(temp_dir)

def main():
    parser = argparse.ArgumentParser(description="IRIBHM Microscopy Preprocessing Unified Pipeline")
    parser.add_argument("--input", required=True, help="Input directory containing raw .ims files.")
    parser.add_argument("--output", required=True, help="Output DATA_WEB directory of the web platform.")
    parser.add_argument("--only", default=None, help="Glob pattern to filter files to process (e.g. '*E8*').")
    args = parser.parse_args()

    input_dir = Path(args.input)
    output_dir = Path(args.output)

    if not input_dir.is_dir():
        sys.exit(f"[FATAL] Input directory not found: {input_dir}")
        
    output_dir.mkdir(parents=True, exist_ok=True)

    # Glob IMS files
    ims_files = sorted(input_dir.glob("*.ims"))
    if args.only:
        ims_files = [p for p in ims_files if fnmatch.fnmatch(p.name, args.only)]

    if not ims_files:
        print(f"No matching .ims files found in {input_dir}")
        sys.exit(0)

    print("=" * 80)
    print(f" IRIBHM MICROSCOPY PREPROCESSING PIPELINE (v{__version__})")
    print(f" Source   : {input_dir}")
    print(f" Destination : {output_dir}")
    print(f" Matching : {args.only or '*'}")
    print(f" Found files: {len(ims_files)}")
    print("=" * 80)

    print("=" * 80)

    from concurrent.futures import ThreadPoolExecutor, as_completed
    
    max_workers = 1 # Process 1 dataset at a time to save RAM, heavily multithread inner processes
    print(f"\n[MULTITHREADING] Starting ThreadPoolExecutor with max_workers={max_workers}\n")
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_ims = {executor.submit(process_ims_file, ims_file, output_dir): ims_file for ims_file in ims_files}
        
        for i, future in enumerate(as_completed(future_to_ims)):
            ims_file = future_to_ims[future]
            try:
                future.result()
                print(f"[PROGRESS] Completed dataset {i+1}/{len(ims_files)}: {ims_file.name}")
            except Exception as exc:
                print(f"[ERROR] Dataset {ims_file.name} generated an exception: {exc}")

    print("\n" + "=" * 80)
    print(" Pipeline execution complete!")
    print("=" * 80)

if __name__ == "__main__":
    main()
