#!/usr/bin/env python3
import argparse
import fnmatch
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

__version__ = "0.19.0"

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_EXE = sys.executable


# ── Shared pipeline helpers ────────────────────────────────────────────────────
# The numbered steps and the 2D importer import these from here rather than from a
# module of their own: every way the pipeline is distributed (the repository, the
# self-contained .bat launcher, the downloadable pipeline pack) ships this file beside
# the steps, so a helper living here can never be missing where a step runs.

# Windows' WaitForMultipleObjects caps a ProcessPoolExecutor at 61 workers; asking for
# more raises ValueError before a single task runs.
_WINDOWS_MAX_WORKERS = 61


def worker_count() -> int:
    """Size of a step's process pool.

    One worker per logical core saturates the CPU, but each worker also holds its own
    working set (a tile of the volume being levelled, a batch of bricks being encoded).
    Commit on Windows is bounded by RAM + page file, not by free RAM: the measured
    failure was 3789x3789x125x4ch on a 63.5 GiB machine with 36.3 GiB of commit free,
    where the pool died with WinError 1455 "the paging file is too small".

    LUMEN_PREPROCESS_WORKERS caps the pool so a busy or smaller machine can still finish.
    Unset, one worker per logical core (61 at most on Windows).
    """
    cores = os.cpu_count() or 1
    ceiling = min(cores, _WINDOWS_MAX_WORKERS) if os.name == "nt" else cores
    raw = os.environ.get("LUMEN_PREPROCESS_WORKERS", "").strip()
    if raw:
        try:
            n = int(raw)
            if n >= 1:
                return min(n, ceiling)
            print(f"[PROCESS] LUMEN_PREPROCESS_WORKERS={raw!r} ignore (doit etre >= 1)", flush=True)
        except ValueError:
            print(f"[PROCESS] LUMEN_PREPROCESS_WORKERS={raw!r} ignore (entier attendu)", flush=True)
    return ceiling


def _retry_os(action, attempts: int = 40, delay: float = 0.1):
    """Run a rename/replace, retrying while Windows reports the target busy.

    The web server opens metadata.json and pack files for reading without
    FILE_SHARE_DELETE, so replacing or renaming them fails for the few milliseconds
    a request holds them. That is a wait, not an error.
    """
    for attempt in range(attempts):
        try:
            return action()
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)


def atomic_write_bytes(path, data: bytes) -> None:
    """Write a file so a reader sees either the old content or the new one, never a
    truncated mix: the bytes go to a temporary sibling, are flushed to disk, and
    replace the target in one rename."""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        _retry_os(lambda: os.replace(tmp, path))
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def atomic_write_text(path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def atomic_write_json(path, obj, **dump_kwargs) -> None:
    atomic_write_text(path, json.dumps(obj, **dump_kwargs))


# Keys the lab edits in the admin panel (or attaches afterwards). Re-processing a
# dataset refreshes what the acquisition measures and leaves these alone; one list for
# the volume pipeline and the 2D importer so both paths protect the same curation.
CURATED_KEYS = (
    "name", "description", "stage", "stageNumeric", "embryo", "line", "staining",
    "reporter", "hidden", "gallery", "tags", "notes", "created",
    "orientation", "orientationAxes", "upsideDown", "defaultView", "exposure",
    "linkedTrackingId", "relatedIds",
)


def merge_curated(existing: dict, fresh: dict) -> dict:
    """Metadata for a re-processed dataset: what the file measures comes from `fresh`,
    every curated key from `existing`, and any key `fresh` does not produce at all
    (added by the admin panel or a later step, e.g. a tracking block) is carried over
    rather than dropped. A hidden dataset therefore stays hidden."""
    if not isinstance(existing, dict) or not existing:
        return dict(fresh)
    merged = dict(fresh)
    for key in CURATED_KEYS:
        if key in existing:
            merged[key] = existing[key]
    for key, value in existing.items():
        if key not in merged:
            merged[key] = value
    if "lastModified" in fresh:
        merged["lastModified"] = fresh["lastModified"]
    return merged


def read_json_file(path) -> dict:
    """A JSON object from disk, or {} when the file is absent or unreadable. utf-8-sig
    tolerates the BOM a hand edit in Notepad leaves behind."""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def slugify(text: str) -> str:
    """A folder name that survives a URL unescaped: `#` would truncate it, `%` would be
    decoded, `?`/`+`/spaces/non-ASCII depend on who encodes them, and Windows strips a
    trailing dot or space."""
    return re.sub(r"-{2,}", "-", re.sub(r"[^A-Za-z0-9._-]+", "-", text)).strip("-.")


def thumbnail_lod(lod_levels) -> int:
    """The finest LOD whose long side is at most 1024 px — what the thumbnail MIP reads."""
    for li in lod_levels:
        if max(li["width"], li["height"]) <= 1024:
            return li["lod"]
    return 0


def load_step(script_name: str, module_name: str):
    """Import a numbered step (its file name is not a Python identifier) as a module."""
    spec = importlib.util.spec_from_file_location(module_name, str(SCRIPT_DIR / script_name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

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
    import numpy as np
    from PIL import Image

    n_ch = proc_meta["n_channels"]
    lod_levels = proc_meta["lod_levels"]
    D = proc_meta["depth"]

    # A LOD of at most 1024 px keeps the MIP cheap; step 2 keeps exactly this level of
    # the first timepoint on disk for it.
    target_lod = thumbnail_lod(lod_levels)
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

def run_script(script_path, *args, label=None) -> None:
    global _current_proc
    cmd = [PYTHON_EXE, str(script_path), *args]
    print(_dim(f"   - {label or Path(script_path).name}"))
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


def run_step(script_name: str, *args) -> None:
    run_script(SCRIPT_DIR / script_name, *args)


def attach_tracking(ims_path: Path, dataset_output_dir: Path, temp_dir: Path,
                    dataset_name: str, mode: str) -> None:
    """Find this volume's cell-tracking analysis and attach it to the dataset.

    The analysis reaches us in one of three shapes — a .imaris_track container, the Imaris
    objects still inside the .ims, or the statistics workbook exported beside it — so the
    volume is not the operator's problem: whichever exists is found and normalised. A
    synthesised container is written to the temp directory, never to the dataset, so the
    published tree only ever receives what the importer puts there.

    A failure here never fails the volume: the dataset is already complete and usable, the
    tracking is an overlay on top of it.
    """
    if mode == "off":
        return
    if not (SCRIPT_DIR / "tracking_sources.py").exists():
        print(_warn("   [!] tracking ignore : tracking_sources.py absent de cette installation "
                    "du pipeline — le timelapse est publie sans trajectoires"))
        return
    try:
        import tracking_sources
    except ImportError as exc:
        print(_warn(f"   [!] tracking ignore : {exc}"))
        return

    # The lab's analysis code, imported in THIS process by tracking_sources, pins the
    # BLAS/OpenMP thread variables to 1 at import. Every later step inherits the
    # orchestrator's environment, so they are put back once the analysis has run.
    saved_env = {k: os.environ.get(k) for k in _THREAD_ENV_VARS}
    try:
        if mode == "auto":
            resolved = tracking_sources.resolve(ims_path, temp_dir, dataset_name)
            if resolved is None:
                return
            container, _source, _glb = resolved
        else:
            source_path = Path(mode)
            if not source_path.is_file():
                print(_warn(f"   [!] tracking introuvable : {source_path}"))
                return
            print(_dim(f"   [TRACKING] source imposee : {source_path.name}"))
            container = tracking_sources.materialize(source_path, temp_dir, dataset_name)
    except Exception as exc:
        print(_warn(f"   [!] tracking non exploitable : {exc}"))
        return
    finally:
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    try:
        run_step("5-tracking_importer.py", str(container), str(dataset_output_dir))
    except subprocess.CalledProcessError as exc:
        print(_warn(f"   [!] rattachement du tracking echoue (code {exc.returncode}) — "
                    f"le volume reste utilisable"))


_THREAD_ENV_VARS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                    "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS")


DOWNLOAD_SCRIPT_NAME = "build_download_bundles.py"

def _resolve_download_script():
    """The download-bundle tool sits in tools/ in the repo, but is extracted next
    to this script by the self-contained launcher — accept either location."""
    for cand in (SCRIPT_DIR / DOWNLOAD_SCRIPT_NAME,
                 SCRIPT_DIR.parent / "tools" / DOWNLOAD_SCRIPT_NAME):
        if cand.exists():
            return cand.resolve()
    return None

# ── Publishing a dataset (all or nothing) ──────────────────────────────────────
# A run builds the whole dataset in a private staging tree under the temp directory
# (same volume as DATA_WEB, so publishing is a handful of renames). The published
# dataset keeps serving its previous bricks for the whole multi-hour run, and a run
# that fails at any point before the swap leaves it exactly as it was.
#
# Entries the pipeline owns inside a dataset folder. Everything else there — download/,
# gallery/, any file the operator dropped in — is never touched.
PIPELINE_ENTRIES = ("bricks", "thumbnail.webp")
TRACKING_ENTRIES = ("tracks.json", "tracks.json.gz", "model.glb")
SWAP_SUFFIX = ".pre-swap"
SWAP_MARKER = ".swap-in-progress"
LEGACY_ROLLBACK = "bricks.rollback"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def _rename(src: Path, dst: Path) -> None:
    _retry_os(lambda: os.rename(src, dst))


def recover_interrupted_publish(final_dir: Path) -> None:
    """Finish or undo a swap a crash interrupted, so a dataset is never left mixing
    two runs. The marker records the hash of the metadata.json being installed: if
    that file is in place the swap had committed and only the old copies remain to
    be dropped; otherwise the old entries go back where they were."""
    marker = final_dir / SWAP_MARKER
    if marker.is_file():
        info = read_json_file(marker)
        meta = final_dir / "metadata.json"
        committed = bool(info.get("metadataSha256")) and meta.is_file() \
            and _sha256_file(meta) == info["metadataSha256"]
        for entry in info.get("entries") or []:
            old = final_dir / (entry + SWAP_SUFFIX)
            if not old.exists():
                continue
            if committed:
                _remove_path(old)
            else:
                current = final_dir / entry
                if current.exists():
                    _remove_path(current)
                _rename(old, current)
        marker.unlink()
        print(_warn(f"   [<] publication interrompue de {final_dir.name} "
                    f"{'terminee' if committed else 'annulee'}"))
    # A run of an earlier pipeline version moved bricks/ aside for its whole duration
    # and could be killed before putting them back.
    legacy = final_dir / LEGACY_ROLLBACK
    if legacy.is_dir() and not (final_dir / "bricks").exists():
        _rename(legacy, final_dir / "bricks")
        print(_warn(f"   [<] bricks/ precedent restaure pour {final_dir.name}"))


def _merge_with_published(stage_dir: Path, final_dir: Path) -> None:
    """Re-apply the curation of the published metadata.json at the last moment: the
    operator may have edited it (hidden it, recalibrated it) while the run was busy."""
    published = final_dir / "metadata.json"
    if not published.is_file():
        return
    existing = read_json_file(published)
    if not existing:
        return
    catalog = load_step("4-catalog_generator.py", "lumen_catalog_generator")
    staged = stage_dir / "metadata.json"
    merged = catalog.merge_volume_metadata(existing, read_json_file(staged))
    atomic_write_json(staged, merged, indent=2, ensure_ascii=False)


def publish_dataset(stage_dir: Path, final_dir: Path) -> None:
    """Move a complete staged dataset into DATA_WEB, metadata.json last.

    A new dataset appears in one rename. An existing one has its pipeline entries
    swapped: the old ones are renamed aside, the new ones moved in, then metadata.json
    is replaced — the commit point. Any failure before it puts everything back.
    """
    staged_meta = stage_dir / "metadata.json"
    if not staged_meta.is_file():
        raise RuntimeError(f"{stage_dir} n'a pas de metadata.json — rien a publier")

    if not final_dir.exists():
        final_dir.parent.mkdir(parents=True, exist_ok=True)
        _rename(stage_dir, final_dir)
        return

    recover_interrupted_publish(final_dir)
    _merge_with_published(stage_dir, final_dir)

    entries = [e for e in PIPELINE_ENTRIES if (stage_dir / e).exists()]
    if (stage_dir / "tracks.json").exists():
        # A newly attached tracking replaces the whole previous set, including a surface
        # the new analysis no longer has.
        entries += list(TRACKING_ENTRIES)
    marker = final_dir / SWAP_MARKER
    atomic_write_json(marker, {"metadataSha256": _sha256_file(staged_meta), "entries": entries})

    moved_aside, installed = [], []
    try:
        for entry in entries:
            current = final_dir / entry
            if current.exists():
                stale = final_dir / (entry + SWAP_SUFFIX)
                if stale.exists():
                    _remove_path(stale)
                _rename(current, stale)
                moved_aside.append(entry)
        for entry in entries:
            if (stage_dir / entry).exists():
                _rename(stage_dir / entry, final_dir / entry)
                installed.append(entry)
        _retry_os(lambda: os.replace(staged_meta, final_dir / "metadata.json"))
    except BaseException:
        for entry in reversed(installed):
            try:
                _rename(final_dir / entry, stage_dir / entry)
            except OSError:
                _remove_path(final_dir / entry)
        for entry in reversed(moved_aside):
            _rename(final_dir / (entry + SWAP_SUFFIX), final_dir / entry)
        marker.unlink()
        raise
    marker.unlink()
    for entry in moved_aside:
        _remove_path(final_dir / (entry + SWAP_SUFFIX))
    if (final_dir / LEGACY_ROLLBACK).exists():
        _remove_path(final_dir / LEGACY_ROLLBACK)


def dataset_folder_name(stem: str, type_dir: Path) -> str:
    """The dataset folder for a source file. A name that is not URL-safe is
    slugified, unless a dataset was already published under the raw name — its id,
    links and curation stay where they are."""
    slug = slugify(stem) or "dataset"
    if slug != stem and (type_dir / stem).is_dir():
        return stem
    return slug


def process_ims_file(ims_path: Path, output_root: Path, idx: int = 0, total: int = 0,
                     with_downloads: bool = False, tracking: str = "auto") -> bool:
    """Run the whole pipeline on one .ims. Returns True once the dataset is published."""
    display_name = ims_path.stem
    counter = f"[{idx}/{total}] " if total else ""
    print()
    print(_hdr(f">> {counter}{display_name}"))
    print(_dim(f"   source : {ims_path}"))
    t0 = datetime.now()

    temp_dir = output_root / f".temp_preprocess_{slugify(display_name) or 'dataset'}"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True, exist_ok=True)

    published = None
    try:
        # Step 1: Extraction of metadata
        temp_meta_json = temp_dir / "meta.json"
        run_step("1-ims_metadata.py", str(ims_path), str(temp_meta_json))

        # The dataset type follows the acquisition: a stack with more than one
        # timepoint is a timelapse and belongs under live/, which is what drives the
        # viewer's timeline. Resolved here because only step 1 knows the frame count.
        # The directory name IS the dataset type — step 4 reads it back off disk.
        with open(temp_meta_json, "r", encoding="utf-8") as fm:
            n_timepoints = int(json.load(fm).get("n_timepoints", 1) or 1)
        dataset_type = "live" if n_timepoints > 1 else "3d"
        dataset_name = dataset_folder_name(display_name, output_root / dataset_type)
        final_dir = output_root / dataset_type / dataset_name
        if final_dir.exists():
            # A previous run killed mid-publish: put the dataset back in one piece now,
            # not hours from now when this run publishes.
            recover_interrupted_publish(final_dir)
        stage_dir = temp_dir / "stage" / dataset_type / dataset_name
        stage_dir.mkdir(parents=True)
        print(_dim(f"   type   : {dataset_type}"
                   + (f" ({n_timepoints} timepoints)" if n_timepoints > 1 else "")))
        if dataset_name != display_name:
            print(_dim(f"   dossier: {dataset_name} (nom source non utilisable tel quel dans une URL)"))

        # Step 2: Normalization, Background subtraction, Downscaling — each timepoint is
        # packed into the staging tree as soon as it is levelled, so the temporary
        # disk never holds more than one frame's LOD set.
        run_step("2-image_processor.py", str(ims_path), str(temp_meta_json), str(temp_dir),
                 "--pack-into", str(stage_dir))

        # Step 3: Compute thumbnail MIP
        with open(temp_dir / "processing_meta.json", "r", encoding="utf-8") as fm:
            proc_meta = json.load(fm)
        build_thumbnail(temp_dir, stage_dir, proc_meta)

        # Step 4: Chunking 64³ & Pack building (manifest of the packs step 2 wrote)
        run_step("3-chunk_packer.py", str(temp_dir), str(stage_dir))

        # Step 5: Catalog metadata, merged with the curation of the published one
        run_step("4-catalog_generator.py", str(temp_dir), str(stage_dir),
                 "--existing", str(final_dir / "metadata.json"),
                 "--display-name", display_name)

        # Step 6: cell tracking, when the acquisition has one. Only a timelapse can carry
        # trajectories, and the step needs the metadata.json step 4 just wrote.
        if n_timepoints > 1:
            attach_tracking(ims_path, stage_dir, temp_dir, dataset_name, tracking)

        publish_dataset(stage_dir, final_dir)
        published = final_dir
    except Exception as e:
        print(_err(f"   [X] {display_name} : {e}"), file=sys.stderr)
        traceback.print_exc()
        print(_warn("   [<] le dataset publie (s'il existe) est inchange"), file=sys.stderr)
    finally:
        # ignore_errors: on a Ctrl+C teardown a just-killed worker may still hold a
        # handle for a few ms — never let cleanup mask the interruption.
        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)

    if published is None:
        return False

    # Step 7 (optional): download/ bundle — archive, original .ims, ImageJ TIFF,
    # per-channel MIPs, README. An extra on top of a dataset that is already
    # published and complete: its failure is reported and never undoes the dataset.
    if with_downloads:
        dl_script = _resolve_download_script()
        if dl_script is None:
            print(_warn(f"   [!] {DOWNLOAD_SCRIPT_NAME} introuvable — download/ ignore"))
        else:
            try:
                run_script(dl_script,
                           "--data-web", str(output_root),
                           "--raw-dir", str(ims_path.parent),
                           "--dataset", f"{published.parent.name}/{published.name}",
                           "--ims", str(ims_path),
                           label="download/ (archive, ImageJ TIFF, MIP)")
            except subprocess.CalledProcessError as exc:
                print(_warn(f"   [!] download/ incomplet (code {exc.returncode}) — "
                            f"le dataset publie reste utilisable"))

    elapsed = (datetime.now() - t0).total_seconds()
    print(_ok(f"   [OK] {display_name} termine en {elapsed:.0f}s"))
    return True


def _folder_collisions(ims_files) -> dict:
    """Source files whose folder names would coincide (Windows folders ignore case),
    mapped to the earlier file that claims the name."""
    claimed, clashes = {}, {}
    for path in ims_files:
        key = (slugify(path.stem) or "dataset").casefold()
        if key in claimed:
            clashes[path] = claimed[key]
        else:
            claimed[key] = path
    return clashes


def main():
    parser = argparse.ArgumentParser(description="IRIBHM Microscopy Preprocessing Unified Pipeline")
    parser.add_argument("--input", required=True, help="Input directory containing raw .ims files.")
    parser.add_argument("--output", required=True, help="Output DATA_WEB directory of the web platform.")
    parser.add_argument("--only", default=None, help="Glob pattern to filter files to process (e.g. '*E8*').")
    parser.add_argument("--with-downloads", action="store_true",
                        help="After each dataset, also build its download/ bundle "
                             "(web archive, original .ims, ImageJ TIFF, per-channel MIP, README).")
    parser.add_argument("--tracking", default="auto", metavar="auto|off|FILE",
                        help="Cell tracking for timelapse datasets. 'auto' (default) looks for "
                             "a .imaris_track beside the volume, then the Imaris objects inside "
                             "the .ims itself, then the exported .xls/.xlsx statistics. 'off' "
                             "skips it. A path forces that file for every dataset processed.")
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
    print(_dim(f"  download/   : {'oui' if args.with_downloads else 'non'}"))
    print(_dim(f"  tracking    : {args.tracking}"))

    # Graceful Ctrl+C: confirm with the user, then tear the running step down cleanly.
    _install_sigint_handler()

    # Two inputs that would land in the same folder must not overwrite each other: the
    # first one claims the name, the second is refused and named.
    clashes = _folder_collisions(ims_files)

    # One dataset at a time (bounded RAM) — each step already multithreads internally.
    interrupted = False
    failed = []
    for i, ims_file in enumerate(ims_files):
        if ims_file in clashes:
            print(_err(f"   [X] {ims_file.name} : meme dossier de destination que "
                       f"{clashes[ims_file].name} — renommez l'un des deux fichiers"))
            failed.append(ims_file.name)
            continue
        try:
            ok = process_ims_file(ims_file, output_dir, i + 1, len(ims_files),
                                  with_downloads=args.with_downloads, tracking=args.tracking)
            if not ok:
                failed.append(ims_file.name)
        except KeyboardInterrupt:
            interrupted = True
            break
        except Exception as exc:
            print(_err(f"   [X] {ims_file.name} : {exc}"))
            failed.append(ims_file.name)

    if interrupted:
        # Remove any half-written temp folder left by the aborted dataset.
        for stray in output_dir.glob(".temp_preprocess_*"):
            shutil.rmtree(stray, ignore_errors=True)
        print()
        print(_warn("  Pipeline interrompu par l'utilisateur (Ctrl+C). Etat nettoye."))
        sys.exit(130)

    print()
    if failed:
        print(_err(f"  Pipeline termine : {len(failed)} dataset(s) en echec — " + ", ".join(failed)))
        sys.exit(1)
    print(_ok("  Pipeline termine."))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        # Ctrl+C confirmed outside a dataset (e.g. between steps) — exit cleanly.
        print(_warn("\n[!] Pipeline arrete."), file=sys.stderr)
        sys.exit(130)
