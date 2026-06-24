#!/usr/bin/env python3
import argparse
import fnmatch
import json
import os
import shutil
import signal
import subprocess
import sys
import traceback
from datetime import datetime
from pathlib import Path
import numpy as np
from PIL import Image

__version__ = "0.14.0"

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_EXE = sys.executable

# ── Console styling (graceful ANSI; degrades to plain on redirect / no-VT) ──────
def _supports_color() -> bool:
    if not sys.stdout.isatty():
        return False
    if os.name == "nt":
        try:
            import ctypes
            k = ctypes.windll.kernel32
            h = k.GetStdHandle(-11)
            mode = ctypes.c_uint32()
            if not k.GetConsoleMode(h, ctypes.byref(mode)):
                return False
            k.SetConsoleMode(h, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
        except Exception:
            return False
    return True

_COLOR = _supports_color()

def _style(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text

def _hdr(s):  return _style("1;96", s)   # bold cyan
def _ok(s):   return _style("92", s)     # green
def _err(s):  return _style("91", s)     # red
def _warn(s): return _style("93", s)     # yellow
def _dim(s):  return _style("90", s)     # grey

# ── Graceful interruption (Ctrl+C) ──────────────────────────────────────────────
# Each step runs in its OWN process group, so a console Ctrl+C is NOT delivered to
# the child directly. The orchestrator intercepts SIGINT, asks the user to confirm,
# and only then tears the running step (and the worker pool it spawned) down.
# Declining the prompt resumes the step transparently — it never received the signal.
if os.name == "nt":
    _STEP_SPAWN = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
else:
    _STEP_SPAWN = {"start_new_session": True}

_current_proc = None    # Popen of the step currently running (or None)
_confirming = False     # re-entrancy guard for the confirmation prompt


def _kill_tree(proc) -> None:
    """Terminate a step process and every worker it spawned (ProcessPoolExecutor)."""
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        pass
    try:
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _install_sigint_handler() -> None:
    """On Ctrl+C, ask for confirmation. Confirm -> abort cleanly; decline -> resume."""
    def _handler(signum, frame):
        global _confirming
        if _confirming:
            # A second Ctrl+C while the prompt is up means: stop now, for sure.
            raise KeyboardInterrupt
        _confirming = True
        try:
            sys.stderr.write("\n")
            try:
                answer = input(_warn("[!] Arreter le pipeline en cours ? ") +
                               "Les fichiers temporaires seront nettoyes. [o/N] ")
            except EOFError:
                answer = "o"   # non-interactive stdin: cannot ask -> stop
        finally:
            _confirming = False
        if answer.strip().lower() in ("o", "oui", "y", "yes"):
            raise KeyboardInterrupt
        print(_dim("    reprise du traitement..."))
    signal.signal(signal.SIGINT, _handler)

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
    global _current_proc
    cmd = [PYTHON_EXE, str(SCRIPT_DIR / script_name), *args]
    print(_dim(f"   - {script_name}"))
    proc = subprocess.Popen(cmd, **_STEP_SPAWN)
    _current_proc = proc
    try:
        ret = proc.wait()
    except KeyboardInterrupt:
        # Confirmed abort during this step: tear down the step and its worker pool.
        _kill_tree(proc)
        raise
    finally:
        _current_proc = None
    if ret != 0:
        raise subprocess.CalledProcessError(ret, cmd)

def process_ims_file(ims_path: Path, output_root: Path, idx: int = 0, total: int = 0) -> None:
    dataset_name = ims_path.stem
    counter = f"[{idx}/{total}] " if total else ""
    print()
    print(_hdr(f">> {counter}{dataset_name}"))
    print(_dim(f"   source : {ims_path}"))
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
        print(_ok(f"   [OK] {dataset_name} termine en {elapsed:.0f}s"))
    except Exception as e:
        print(_err(f"   [X] {dataset_name} : {e}"), file=sys.stderr)
        traceback.print_exc()
    finally:
        # Clean up temporary processing binary files to free space.
        # ignore_errors: on a Ctrl+C teardown a just-killed worker may still hold a
        # handle for a few ms — never let cleanup mask the interruption.
        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)

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
        print(_warn(f"Aucun fichier .ims correspondant dans {input_dir}"))
        sys.exit(0)

    print()
    print(_hdr("  Pipeline de preprocessing  ") + _dim(f"v{__version__}"))
    print(_dim(f"  source      : {input_dir}"))
    print(_dim(f"  destination : {output_dir}"))
    print(_dim(f"  datasets    : {len(ims_files)}   (filtre: {args.only or '*'})"))

    # Graceful Ctrl+C: confirm with the user, then tear the running step down cleanly.
    _install_sigint_handler()

    # One dataset at a time (bounded RAM) — each step already multithreads internally.
    interrupted = False
    for i, ims_file in enumerate(ims_files):
        try:
            process_ims_file(ims_file, output_dir, i + 1, len(ims_files))
        except KeyboardInterrupt:
            interrupted = True
            break
        except Exception as exc:
            print(_err(f"   [X] {ims_file.name} : {exc}"))

    if interrupted:
        # Remove any half-written temp folder left by the aborted dataset.
        for stray in output_dir.glob(".temp_preprocess_*"):
            shutil.rmtree(stray, ignore_errors=True)
        print()
        print(_warn("  Pipeline interrompu par l'utilisateur (Ctrl+C). Etat nettoye."))
        sys.exit(130)

    print()
    print(_ok("  Pipeline termine."))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        # Ctrl+C confirmed outside a dataset (e.g. between steps) — exit cleanly.
        print(_warn("\n[!] Pipeline arrete."), file=sys.stderr)
        sys.exit(130)
