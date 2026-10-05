#!/usr/bin/env python3
"""
Lumen3D — dataset upload staging store
======================================
Backs the admin **Import** page: an operator drags the folder produced by the
preprocessing pipeline into the browser and the whole tree is streamed here in
resumable, hash-verified chunks. Nothing an operator drops is ever written
straight into ``DATA_WEB/`` — it lands in ``uploads/staging/`` first, is
validated as a whole dataset, and only a deliberate *publish* moves it across.

Why a staging root at all
-------------------------
``DATA_WEB/`` is web-served by construction (the viewer streams bricks over
HTTP). Bytes that arrived from a browser and have not yet been structurally
validated must not be reachable at a URL, so ``uploads/`` is a FORBIDDEN static
root — blocked in ``dev_server.py:_FORBIDDEN_ROOTS``, in the root ``.htaccess``,
in ``router.php`` and by its own deny-all ``uploads/.htaccess``. The admin
preview reads staged bytes through the authenticated ``?action=blob`` proxy
instead, never through a static path.

Containment model (Rule 1.4)
----------------------------
Two independent layers, both fail-closed:

1. **Shape** — every relative path must match ``classify_path``: a closed
   allowlist of the exact filenames the pipeline emits (``metadata.json``,
   ``thumbnail.webp``, ``bricks/manifest.json``, ``bricks/lodN/cM/pack_NN.bin``,
   the per-timepoint ``bricks/tNNN/…`` variants, and ``download/`` originals with
   an allowlisted extension). Anything else — ``.php``, ``.js``, ``.htaccess``, a
   dotfile, a stray editor backup — has no matching rule and is refused before a
   single byte is accepted.
2. **Containment** — ``_safe_rel`` rejects ``..``/absolute/backslash/dotfile
   segments up front, then ``resolve()`` + ``relative_to()`` proves the result is
   inside the dataset's staging directory. Same layered defence as
   ``dev_server._safe_dataset_dir``.

Integrity is checked at three depths: each chunk carries a SHA-256 verified
before the write lands; a finished file must match the client's declared size
and the digest-of-digests root; and a finished dataset must parse as valid JSON
metadata whose ``brickTransport.brickToPack`` index resolves inside the pack
files that actually arrived (``validate_dataset``).

Resume model
------------
One journal per dataset (``uploads/state/<type>__<folder>.json``) holds, for each
file, its size, the chunk size in force and a base64 bitmap with one bit per
received chunk. Re-dropping the same folder replays ``plan()``, which returns the
bitmaps so the client skips everything already stored — including whole datasets
already published. The journal is an optimisation, never a correctness
requirement: a chunk is only ever marked received *after* its bytes are on disk,
so a crash costs a re-send, never a corrupt file.
"""

from __future__ import annotations

import base64
import errno
import hashlib
import json
import os
import re
import struct
import shutil
import tempfile
import threading
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

__version__ = "1.0.0"

# ── Paths ──────────────────────────────────────────────────────────────────────
# Module-level so the dev server and the tests can redirect the whole store by
# calling configure() — mirrors how CONFIG_DIR / PAGE_DRAFTS_DIR are handled.
ROOT = Path(__file__).resolve().parent
UPLOADS_DIR = ROOT / "uploads"
STAGING_DIR = UPLOADS_DIR / "staging"
STATE_DIR = UPLOADS_DIR / "state"
DATA_WEB = ROOT / "DATA_WEB"

# The dataset vocabulary. One table: it is the directory under uploads/staging/,
# the directory under DATA_WEB/ a publish renames into, the type segment of the
# journal name, and metadata.json's `type` field.
ALLOWED_TYPE_DIRS = ("3d", "2d", "live")
# The types whose data is a brick pyramid. A 2d dataset is one photograph: no
# bricks/, its display copies sit at the dataset root (see _IMAGE_2D_FILES).
# Cell tracking is not a type: a tracked timelapse is a `live` dataset carrying
# tracks.json / model.glb beside its bricks (see _ROOT_EXTRA).
VOLUME_TYPE_DIRS = ("3d", "live")

# A dataset folder name: the same shape dev_server._safe_dataset_dir accepts, so a
# staged dataset can always be published without a rename.
_SAFE_FOLDER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")

# Transfer geometry. 8 MiB keeps a single chunk's SHA-256 + round trip short
# enough that a stall costs little, while amortising request overhead across a
# multi-gigabyte pack. The client may negotiate DOWN (a PHP host with a small
# post_max_size) but never up — a larger body is refused.
DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024
MAX_CHUNK_SIZE = 16 * 1024 * 1024
MIN_CHUNK_SIZE = 256 * 1024

# A staged dataset nobody finishes is real disk sitting in the staging root. The
# operator gets a week to re-drop the folder and resume; after that the GC frees
# it and the upload must start over.
STALE_AFTER_S = 7 * 24 * 3600

# Ceilings on a single dropped batch. Not a security boundary (the path allowlist
# is) — they stop a mis-drop of a whole home directory from building a
# million-entry plan in memory.
MAX_FILES_PER_DATASET = 200_000
MAX_DATASETS_PER_PLAN = 200
# Largest single file a plan accepts (a raw .ims original is tens of GB). Also
# bounds the received-chunk bitmap a client-declared size can make us allocate.
MAX_FILE_SIZE = 1 << 40
# Free space a plan must leave on the staging volume: the same disk usually holds
# DATA_WEB, the credential, logs and the updater's backups.
DISK_RESERVE_BYTES = 512 * 1024 * 1024

# Our own temp files (atomic JSON writes). Never part of a dataset: skipped by the
# stray-file check and swept before a publish.
_TMP_PREFIX = ".lumen-tmp-"

# ── State machine ──────────────────────────────────────────────────────────────
# uploading  — core files still missing; NOT openable, NOT editable
# editable   — metadata + manifest + the coarsest LOD are in; openable at low res
#              and editable while the rest streams in
# staged     — every planned byte is in and validate_dataset() passed; publishable
# published  — moved into DATA_WEB/, out of the staging store
# stalled    — no chunk accepted for STALE_AFTER_S; awaiting a re-drop before GC
STATE_UPLOADING = "uploading"
STATE_EDITABLE = "editable"
STATE_STAGED = "staged"
STATE_STALLED = "stalled"

# Serialises the read-modify-write of a dataset journal. ThreadingHTTPServer runs
# chunk handlers concurrently and several chunks of the same dataset are in flight
# by design, so an unguarded journal update loses received-bits (RACE-020 pattern).
_JOURNAL_LOCKS: dict[str, threading.Lock] = {}
_JOURNAL_LOCKS_GUARD = threading.Lock()


def configure(root: Path) -> None:
    """Point the whole store at ``root`` (used by the dev server and the tests)."""
    global ROOT, UPLOADS_DIR, STAGING_DIR, STATE_DIR, DATA_WEB
    ROOT = Path(root).resolve()
    UPLOADS_DIR = ROOT / "uploads"
    STAGING_DIR = UPLOADS_DIR / "staging"
    STATE_DIR = UPLOADS_DIR / "state"
    DATA_WEB = ROOT / "DATA_WEB"


def _journal_lock(key: str) -> threading.Lock:
    with _JOURNAL_LOCKS_GUARD:
        lock = _JOURNAL_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _JOURNAL_LOCKS[key] = lock
        return lock


# ── Path shape: the allowlist ──────────────────────────────────────────────────

# Priority tiers. A lower number is uploaded first, so a dataset becomes openable
# and editable as early as physically possible (the operator's explicit ask):
#   0  metadata.json / bricks manifest / thumbnail — the mount prerequisites
#   1  the COARSEST LOD, every channel — enough to ray-march at low resolution
#   2  the middle LODs, coarse to fine
#   3  lod0 (native) and, for a timelapse, every timepoint past the first
#   4  download/ originals — never needed to open a dataset
TIER_CORE, TIER_PREVIEW, TIER_MID, TIER_FULL, TIER_EXTRA = 0, 1, 2, 3, 4

_RE_PACK = re.compile(r"^lod(\d{1,2})/(c\d{1,2}|rgba)/pack_\d{1,6}\.bin\Z", re.ASCII)
_RE_TIMEPOINT = re.compile(r"^t(\d{1,6})/(.+)$")
# Format-2 plane copy of the native level (DOCS/dataset-migrations/SPEC.md §3): one
# tree at planes/ (a 3d dataset, or a single-frame timelapse), one per frame at
# planes/tNNN/ (a timelapse). Nothing else is ever written there by the pipeline.
_RE_PLANES = re.compile(r"^planes/(?:(t\d{3,6})/)?(manifest\.json|z\d{5,7}\.bin)\Z", re.ASCII)
_PLANES_MAGIC = b"LPLN"
# Format 3 (SPEC §12): the per-layer maximum projections, tiled like the planes; the
# pack header field `z` is the layer index, magic LMIP.
_RE_MIPS = re.compile(r"^mips/(?:(t\d{3,6})/)?(manifest\.json|l\d{5,7}\.bin)\Z", re.ASCII)
_MIPS_MAGIC = b"LMIP"
# Format 4 (SPEC §13): brick pyramid v3 — a binary index per tree and packs per
# (level, channel), `l{k}/c{c}/pNNNNN.bin`.
_RE_PACK_V3 = re.compile(r"^l(\d{1,2})/c(\d{1,2})/p\d{5}\.bin\Z", re.ASCII)
_INDEX_V3_MAGIC = b"LBIX"
BRICKS_V3_SCHEMA = "iribhm-bricks-v3"

# download/ originals. Deliberately data-only: no archive that a server might
# expand, no markup, no script. `.zip` is the one container, and it is only ever
# offered as a download — nothing on the platform opens it. No document type a
# browser renders as active content (html, xhtml, svg, xml: an XHTML-namespaced
# .xml runs its <script> from our own origin).
_DOWNLOAD_EXT = frozenset({
    "ims", "tif", "tiff", "png", "jpg", "jpeg", "webp", "gif",
    "zip", "txt", "md", "csv", "json", "pdf", "gz", "h5", "hdf5",
})
_RE_DOWNLOAD_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,180}$")
# Windows device names: `download/CON.zip` opens the console device, not a file.
_RE_WINDOWS_DEVICE = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", re.IGNORECASE)

# Files the pipeline writes at the dataset root, beyond metadata/thumbnail.
_ROOT_EXTRA = {
    "model.glb": TIER_FULL,
    "tracks.json": TIER_PREVIEW,
    "tracks.json.gz": TIER_PREVIEW,
    "meta.json": TIER_CORE,
}

# A 2d dataset's display copies. The preview is what the page paints first, so
# it travels with the mount prerequisites; the native image follows.
_IMAGE_2D_FILES = {
    "preview.webp": (TIER_PREVIEW, "preview"),
    "image.webp": (TIER_MID, "image"),
}

# A dataset is openable once metadata plus one of these has landed.
_MOUNT_KINDS = frozenset({"manifest", "preview"})


def _safe_rel(rel) -> str | None:
    """Normalise a client-supplied relative path, or None if it is unusable.

    Rejects NUL, absolute paths, backslash segments, ``.``/``..`` and dotfiles
    BEFORE any filesystem call — the resolve()/relative_to() containment check in
    ``staged_file_path`` is the authority, this is the cheap first gate.
    """
    if not isinstance(rel, str) or "\x00" in rel:
        return None
    rel = rel.replace("\\", "/").strip("/")
    if not rel or len(rel) > 1024:
        return None
    segments = rel.split("/")
    if len(segments) > 12:
        return None
    for seg in segments:
        if seg in ("", ".", "..") or seg.startswith("."):
            return None
        if len(seg) > 200:
            return None
    return "/".join(segments)


def classify_path(type_dir: str, rel: str):
    """Map a dataset-relative path to ``(tier, kind)``, or None if not allowed.

    This is the closed allowlist: a path with no rule here is refused, so no
    ``.php``/``.js``/``.htaccess`` can ever reach the staging tree — let alone
    ``DATA_WEB``. ``kind`` labels the file for validation and for the UI.
    """
    rel = _safe_rel(rel)
    if rel is None:
        return None
    # An unknown dataset root has no allowlist of its own, so nothing under it can
    # be allowed. _safe_dataset re-checks this on every path that touches disk;
    # rejecting here too keeps classify_path usable as a standalone verdict.
    if type_dir not in ALLOWED_TYPE_DIRS:
        return None

    if rel == "metadata.json":
        return TIER_CORE, "metadata"
    if rel == "thumbnail.webp":
        return TIER_CORE, "thumbnail"
    if rel in _ROOT_EXTRA:
        return (_ROOT_EXTRA[rel], "extra") if type_dir in VOLUME_TYPE_DIRS else None
    if rel in _IMAGE_2D_FILES:
        return _IMAGE_2D_FILES[rel] if type_dir == "2d" else None

    if rel.startswith("download/"):
        name = rel[len("download/"):]
        if "/" in name or not _RE_DOWNLOAD_NAME.match(name) or _RE_WINDOWS_DEVICE.match(name):
            return None
        if name.endswith((".", " ")):
            # Windows drops a trailing dot/space: the file on disk would not be
            # the one the allowlist judged.
            return None
        # Compare the FULL suffix chain, so `x.ome.tif` is judged on `tif` and a
        # double extension like `x.php.png` still resolves to its final `png`.
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in _DOWNLOAD_EXT:
            return None
        return TIER_EXTRA, "download"

    if rel.startswith("planes/"):
        # Planes never gate opening a dataset (the bricks serve every cut until they
        # arrive), so they travel last.
        m = _RE_PLANES.match(rel)
        if not m or type_dir not in VOLUME_TYPE_DIRS or (m.group(1) and type_dir != "live"):
            return None
        return TIER_EXTRA, ("planes_manifest" if m.group(2) == "manifest.json" else "planes_pack")

    if rel.startswith("mips/"):
        # Layer MIPs only speed up whole-stack figures: last, like the planes.
        m = _RE_MIPS.match(rel)
        if not m or type_dir not in VOLUME_TYPE_DIRS or (m.group(1) and type_dir != "live"):
            return None
        return TIER_EXTRA, ("mips_manifest" if m.group(2) == "manifest.json" else "mips_pack")

    if not rel.startswith("bricks/") or type_dir not in VOLUME_TYPE_DIRS:
        return None
    inner = rel[len("bricks/"):]

    if inner == "manifest.json":
        return TIER_CORE, "manifest"

    # Timelapse volumes nest each frame under bricks/tNNN/. Frame 0 rides with the
    # preview tier so a live dataset opens on its first timepoint; later frames are
    # full-quality work.
    tp = _RE_TIMEPOINT.match(inner)
    timepoint = None
    if tp:
        if type_dir != "live":
            return None
        timepoint = int(tp.group(1))
        inner = tp.group(2)
        if inner == "manifest.json":
            return TIER_CORE, "manifest"

    # The v3 binary index is what makes a tree mountable, like the v2 manifest.
    if inner == "index.bin":
        return TIER_CORE, "index"
    m = _RE_PACK.match(inner) or _RE_PACK_V3.match(inner)
    if not m:
        return None
    lod = int(m.group(1))
    # The real tier depends on how many LOD levels the dataset actually has, which
    # only the manifest knows; assign_tiers() re-ranks these once the plan is
    # grouped. This is the fallback ordering (coarser = smaller number = earlier).
    tier = TIER_FULL if lod == 0 else TIER_MID
    if timepoint not in (None, 0) and tier < TIER_FULL:
        tier = TIER_FULL
    return tier, "pack"


def _pack_lod(rel: str):
    """LOD level of a pack path, or None. Used to re-rank the preview tier."""
    inner = rel[len("bricks/"):] if rel.startswith("bricks/") else rel
    tp = _RE_TIMEPOINT.match(inner)
    timepoint = 0
    if tp:
        timepoint = int(tp.group(1))
        inner = tp.group(2)
    m = _RE_PACK.match(inner) or _RE_PACK_V3.match(inner)
    return (int(m.group(1)), timepoint) if m else None


def assign_tiers(files: list[dict]) -> None:
    """Re-rank pack files in place now that the whole file list is known.

    ``classify_path`` sees one path at a time and cannot know which LOD is the
    coarsest — that is a property of the set. The coarsest level present (highest
    lod number) is what makes a dataset openable, so it is promoted to
    TIER_PREVIEW and everything between it and lod0 is spread across TIER_MID.
    """
    lods = {p[0] for p in (_pack_lod(f["path"]) for f in files if f["kind"] == "pack") if p}
    if not lods:
        return
    coarsest = max(lods)
    for f in files:
        if f["kind"] != "pack":
            continue
        pl = _pack_lod(f["path"])
        if not pl:
            continue
        lod, timepoint = pl
        if timepoint > 0:
            f["tier"] = TIER_FULL          # later frames never gate the first open
        elif lod == coarsest:
            f["tier"] = TIER_PREVIEW
        elif lod == 0:
            f["tier"] = TIER_FULL
        else:
            f["tier"] = TIER_MID


# ── Journal ────────────────────────────────────────────────────────────────────

def dataset_key(type_dir: str, folder: str) -> str:
    return f"{type_dir}/{folder}"


def _safe_dataset(type_dir, folder):
    """Validate a (type, folder) pair. Returns the normalised pair or None."""
    if not isinstance(type_dir, str) or not isinstance(folder, str):
        return None
    type_dir, folder = type_dir.strip(), folder.strip()
    if type_dir not in ALLOWED_TYPE_DIRS:
        return None
    if folder in (".", "..") or not _SAFE_FOLDER_RE.match(folder) or len(folder) > 180:
        return None
    return type_dir, folder


def staging_dataset_dir(type_dir: str, folder: str):
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return None
    type_dir, folder = safe
    base = (STAGING_DIR / type_dir).resolve()
    candidate = (base / folder).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    return candidate


def staged_file_path(type_dir: str, folder: str, rel: str):
    """Absolute path of a staged file, or None if anything about it is unsafe.

    Containment is proved here — shape first (``_safe_rel``), allowlist second
    (``classify_path``), then resolve()/relative_to() against the dataset dir.
    """
    ds_dir = staging_dataset_dir(type_dir, folder)
    if ds_dir is None:
        return None
    rel = _safe_rel(rel)
    if rel is None or classify_path(type_dir, rel) is None:
        return None
    candidate = (ds_dir / Path(*rel.split("/"))).resolve()
    try:
        candidate.relative_to(ds_dir)
    except ValueError:
        return None
    return candidate


def journal_path(type_dir: str, folder: str):
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return None
    return STATE_DIR / f"{safe[0]}__{safe[1]}.json"


def _make_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _replace_retry(src, dst, attempts: int = 10, delay: float = 0.04) -> None:
    """os.replace with a short bounded retry: on Windows the rename fails while any
    reader (the admin polling a journal, the static handler serving metadata.json)
    holds the target open, usually for milliseconds."""
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(delay * (i + 1))


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Whole-or-nothing write: a uniquely named temp sibling, then a rename. The
    temp name is unique per call (two threads of one process used to share
    `.tmp<pid>`), and it is removed on any failure."""
    _make_dir(path.parent)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=_TMP_PREFIX)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        _replace_retry(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _atomic_write_json(path: Path, data) -> None:
    _atomic_write_bytes(path, json.dumps(data, ensure_ascii=False).encode("utf-8"))


def _is_disk_full(exc: OSError) -> bool:
    return (getattr(exc, "errno", None) in (errno.ENOSPC, getattr(errno, "EDQUOT", -1))
            or getattr(exc, "winerror", None) in (39, 112))


def _free_bytes(path: Path) -> int | None:
    """Free bytes on the volume holding ``path`` (its nearest existing ancestor)."""
    probe = Path(path)
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        return shutil.disk_usage(str(probe)).free
    except OSError:
        return None


def load_journal(type_dir: str, folder: str) -> dict | None:
    """The journal as it stands now: the JSON file with the chunk log folded in.

    Folding happens in memory only; ``save_journal`` is what makes it durable and
    empties the log. Callers that save must have loaded under ``_journal_lock`` so
    no record can be appended between the two (appends take the same lock)."""
    jp = journal_path(type_dir, folder)
    if jp is None or not jp.exists():
        return None
    try:
        data = json.loads(jp.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    _fold_log(data, type_dir, folder)
    return data


def save_journal(journal: dict) -> bool:
    """Compaction: write the folded journal atomically, then drop the chunk log.

    A crash between the two leaves records the journal already holds; folding them
    again sets bits that are already set, so the order is safe."""
    type_dir, folder = journal.get("type", ""), journal.get("folder", "")
    jp = journal_path(type_dir, folder)
    if jp is None:
        return False
    journal["updatedAt"] = _now_iso()
    _atomic_write_json(jp, journal)
    lp = log_path(type_dir, folder)
    if lp is not None:
        try:
            lp.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass   # a reader holds it (Windows): the records stay foldable, never wrong
    return True


# ── Chunk log + file table (shared with api/_upload_lib.php) ───────────────────
# Rewriting the whole JSON journal for every 8 MiB chunk cost 40 ms at 20 000 files
# and half a second at the 200 000-file ceiling, under the dataset lock, so the
# parallel streams were serialised through it. A chunk now costs one 16-byte append.
#
# Shared format (both backends read and write it — an import started under one
# resumes under the other). All integers little-endian.
#
#   uploads/state/<type>__<folder>.json   the journal. Each file entry carries an
#       integer "id" (never reused: "nextId" counts up), assigned when the entry is
#       created and REPLACED whenever its bitmap is reset or its size changes, so a
#       record logged against an old incarnation of a file can never mark the new
#       one.
#   uploads/state/<type>__<folder>.files  the file table, rewritten whenever ids
#       change: 16-byte header  "LUFT" | u32 version=1 | u32 count | u32 0,
#       then `count` 32-byte records at 16 + id*32:
#       u64 size | u32 chunkSize | u32 flags (bit 0 = live) | 16 bytes sha256(path)[:16].
#       It lets a chunk be checked against the planned size/chunk size without
#       parsing the journal; the path tag proves the client's `fid` names the path
#       it sends.
#   uploads/state/<type>__<folder>.log    the chunk log, append-only: 16-byte records
#       u32 id | u32 chunkIndex | "LUC1" | u32 crc32(bytes 0..11).
#       A record is appended only after the chunk's bytes are fsync'ed, so a record
#       that survives a crash always describes bytes on disk. A torn tail (length
#       not a multiple of 16) or a record whose magic/CRC does not match is
#       ignored: losing one only costs a re-send. The log is fsync'ed every 32nd
#       record and at compaction.
#
# Compaction (fold the log into the journal, write it, delete the log) happens at
# plan, at file completion and on every journal write; status reads fold in memory.

_LOG_RECORD = struct.Struct("<II4sI")
_LOG_MAGIC = b"LUC1"
_LOG_SYNC_EVERY = 32
_TABLE_HEADER = struct.Struct("<4sIII")
_TABLE_RECORD = struct.Struct("<QII16s")
_TABLE_MAGIC = b"LUFT"
_TABLE_LIVE = 1


def log_path(type_dir: str, folder: str):
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return None
    return STATE_DIR / f"{safe[0]}__{safe[1]}.log"


def table_path(type_dir: str, folder: str):
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return None
    return STATE_DIR / f"{safe[0]}__{safe[1]}.files"


def _path_tag(rel: str) -> bytes:
    return hashlib.sha256(rel.encode("utf-8")).digest()[:16]


def _log_record(file_id: int, index: int) -> bytes:
    head = struct.pack("<II4s", file_id, index, _LOG_MAGIC)
    return head + struct.pack("<I", zlib.crc32(head) & 0xFFFFFFFF)


def read_log(type_dir: str, folder: str) -> list[tuple[int, int]]:
    """Every intact ``(file id, chunk index)`` record of the dataset's chunk log."""
    lp = log_path(type_dir, folder)
    if lp is None:
        return []
    try:
        data = lp.read_bytes()
    except OSError:
        return []
    out = []
    size = _LOG_RECORD.size
    for off in range(0, len(data) - size + 1, size):
        fid, index, magic, crc = _LOG_RECORD.unpack_from(data, off)
        if magic == _LOG_MAGIC and zlib.crc32(data[off:off + 12]) & 0xFFFFFFFF == crc:
            out.append((fid, index))
    return out


def _fold_log(journal: dict, type_dir: str, folder: str) -> int:
    """Apply the chunk log to ``journal`` in memory. Returns the records applied."""
    records = read_log(type_dir, folder)
    if not records:
        return 0
    files = journal.get("files") if isinstance(journal.get("files"), dict) else {}
    by_id = {e["id"]: e for e in files.values()
             if isinstance(e, dict) and isinstance(e.get("id"), int)}
    maps: dict[int, tuple[bytearray, int]] = {}
    applied = 0
    for fid, index in records:
        entry = by_id.get(fid)
        if entry is None:
            continue
        if fid not in maps:
            size = int(entry.get("size", 0))
            chunk = int(entry.get("chunkSize", DEFAULT_CHUNK_SIZE)) or DEFAULT_CHUNK_SIZE
            nbits = _bits_len(size, chunk)
            maps[fid] = (_bitmap_decode(entry.get("bits", ""), nbits), nbits)
        bits, nbits = maps[fid]
        if index < nbits:
            _bit_set(bits, index)
            applied += 1
    for fid, (bits, nbits) in maps.items():
        entry = by_id[fid]
        entry["bits"] = _bitmap_encode(bits)
        # Same rule as the per-chunk journal write it replaces: a file whose every
        # chunk is in reads done; only finalize_file ever takes that back.
        if nbits and _bit_count(bits) == nbits:
            entry["done"] = True
    if applied:
        lp = log_path(type_dir, folder)
        try:
            mtime = lp.stat().st_mtime
            journal["lastChunkAt"] = datetime.fromtimestamp(mtime, timezone.utc).isoformat(timespec="seconds")
        except OSError:
            pass
    return applied


def _ensure_ids(journal: dict) -> bool:
    """Give every file entry an id (a journal written before the chunk log had
    none). Returns True when anything changed."""
    changed = False
    next_id = journal.get("nextId")
    files = journal.get("files") if isinstance(journal.get("files"), dict) else {}
    used = [e["id"] for e in files.values() if isinstance(e, dict) and isinstance(e.get("id"), int)]
    if not isinstance(next_id, int) or (used and next_id <= max(used)):
        next_id = (max(used) + 1) if used else 0
        changed = True
    for entry in files.values():
        if isinstance(entry, dict) and not isinstance(entry.get("id"), int):
            entry["id"] = next_id
            next_id += 1
            changed = True
    journal["nextId"] = next_id
    return changed


def _new_id(journal: dict, entry: dict) -> None:
    """A fresh incarnation of a file: its old id (and every log record naming it)
    no longer applies."""
    _ensure_ids(journal)
    entry["id"] = journal["nextId"]
    journal["nextId"] += 1


def _write_table(journal: dict) -> None:
    type_dir, folder = journal.get("type", ""), journal.get("folder", "")
    tp = table_path(type_dir, folder)
    if tp is None:
        return
    count = int(journal.get("nextId") or 0)
    buf = bytearray(_TABLE_HEADER.size + count * _TABLE_RECORD.size)
    _TABLE_HEADER.pack_into(buf, 0, _TABLE_MAGIC, 1, count, 0)
    for rel, entry in (journal.get("files") or {}).items():
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), int):
            continue
        fid = entry["id"]
        if not 0 <= fid < count:
            continue
        chunk = int(entry.get("chunkSize", DEFAULT_CHUNK_SIZE)) or DEFAULT_CHUNK_SIZE
        _TABLE_RECORD.pack_into(buf, _TABLE_HEADER.size + fid * _TABLE_RECORD.size,
                                int(entry.get("size", 0)), chunk, _TABLE_LIVE, _path_tag(rel))
    _atomic_write_bytes(tp, bytes(buf))


def read_table_record(type_dir: str, folder: str, file_id: int):
    """``(size, chunkSize, tag)`` of a live file-table record, or None."""
    tp = table_path(type_dir, folder)
    if tp is None or not isinstance(file_id, int) or file_id < 0:
        return None
    try:
        with open(tp, "rb") as fh:
            head = fh.read(_TABLE_HEADER.size)
            if len(head) != _TABLE_HEADER.size:
                return None
            magic, version, count, _ = _TABLE_HEADER.unpack(head)
            if magic != _TABLE_MAGIC or version != 1 or file_id >= count:
                return None
            fh.seek(_TABLE_HEADER.size + file_id * _TABLE_RECORD.size)
            raw = fh.read(_TABLE_RECORD.size)
    except OSError:
        return None
    if len(raw) != _TABLE_RECORD.size:
        return None
    size, chunk, flags, tag = _TABLE_RECORD.unpack(raw)
    if not flags & _TABLE_LIVE or chunk <= 0:
        return None
    return size, chunk, tag


def _append_log(type_dir: str, folder: str, file_id: int, index: int) -> None:
    lp = log_path(type_dir, folder)
    _make_dir(lp.parent)
    with open(lp, "ab") as fh:
        fh.write(_log_record(file_id, index))
        fh.flush()
        if (fh.tell() // _LOG_RECORD.size) % _LOG_SYNC_EVERY == 0:
            os.fsync(fh.fileno())


def _remove_state_files(type_dir: str, folder: str) -> None:
    for p in (journal_path(type_dir, folder), log_path(type_dir, folder),
              table_path(type_dir, folder)):
        if p is not None:
            try:
                p.unlink()
            except OSError:
                pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_journal(type_dir: str, folder: str) -> dict:
    return {
        "version": 1,
        "type": type_dir,
        "folder": folder,
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
        "files": {},
        "rejected": [],
        # Set the moment the operator saves an edit against a staged dataset. A
        # later re-drop of the same folder must NOT overwrite their work with the
        # pipeline's original metadata.json — see plan().
        "metaLocked": False,
        "publishedAt": None,
        "nextId": 0,
    }


# ── Received-chunk bitmap ──────────────────────────────────────────────────────
# One bit per chunk, base64 in the journal. A 22 GB original at 8 MiB chunks is
# 2 816 bits = 352 bytes — small enough to rewrite on every chunk without the
# journal becoming the bottleneck, and exact (no "high-water mark" guesswork, so
# chunks may be sent out of order and in parallel).

def _bits_len(size: int, chunk_size: int) -> int:
    if size <= 0:
        return 0
    return (size + chunk_size - 1) // chunk_size


def _bitmap_decode(b64: str, nbits: int) -> bytearray:
    nbytes = (nbits + 7) // 8
    try:
        raw = bytearray(base64.b64decode(b64 or "", validate=True))
    except Exception:
        raw = bytearray()
    if len(raw) < nbytes:
        raw.extend(b"\x00" * (nbytes - len(raw)))
    bits = raw[:nbytes] if nbytes else bytearray()
    # Mask the padding bits of the last byte. Nothing we write ever sets them, but
    # a hand-edited or truncated journal could, and the popcount in received_bytes
    # would then report MORE bytes received than were ever sent.
    extra = nbits & 7
    if extra and bits:
        bits[-1] &= (1 << extra) - 1
    return bits


def _bitmap_encode(bits: bytearray) -> str:
    return base64.b64encode(bytes(bits)).decode("ascii")


def _bit_get(bits: bytearray, i: int) -> bool:
    byte = i >> 3
    return byte < len(bits) and bool(bits[byte] & (1 << (i & 7)))


def _bit_set(bits: bytearray, i: int) -> None:
    byte = i >> 3
    if byte < len(bits):
        bits[byte] |= 1 << (i & 7)


def _bit_count(bits: bytearray, nbits: int = 0) -> int:
    """Set bits in the map. O(1) in the bit count — the padding is already masked
    off by _bitmap_decode, so the whole buffer can be popcounted in one go rather
    than walked bit by bit (a 22 GB original is 2 816 bits, and this runs on every
    chunk acknowledgement)."""
    return int.from_bytes(bytes(bits), "little").bit_count()


def received_bytes(entry: dict) -> int:
    """Exact byte count already stored for a journal file entry."""
    size = int(entry.get("size", 0))
    chunk = int(entry.get("chunkSize", DEFAULT_CHUNK_SIZE)) or DEFAULT_CHUNK_SIZE
    nbits = _bits_len(size, chunk)
    if nbits == 0:
        return 0
    bits = _bitmap_decode(entry.get("bits", ""), nbits)
    count = _bit_count(bits)
    # Every chunk is `chunk` bytes except the last, which is whatever remains.
    last = nbits - 1
    if _bit_get(bits, last):
        return (count - 1) * chunk + (size - last * chunk)
    return count * chunk


def missing_chunks(entry: dict) -> list[int]:
    size = int(entry.get("size", 0))
    chunk = int(entry.get("chunkSize", DEFAULT_CHUNK_SIZE)) or DEFAULT_CHUNK_SIZE
    nbits = _bits_len(size, chunk)
    bits = _bitmap_decode(entry.get("bits", ""), nbits)
    return [i for i in range(nbits) if not _bit_get(bits, i)]


# ── Plan ───────────────────────────────────────────────────────────────────────

def plan(datasets: list, chunk_size: int = DEFAULT_CHUNK_SIZE) -> dict:
    """Turn a dropped file listing into a resumable upload plan.

    ``datasets`` is ``[{type, folder, files: [{path, size}]}]`` as grouped by the
    client (which can read the dropped ``metadata.json`` to learn the type). Every
    claim is re-derived here: the type/folder shape, every path against the
    allowlist, and the on-disk state of anything already staged or published.
    """
    chunk_size = _clamp_chunk(chunk_size)
    out = []
    if not isinstance(datasets, list):
        return {"ok": False, "error": "bad_request"}
    # One free-space budget for the whole drop: each dataset spends from it, so
    # several datasets that fit one by one cannot together overrun the disk.
    free = _free_bytes(STAGING_DIR)
    budget = [None if free is None else max(0, free - DISK_RESERVE_BYTES)]
    for raw in datasets[:MAX_DATASETS_PER_PLAN]:
        if not isinstance(raw, dict):
            continue
        safe = _safe_dataset(raw.get("type"), raw.get("folder"))
        if safe is None:
            out.append({"key": None, "type": raw.get("type"), "folder": raw.get("folder"),
                        "error": "invalid_dataset", "files": [], "rejected": []})
            continue
        type_dir, folder = safe
        out.append(_plan_one(type_dir, folder, raw.get("files"), chunk_size, budget))
    return {"ok": True, "chunkSize": chunk_size, "datasets": out}


def _clamp_chunk(n) -> int:
    try:
        n = int(n)
    except Exception:
        return DEFAULT_CHUNK_SIZE
    return max(MIN_CHUNK_SIZE, min(MAX_CHUNK_SIZE, n))


def _plan_one(type_dir: str, folder: str, files, chunk_size: int, budget=None) -> dict:
    key = dataset_key(type_dir, folder)
    published_dir = (DATA_WEB / type_dir / folder)
    already_published = (published_dir / "metadata.json").exists()

    accepted, rejected = [], []
    seen = set()
    for f in (files or [])[:MAX_FILES_PER_DATASET]:
        if not isinstance(f, dict):
            continue
        rel = _safe_rel(f.get("path"))
        if rel is None:
            rejected.append({"path": str(f.get("path"))[:200], "reason": "unsafe_path"})
            continue
        if rel in seen:
            continue
        seen.add(rel)
        verdict = classify_path(type_dir, rel)
        if verdict is None:
            rejected.append({"path": rel, "reason": "not_allowed"})
            continue
        try:
            size = int(f.get("size", 0))
        except Exception:
            size = -1
        if size < 0:
            rejected.append({"path": rel, "reason": "bad_size"})
            continue
        if size > MAX_FILE_SIZE:
            rejected.append({"path": rel, "reason": "too_large"})
            continue
        tier, kind = verdict
        accepted.append({"path": rel, "size": size, "tier": tier, "kind": kind})
    assign_tiers(accepted)

    with _journal_lock(key):
        journal = load_journal(type_dir, folder)
        if journal is None:
            journal = _new_journal(type_dir, folder)
        jfiles = journal.setdefault("files", {})
        _ensure_ids(journal)

        # Bytes this drop still has to write: everything not already stored. Refused
        # up front, before the journal changes, when the volume cannot hold it — a
        # full disk mid-transfer stalls every other writer on the host.
        if budget is not None and budget[0] is not None:
            needed = 0
            for item in accepted:
                entry = jfiles.get(item["path"])
                if entry and int(entry.get("size", -1)) == item["size"]:
                    needed += 0 if entry.get("done") else item["size"] - received_bytes(entry)
                else:
                    needed += item["size"]
            if needed > budget[0]:
                return {
                    "key": key, "type": type_dir, "folder": folder,
                    "error": "insufficient_disk", "neededBytes": needed,
                    "freeBytes": budget[0], "files": [], "rejected": rejected[:200],
                }
            budget[0] -= needed

        for item in accepted:
            rel = item["path"]
            entry = jfiles.get(rel)
            # Tiering is a property of the SET, so a second drop that adds coarser
            # levels re-ranks files planned earlier. Refresh it on every branch —
            # a stale tier on a finished file skews dataset_state's "is this
            # openable yet" test.
            if entry is not None:
                entry["tier"] = item["tier"]
                entry["kind"] = item["kind"]
            # The operator's edits win over a re-dropped pipeline file. metadata.json
            # is the one file the admin editor rewrites in place while the rest of the
            # dataset is still streaming in; re-sending the original would silently
            # revert their work (their explicit requirement).
            if rel == "metadata.json" and journal.get("metaLocked") and entry and entry.get("done"):
                item["skip"] = "locked"
                # Report the LOCAL size, not the edited file's: totalBytes is summed
                # from local sizes, and mixing the two made receivedBytes overshoot.
                item["received"] = item["size"]
                item["done"] = True
                continue
            if entry and int(entry.get("size", -1)) == item["size"] and entry.get("done"):
                item["received"] = item["size"]
                item["done"] = True
                item["skip"] = "complete"
                continue
            if entry and int(entry.get("size", -1)) == item["size"]:
                # Same file, partially received — resume against the stored bitmap.
                item["received"] = received_bytes(entry)
                item["chunkSize"] = int(entry.get("chunkSize", chunk_size))
                item["missing"] = missing_chunks(entry)
                item["done"] = False
                item["fileId"] = entry["id"]
                continue
            # New file, or the size changed (a re-run of the pipeline) — start over.
            nbits = _bits_len(item["size"], chunk_size)
            fresh = {
                "size": item["size"], "chunkSize": chunk_size, "kind": item["kind"],
                "tier": item["tier"], "bits": _bitmap_encode(bytearray((nbits + 7) // 8)),
                "done": item["size"] == 0, "sha": None,
            }
            _new_id(journal, fresh)
            jfiles[rel] = fresh
            item["fileId"] = fresh["id"]
            item["received"] = 0
            item["chunkSize"] = chunk_size
            item["missing"] = list(range(nbits))
            item["done"] = item["size"] == 0

        journal["rejected"] = rejected[:200]
        # Drop UNFINISHED entries this drop no longer contains, and their partial
        # bytes with them. The client always sends the complete recursive listing
        # for a dataset it recognised (it needs metadata.json to recognise it at
        # all), so absence here means the file is genuinely gone — a re-run of the
        # pipeline that emits fewer LOD levels, say. Left in place they were never
        # completable, and validate_dataset's "incomplete_files" check then blocked
        # the publish forever, naming a file the operator no longer has.
        # FINISHED entries are kept: their bytes are real, and an extra pack that
        # the manifest simply never references is harmless.
        present = {i["path"] for i in accepted}
        for rel in [r for r, e in jfiles.items() if r not in present and not e.get("done")]:
            jfiles.pop(rel, None)
            orphan = staged_file_path(type_dir, folder, rel)
            if orphan is not None and orphan.is_file():
                try:
                    orphan.unlink()
                except OSError:
                    pass
        save_journal(journal)
        _write_table(journal)

    total = sum(i["size"] for i in accepted)
    done = sum(i.get("received", 0) for i in accepted)
    return {
        "key": key, "type": type_dir, "folder": folder,
        "published": already_published,
        "state": dataset_state(type_dir, folder, journal),
        "metaLocked": bool(journal.get("metaLocked")),
        "files": accepted, "rejected": rejected[:200],
        "totalBytes": total, "receivedBytes": done,
    }


# ── Chunk ingest ───────────────────────────────────────────────────────────────

def write_chunk(type_dir: str, folder: str, rel: str, index: int,
                data: bytes, sha256_hex: str | None, file_id=None) -> tuple[int, dict]:
    """Verify and store one chunk. Returns (http_status, payload).

    The SHA-256 is checked BEFORE the write: a corrupted or tampered chunk never
    touches the staging file, so a file on disk is only ever made of bytes that
    matched what the client hashed.

    With ``file_id`` (the ``fileId`` plan() returned) the planned geometry is read
    from the file table and the bytes are written outside the dataset lock; only
    the 16-byte log append is serialised. Without it (an older client) or for
    metadata.json (whose operator lock lives in the journal) the journal is
    consulted.
    """
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return 400, {"error": "invalid_dataset"}
    type_dir, folder = safe
    key = dataset_key(type_dir, folder)

    dest = staged_file_path(type_dir, folder, rel)
    if dest is None:
        return 400, {"error": "path_not_allowed"}
    rel = _safe_rel(rel)

    if not isinstance(index, int) or index < 0:
        return 400, {"error": "bad_index"}
    if len(data) > MAX_CHUNK_SIZE:
        return 413, {"error": "chunk_too_large"}
    # The digest is mandatory: a chunk without one would land unverified and the
    # finished file's integrity would rest on its size alone.
    if not isinstance(sha256_hex, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha256_hex):
        return 400, {"error": "checksum_required"}
    actual = hashlib.sha256(data).hexdigest()
    if actual != sha256_hex.lower():
        return 422, {"error": "checksum_mismatch", "expected": sha256_hex, "actual": actual}

    tag = _path_tag(rel)
    tp = table_path(type_dir, folder)
    if not isinstance(file_id, int) or rel == "metadata.json" or not tp.exists():
        return _write_chunk_journal(type_dir, folder, rel, index, data, dest)
    record = read_table_record(type_dir, folder, file_id)
    if record is None or record[2] != tag:
        # A retired id (the file was re-planned with another size, reset, or
        # dropped) or one naming another path: these bytes belong to no file the
        # journal still plans. The client re-plans and gets the live id.
        return 409, {"error": "file_not_planned"}

    size, chunk_size, _ = record
    nbits = _bits_len(size, chunk_size)
    if index >= nbits:
        return 400, {"error": "index_out_of_range"}
    offset = index * chunk_size
    expected_len = min(chunk_size, size - offset)
    if len(data) != expected_len:
        return 400, {"error": "bad_chunk_length", "expected": expected_len, "actual": len(data)}
    try:
        _write_at(dest, offset, data)
    except OSError as exc:
        return _write_error(exc, len(data))
    with _journal_lock(key):
        # Re-read under the lock: a plan or a reset in between may have retired this
        # id, and a record must never name a file it does not belong to.
        again = read_table_record(type_dir, folder, file_id)
        jp = journal_path(type_dir, folder)
        if again is None or again[2] != tag or again[:2] != record[:2] or not jp.exists():
            return 409, {"error": "file_not_planned"}
        try:
            _append_log(type_dir, folder, file_id, index)
        except OSError as exc:
            return _write_error(exc, len(data))
    return 200, {"ok": True, "index": index, "chunks": nbits}


def _write_at(dest: Path, offset: int, data: bytes) -> None:
    """Sparse write at the exact offset, then fsync: chunks land in any order and in
    parallel, a re-sent chunk is idempotent, and the log record that follows may
    only ever describe bytes that are on disk."""
    _make_dir(dest.parent)
    fd = os.open(str(dest), os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o644)
    try:
        os.lseek(fd, offset, os.SEEK_SET)
        view = memoryview(data)
        while view:
            n = os.write(fd, view)
            view = view[n:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_error(exc: OSError, wanted: int) -> tuple[int, dict]:
    # A failure costs a re-send, never a corrupt file (the record follows the
    # bytes). A full disk is terminal for the transfer (507), not a hiccup to retry.
    if _is_disk_full(exc):
        return 507, {"error": "insufficient_disk", "neededBytes": wanted,
                     "freeBytes": _free_bytes(STAGING_DIR)}
    return 500, {"error": "write_failed"}


def _write_chunk_journal(type_dir: str, folder: str, rel: str, index: int,
                         data: bytes, dest: Path) -> tuple[int, dict]:
    key = dataset_key(type_dir, folder)
    with _journal_lock(key):
        journal = load_journal(type_dir, folder)
        if journal is None:
            return 409, {"error": "no_plan"}
        entry = journal.get("files", {}).get(rel)
        if entry is None:
            return 409, {"error": "file_not_planned"}
        if rel == "metadata.json" and journal.get("metaLocked") and entry.get("done"):
            # Not an error: the operator edited it, the client just doesn't know yet.
            return 200, {"ok": True, "skipped": "locked", "received": entry.get("size", 0)}

        size = int(entry.get("size", 0))
        chunk_size = int(entry.get("chunkSize", DEFAULT_CHUNK_SIZE)) or DEFAULT_CHUNK_SIZE
        nbits = _bits_len(size, chunk_size)
        if index >= nbits:
            return 400, {"error": "index_out_of_range"}
        offset = index * chunk_size
        expected_len = min(chunk_size, size - offset)
        if len(data) != expected_len:
            return 400, {"error": "bad_chunk_length", "expected": expected_len, "actual": len(data)}

        if not isinstance(entry.get("id"), int):
            # A journal from before the chunk log: number it once, durably.
            _ensure_ids(journal)
            save_journal(journal)
            _write_table(journal)
        try:
            _write_at(dest, offset, data)
            _append_log(type_dir, folder, entry["id"], index)
        except OSError as exc:
            return _write_error(exc, len(data))
        bits = _bitmap_decode(entry.get("bits", ""), nbits)
        _bit_set(bits, index)
        entry["bits"] = _bitmap_encode(bits)
        got = _bit_count(bits, nbits)
        done = bool(entry.get("done")) or got == nbits
        entry["done"] = done
        return 200, {"ok": True, "index": index, "chunks": nbits, "have": got,
                     "done": done, "received": received_bytes(entry)}


def finalize_file(type_dir: str, folder: str, rel: str, root_hex: str | None) -> tuple[int, dict]:
    """Close a file: every chunk present, the size on disk matches, digest root OK.

    ``root_hex`` is the SHA-256 of the concatenated per-chunk digests the client
    computed while streaming. Browsers have no incremental whole-file hash, and
    hashing a 22 GB file twice would double the read cost — the digest-of-digests
    proves the same thing (every chunk verified, in the right order, nothing
    missing) for free.
    """
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return 400, {"error": "invalid_dataset"}
    type_dir, folder = safe
    key = dataset_key(type_dir, folder)
    dest = staged_file_path(type_dir, folder, rel)
    if dest is None:
        return 400, {"error": "path_not_allowed"}
    rel = _safe_rel(rel)

    with _journal_lock(key):
        journal = load_journal(type_dir, folder)
        if journal is None:
            return 409, {"error": "no_plan"}
        entry = journal.get("files", {}).get(rel)
        if entry is None:
            return 409, {"error": "file_not_planned"}
        size = int(entry.get("size", 0))
        chunk_size = int(entry.get("chunkSize", DEFAULT_CHUNK_SIZE)) or DEFAULT_CHUNK_SIZE
        nbits = _bits_len(size, chunk_size)
        bits = _bitmap_decode(entry.get("bits", ""), nbits)
        missing = [i for i in range(nbits) if not _bit_get(bits, i)]
        if missing:
            return 409, {"error": "incomplete", "missing": missing[:64]}

        if size == 0:
            _make_dir(dest.parent)
            dest.touch()
        try:
            on_disk = dest.stat().st_size
        except OSError:
            return 409, {"error": "missing_on_disk"}
        if on_disk != size:
            # The file was truncated or grown behind our back — drop the bitmap so
            # the next plan() re-sends it rather than publishing a corrupt pack.
            entry["bits"] = _bitmap_encode(bytearray((nbits + 7) // 8))
            entry["done"] = False
            _new_id(journal, entry)
            save_journal(journal)
            _write_table(journal)
            return 409, {"error": "size_mismatch", "expected": size, "actual": on_disk}

        # The journal is about to declare this file complete; make sure its bytes
        # survive a power loss first, or a crash could leave a zero-filled pack
        # that still matches its size.
        try:
            with open(dest, "rb+") as fh:
                os.fsync(fh.fileno())
        except OSError:
            pass

        ok, reason = _validate_file_content(type_dir, rel, dest, entry.get("kind"))
        if not ok:
            entry["done"] = False
            entry["invalid"] = reason
            save_journal(journal)
            return 422, {"error": "invalid_content", "reason": reason}

        entry.pop("invalid", None)
        entry["done"] = True
        if root_hex:
            entry["sha"] = str(root_hex)[:128]
        save_journal(journal)
        return 200, {"ok": True, "path": rel, "size": size,
                     "state": dataset_state(type_dir, folder, journal)}


# ── Content validation ─────────────────────────────────────────────────────────

_MAGIC = {
    "webp": (b"RIFF", 0),
    "png": (b"\x89PNG\r\n\x1a\n", 0),
    "gltf": (b"glTF", 0),
}
MAX_JSON_BYTES = 256 * 1024 * 1024   # bricks/manifest.json runs to a few MB


def _validate_file_content(type_dir: str, rel: str, path: Path, kind: str | None):
    """Prove a finished file is what its name claims. Returns (ok, reason)."""
    try:
        if kind == "metadata" or rel == "metadata.json":
            meta = _read_json(path)
            if meta is None:
                return False, "metadata_not_json"
            return _validate_metadata(meta, type_dir)
        if kind == "manifest":
            man = _read_json(path)
            if man is None:
                return False, "manifest_not_json"
            return _validate_manifest(man)
        if kind in ("thumbnail", "preview", "image"):
            with path.open("rb") as fh:
                head = fh.read(16)
            if not head.startswith(_MAGIC["webp"][0]) and not head.startswith(_MAGIC["png"][0]):
                return False, f"{kind}_not_image"
            return True, None
        if kind in ("planes_manifest", "mips_manifest"):
            doc = _read_json(path)
            schema = "lumen-planes-v1" if kind == "planes_manifest" else "lumen-mips-v1"
            if doc is None or doc.get("schema") != schema:
                return False, f"{kind}_invalid"
            return True, None
        if kind in ("planes_pack", "mips_pack"):
            # Magic, version 1 and a file long enough for its own entry table
            # (16 + 12·C·TY·TX bytes, SPEC §3.2; a MIP pack has the same layout, §12).
            magic = _PLANES_MAGIC if kind == "planes_pack" else _MIPS_MAGIC
            with path.open("rb") as fh:
                head = fh.read(16)
            if len(head) < 16 or head[:4] != magic:
                return False, f"{kind}_bad_magic"
            ver, ch, tx, ty = struct.unpack_from("<HHHH", head, 4)
            if ver != 1 or not ch or not tx or not ty or path.stat().st_size < 16 + 12 * ch * tx * ty:
                return False, f"{kind}_bad_header"
            return True, None
        if kind == "index":
            with path.open("rb") as fh:
                data = fh.read(_INDEX_V3_MAX_BYTES + 1)
            return _index_v3_shape(data)[0:2]
        if kind == "extra" and rel.endswith(".glb"):
            with path.open("rb") as fh:
                head = fh.read(4)
            if head != _MAGIC["gltf"][0]:
                return False, "glb_bad_magic"
            return True, None
        if kind == "extra" and rel.startswith("tracks.json") and not rel.endswith(".gz"):
            if _read_json(path) is None:
                return False, "tracks_not_json"
            return True, None
    except OSError:
        return False, "unreadable"
    return True, None


def _read_json(path: Path):
    try:
        if path.stat().st_size > MAX_JSON_BYTES:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


# Twins of js/core/brick-loader.js BRICK_SIZE / _KNOWN_ENCODINGS.
BRICK_SIZE = 64
_KNOWN_ENCODINGS = frozenset({"raw-u8", "raw-u8-gzip", "raw-rgba-gzip", "webp-lossless"})


# ── Brick pyramid v3 (format 4, SPEC §13.3) ─────────────────────────────────────
# index.bin: "LBIX" | u16 version=1 | u16 levels | u16 channels | u16 0, then per
# level u32 gridX, gridY, gridZ, packCount, then per level, per channel, per brick
# (bz, by, bx) {u16 pack, u32 offset, u32 length} (length 0 = absent). Pack p of
# level k, channel c is l{k}/c{c}/p{p:05d}.bin beside the index.
_INDEX_V3_MAX_BYTES = 32 * 1024 * 1024   # twin of LUMEN_UP_INDEX_V3_MAX (read whole by PHP under 128 MiB)


def _index_v3_shape(data: bytes):
    """(ok, reason, levels [(gx, gy, gz, packs)], channels) of an index.bin — its
    magic, version and EXACT length (header + level table + 10 bytes per slot)."""
    if len(data) < 12 or data[:4] != _INDEX_V3_MAGIC:
        return False, "index_bad_magic", [], 0
    if len(data) > _INDEX_V3_MAX_BYTES:
        return False, "index_too_large", [], 0
    version, n_levels, channels, _r = struct.unpack_from("<HHHH", data, 4)
    if version != 1 or not n_levels or not channels:
        return False, "index_bad_header", [], 0
    pos = 12 + 16 * n_levels
    if len(data) < pos:
        return False, "index_truncated", [], 0
    levels = [struct.unpack_from("<IIII", data, 12 + 16 * i) for i in range(n_levels)]
    expected = pos + sum(10 * channels * gx * gy * gz for gx, gy, gz, _ in levels)
    if len(data) != expected:
        return False, "index_bad_length", [], 0
    return True, None, levels, channels


def _validate_manifest_v3(man: dict):
    """bricks/manifest.json of format 4 (SPEC §13.3): the geometry the v3 reader
    builds on, and an index entry per tree."""
    def _int(v):
        return isinstance(v, int) and not isinstance(v, bool)

    if man.get("version") != 3:
        return False, "manifest_v3_bad_version"
    if not (_int(man.get("channels")) and man["channels"] >= 1):
        return False, "manifest_bad_channels"
    if man.get("brickSize") != BRICK_SIZE or man.get("apron") != 1:
        return False, "manifest_bad_brick_size"
    packing = man.get("brickPacking")
    if not isinstance(packing, dict) or (packing.get("mode"), packing.get("cols"),
                                         packing.get("rows"), packing.get("slice")) != ("grid", 9, 8, 66):
        return False, "manifest_bad_packing_grid"
    if man.get("encoding") != "webp-lossless":
        return False, "manifest_bad_encoding"
    levels = man.get("levels")
    if not isinstance(levels, list) or not levels:
        return False, "manifest_no_levels"
    for i, level in enumerate(levels):
        if not isinstance(level, dict) or level.get("level") != i:
            return False, f"manifest_level_{i}_out_of_order"
        for key in ("dimensions", "gridSize"):
            d = level.get(key)
            if not isinstance(d, dict) or not all(_int(d.get(a)) and d[a] > 0 for a in ("x", "y", "z")):
                return False, f"manifest_level_{i}_bad_{key}"
    for key, info in _v3_trees(man):
        if key is None:
            return False, "manifest_v3_bad_timepoints"
        want = f"{key}/index.bin" if key else "index.bin"
        if (not isinstance(info, dict) or info.get("url") != want or not _int(info.get("bytes"))
                or not isinstance(info.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", info["sha256"])):
            return False, "manifest_v3_bad_index"
    return True, None


_RE_TREE_KEY = re.compile(r"^t\d{3,6}\Z", re.ASCII)


def _v3_trees(man: dict) -> list:
    """[(tree key, index info)]: ('', index) for a 3d tree, ('tNNN', index) per frame
    of a timelapse; (None, None) for a malformed timepoint row."""
    tps = man.get("timepoints")
    if tps is None:
        return [("", man.get("index"))]
    if not isinstance(tps, list) or not tps:
        return [(None, None)]
    out = []
    for row in tps:
        key = row.get("path") if isinstance(row, dict) else None
        if not isinstance(key, str) or not _RE_TREE_KEY.match(key):
            out.append((None, None))
        else:
            out.append((key, row.get("index")))
    return out


def _cross_check_v3(ds_dir: Path, man: dict) -> list[str]:
    """Every tree's index.bin is the one the manifest hashed, describes the manifest's
    levels and channels, and every brick it lists lies inside a pack that arrived —
    the v3 counterpart of the brickToPack check."""
    errors: list[str] = []
    bricks = ds_dir / "bricks"
    levels = man.get("levels") or []
    for key, info in _v3_trees(man):
        tree = bricks / key if key else bricks
        label = key or "bricks"
        try:
            data = (tree / "index.bin").read_bytes() if (tree / "index.bin").stat().st_size <= _INDEX_V3_MAX_BYTES else b""
        except OSError:
            errors.append(f"missing_index:{label}")
            continue
        if len(data) != info.get("bytes") or hashlib.sha256(data).hexdigest() != info.get("sha256"):
            errors.append(f"index_hash_mismatch:{label}")
            continue
        ok, reason, idx_levels, channels = _index_v3_shape(data)
        if not ok:
            errors.append(f"{reason}:{label}")
            continue
        if len(idx_levels) != len(levels) or channels != man.get("channels"):
            errors.append(f"index_shape_mismatch:{label}")
            continue
        pos = 12 + 16 * len(idx_levels)
        for k, ((gx, gy, gz, _packs), row) in enumerate(zip(idx_levels, levels)):
            g = row.get("gridSize") or {}
            if (gx, gy, gz) != (g.get("x"), g.get("y"), g.get("z")):
                errors.append(f"index_grid_mismatch:{label}:l{k}")
                break
            n = gx * gy * gz
            for c in range(channels):
                extent: dict[int, int] = {}
                for pack, offset, length in struct.iter_unpack("<HII", data[pos:pos + 10 * n]):
                    if length:
                        end = offset + length
                        if end > extent.get(pack, 0):
                            extent[pack] = end
                pos += 10 * n
                for pack, end in extent.items():
                    rel = f"l{k}/c{c}/p{pack:05d}.bin"
                    try:
                        size = (tree / rel).stat().st_size
                    except OSError:
                        errors.append(f"missing_pack:{(key + '/') if key else ''}{rel}")
                        continue
                    if size < end:
                        errors.append(f"truncated_pack:{(key + '/') if key else ''}{rel}")
                if len(errors) >= 20:
                    return errors
    return errors


def _validate_manifest(man: dict):
    """Mirror of js/core/brick-loader.js `_validateManifest`, minus the parts that
    only matter once decoding starts.

    Checking merely that ``levels`` is non-empty was too weak: a manifest missing
    per-level dimensions passed the import, reported "integrity verified", and
    then made the viewer reject it at mount time. A dataset the platform cannot
    open is not a valid dataset — catch it while it is still in staging, where
    the operator can still fix and re-drop it.
    """
    def _int(v):
        return isinstance(v, int) and not isinstance(v, bool)

    if man.get("schema") == BRICKS_V3_SCHEMA:
        return _validate_manifest_v3(man)
    levels = man.get("levels")
    if not isinstance(levels, list) or not levels:
        return False, "manifest_no_levels"
    channels = man.get("channels")
    if channels is not None and not (_int(channels) and channels >= 1):
        return False, "manifest_bad_channels"
    # The decoder, the GPU atlas and the shaders are all built on 64-voxel bricks.
    if "brickSize" in man and not (_int(man["brickSize"]) and man["brickSize"] == BRICK_SIZE):
        return False, "manifest_bad_brick_size"
    for i, level in enumerate(levels):
        if not isinstance(level, dict):
            return False, f"manifest_level_{i}_not_object"
        lvl = level.get("level")
        if not _int(lvl) or lvl < 0:
            return False, f"manifest_level_{i}_bad_index"
        # A level is addressed by its number everywhere (lod<N>/ pack paths, the
        # quality ladder): listed out of order, one level's bricks mount as another's.
        if lvl != i:
            return False, f"manifest_level_{i}_out_of_order"
        dims = level.get("dimensions")
        if not isinstance(dims, dict):
            return False, f"manifest_level_{i}_no_dimensions"
        for axis in ("x", "y", "z"):
            v = dims.get(axis)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0:
                return False, f"manifest_level_{i}_bad_{axis}"
        if "brickSize" in level and not (_int(level["brickSize"]) and level["brickSize"] == BRICK_SIZE):
            return False, f"manifest_level_{i}_bad_brick_size"
    transport = man.get("brickTransport")
    encoding = transport.get("encoding") if isinstance(transport, dict) else None
    if encoding is not None and encoding not in _KNOWN_ENCODINGS:
        return False, "manifest_bad_encoding"
    # An absent packing is not "vertical": decoding a grid mosaic linearly scrambles
    # the volume silently. When present it must name a mode the decoder knows.
    packing = man.get("brickPacking")
    if packing is not None:
        if not isinstance(packing, dict) or packing.get("mode") not in ("grid", "vertical"):
            return False, "manifest_bad_packing_mode"
        if packing.get("mode") == "grid":
            for k in ("cols", "rows"):
                if k in packing and not (_int(packing[k]) and packing[k] >= 1):
                    return False, "manifest_bad_packing_grid"
    if encoding == "webp-lossless" and not (isinstance(packing, dict) and packing.get("mode") == "grid"):
        return False, "manifest_lossless_needs_grid"
    return True, None


def _validate_metadata(meta: dict, type_dir: str):
    """Same contract the admin editor enforces client-side (tab-datasets.js
    validateDatasetMeta), applied server-side so a hand-crafted POST cannot mount
    a malformed dataset (Rule 1.4).

    `type` is one vocabulary end to end — the pipeline writes it, the staging
    directory is named after it and the publish renames into DATA_WEB/<type>/ —
    so the two checks below are plain equalities, with nothing to translate."""
    declared = meta.get("type")
    # The mismatch is reported first because it is the actionable one: a word that
    # is no longer a type (a dataset from a pre-rename pipeline) is exactly as
    # wrong, in exactly the same way, as declaring another valid type.
    if declared != type_dir:
        return False, "metadata_type_mismatch"
    # Only reachable for a caller that did not go through _safe_dataset first.
    if declared not in ALLOWED_TYPE_DIRS:
        return False, "metadata_bad_type"
    dims = meta.get("dimensions")
    if not isinstance(dims, dict):
        return False, "metadata_no_dimensions"
    for axis in ("x", "y", "z", "c"):
        v = dims.get(axis)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0:
            return False, "metadata_bad_dimensions"
    if meta.get("type") == "2d":
        return _validate_2d_meta(meta)
    if not isinstance(meta.get("channels"), list) or not meta["channels"]:
        return False, "metadata_no_channels"
    return True, None


def _validate_2d_meta(meta: dict):
    """A 2d dataset mounts from its `image` block, not from channels. The file
    names are pinned to the allowlist so metadata cannot point elsewhere."""
    image = meta.get("image")
    if not isinstance(image, dict):
        return False, "metadata_no_image"
    if image.get("native") != "image.webp" or image.get("preview") != "preview.webp":
        return False, "metadata_bad_image"
    for key in ("width", "height"):
        v = image.get(key)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0:
            return False, "metadata_bad_image"
    return True, None


def validate_dataset(type_dir: str, folder: str) -> dict:
    """Whole-dataset structural check, run before a publish is allowed.

    Beyond per-file validity this proves the pieces fit together: the manifest's
    ``brickTransport.brickToPack`` index is the authoritative map from bricks to
    (pack, offset, length), so every pack it references must exist and be long
    enough to contain the slice claimed of it. A truncated pack that passed its
    own chunk hashes — because the client simply never sent the tail — is caught
    here rather than by a black viewport in the viewer.
    """
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return {"ok": False, "errors": ["invalid_dataset"]}
    type_dir, folder = safe
    ds_dir = staging_dataset_dir(type_dir, folder)
    journal = load_journal(type_dir, folder)
    errors: list[str] = []
    warnings: list[str] = []

    if ds_dir is None or journal is None:
        return {"ok": False, "errors": ["not_staged"]}

    meta_path = ds_dir / "metadata.json"
    if not meta_path.exists():
        errors.append("missing_metadata")
    else:
        meta = _read_json(meta_path)
        if meta is None:
            errors.append("metadata_not_json")
        else:
            ok, reason = _validate_metadata(meta, type_dir)
            if not ok:
                errors.append(reason or "metadata_invalid")

    if type_dir in VOLUME_TYPE_DIRS:
        errors.extend(_check_bricks(ds_dir))
    else:
        errors.extend(_check_2d_files(ds_dir))

    # Anything planned but not finished blocks the publish — a dataset is published
    # whole or not at all.
    incomplete = [rel for rel, e in (journal.get("files") or {}).items() if not e.get("done")]
    if incomplete:
        errors.append("incomplete_files")
        warnings.extend(sorted(incomplete)[:20])

    # A file on disk that no plan ever accepted means someone wrote into the
    # staging tree out of band. Refuse to publish rather than carry it across.
    stray = _find_stray(ds_dir, type_dir)
    if stray:
        errors.append("stray_files")
        warnings.extend(stray[:20])

    return {"ok": not errors, "errors": errors, "warnings": warnings}


def _cross_check_packs(ds_dir: Path, manifest: dict) -> list[str]:
    """Every pack the manifest references must exist and be long enough for the
    slice claimed of it.

    A ``brickToPack`` url is relative to the folder its OWN timepoint is mounted
    from — `js/core/brick-loader.js` resolves it against `.../bricks/t007`, not
    against `bricks/`. A timelapse therefore has to be walked frame by frame,
    prefixing each index with that frame's `path`; checking the root index bare
    would hunt for a 3d dataset's layout inside a timelapse and report every
    pack missing. The root index is a copy of the first frame's, so it is only
    consulted when the manifest declares no timepoints at all.
    """
    bricks_dir = ds_dir / "bricks"
    timepoints = manifest.get("timepoints")
    needed: dict[str, int] = {}

    if isinstance(timepoints, dict) and timepoints:
        for key, row in timepoints.items():
            if not isinstance(row, dict):
                continue
            path = row.get("path")
            prefix = path if isinstance(path, str) and path else key
            # No fallback to the root index: it is the FIRST frame's, and every
            # frame packs its own bricks at its own offsets, so reusing it would
            # invent truncations. A frame that indexes nothing is asserted nothing
            # about — its files are still covered by their own hashes and by the
            # incomplete-files check.
            unsafe = _collect_pack_extents(row.get("brickTransport"), needed, prefix)
            if unsafe:
                return unsafe
    else:
        unsafe = _collect_pack_extents(manifest.get("brickTransport"), needed, None)
        if unsafe:
            return unsafe

    errors = []
    for rel, end in needed.items():
        pack = (bricks_dir / Path(*rel.split("/"))).resolve()
        try:
            pack.relative_to(bricks_dir.resolve())
        except ValueError:
            errors.append("manifest_pack_escapes")
            continue
        if not pack.exists():
            errors.append(f"missing_pack:{rel}")
        elif pack.stat().st_size < end:
            errors.append(f"truncated_pack:{rel}")
        if len(errors) >= 20:
            break
    return errors


def _collect_pack_extents(transport, needed: dict, prefix: str | None) -> list[str]:
    """Fold one brickToPack index into {pack path: highest byte claimed of it}.

    Returns a non-empty list only to abort on an unsafe url; the extents it
    gathered are accumulated into ``needed`` in place.
    """
    if not isinstance(transport, dict):
        return []
    index = transport.get("brickToPack")
    if not isinstance(index, dict):
        return []
    for entry in index.values():
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not isinstance(url, str):
            continue
        rel = _safe_rel(f"{prefix}/{url}" if prefix else url)
        if rel is None:
            return ["manifest_unsafe_pack_url"]
        try:
            end = int(entry.get("offset", 0)) + int(entry.get("length", 0))
        except Exception:
            continue
        if end > needed.get(rel, 0):
            needed[rel] = end
    return []


def _find_stray(ds_dir: Path, type_dir: str) -> list[str]:
    """Every file physically present that the allowlist would refuse."""
    stray = []
    for dirpath, dirnames, filenames in os.walk(ds_dir):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith(_TMP_PREFIX):
                continue
            full = Path(dirpath) / name
            try:
                rel = full.relative_to(ds_dir).as_posix()
            except ValueError:
                continue
            if classify_path(type_dir, rel) is None:
                stray.append(rel)
                if len(stray) >= 50:
                    return stray
    return stray


# ── Dataset state ──────────────────────────────────────────────────────────────

def _check_bricks(ds_dir: Path) -> list[str]:
    man_path = ds_dir / "bricks" / "manifest.json"
    if not man_path.exists():
        return ["missing_manifest"]
    man = _read_json(man_path)
    if man is None:
        return ["manifest_not_json"]
    ok, reason = _validate_manifest(man)
    errors = [] if ok else [reason or "manifest_invalid"]
    if man.get("schema") == BRICKS_V3_SCHEMA:
        if ok:
            errors.extend(_cross_check_v3(ds_dir, man))
    else:
        errors.extend(_cross_check_packs(ds_dir, man))
    return errors


def _check_2d_files(ds_dir: Path) -> list[str]:
    """Both display copies must have arrived: the page paints the preview at once
    and swaps in the native image, so neither may be missing or empty."""
    errors = []
    for rel, (_, kind) in _IMAGE_2D_FILES.items():
        path = ds_dir / rel
        if not path.is_file() or path.stat().st_size == 0:
            errors.append(f"missing_{kind}")
    return errors


def dataset_state(type_dir: str, folder: str, journal: dict | None = None) -> str:
    if journal is None:
        journal = load_journal(type_dir, folder)
    if journal is None:
        return STATE_UPLOADING
    files = journal.get("files") or {}
    if not files:
        return STATE_UPLOADING

    pending = [e for e in files.values() if not e.get("done")]
    if not pending:
        return STATE_STAGED

    # Openable as soon as the mount prerequisites AND the coarsest LOD are in.
    core_ok = all(e.get("done") for e in files.values() if int(e.get("tier", 9)) <= TIER_PREVIEW)
    has_meta = files.get("metadata.json", {}).get("done")
    has_mount = any(e.get("done") for e in files.values() if e.get("kind") in _MOUNT_KINDS)
    if core_ok and has_meta and has_mount:
        state = STATE_EDITABLE
    else:
        state = STATE_UPLOADING

    last = journal.get("lastChunkAt") or journal.get("updatedAt")
    if last and _age_seconds(last) > STALE_AFTER_S:
        return STATE_STALLED
    return state


def _age_seconds(iso: str) -> float:
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds()
    except Exception:
        return 0.0


def describe(type_dir: str, folder: str) -> dict | None:
    """Full status of one staged dataset — what the admin UI renders."""
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return None
    type_dir, folder = safe
    journal = load_journal(type_dir, folder)
    if journal is None:
        return None
    files = {k: v for k, v in (journal.get("files") or {}).items() if isinstance(v, dict)}
    total = sum(int(e.get("size", 0)) for e in files.values())
    got = sum(int(e.get("size", 0)) if e.get("done") else received_bytes(e) for e in files.values())
    ds_dir = staging_dataset_dir(type_dir, folder)
    name = folder
    meta = _read_json(ds_dir / "metadata.json") if ds_dir else None
    if meta:
        name = meta.get("name") or folder
    last = journal.get("lastChunkAt") or journal.get("updatedAt") or journal.get("createdAt")
    state = dataset_state(type_dir, folder, journal)
    return {
        "key": dataset_key(type_dir, folder), "type": type_dir, "folder": folder,
        "name": name,
        "state": state,
        "totalBytes": total, "receivedBytes": got,
        "fileCount": len(files),
        "doneCount": sum(1 for e in files.values() if e.get("done")),
        "metaLocked": bool(journal.get("metaLocked")),
        "rejected": journal.get("rejected") or [],
        "publishedExists": (DATA_WEB / type_dir / folder / "metadata.json").exists(),
        "updatedAt": journal.get("updatedAt"),
        # The journal itself is only rewritten at plan/file completion; a long file
        # streams for hours in the chunk log alone, which still counts as activity.
        "lastActivityAt": max((t for t in (journal.get("updatedAt"), journal.get("lastChunkAt"))
                               if isinstance(t, str)), key=_age_key, default=None),
        # Only an INCOMPLETE import is on the clock (see gc()) — showing a
        # countdown on a finished one would promise a deletion that never comes.
        "expiresInS": (max(0, int(STALE_AFTER_S - _age_seconds(last)))
                       if last and state != STATE_STAGED else None),
        "hasThumbnail": bool(ds_dir and (ds_dir / "thumbnail.webp").exists()),
    }


def _age_key(iso: str) -> float:
    return -_age_seconds(iso)


def list_staged() -> list[dict]:
    out = []
    if not STATE_DIR.is_dir():
        return out
    for jp in sorted(STATE_DIR.glob("*.json")):
        stem = jp.stem
        if "__" not in stem:
            continue
        type_dir, folder = stem.split("__", 1)
        try:
            info = describe(type_dir, folder)
        except Exception as exc:  # one corrupt journal must not hide every other dataset
            print(f"[upload] journal {jp.name} unreadable: {exc}")
            continue
        if info:
            out.append(info)
    return out


# ── Metadata edit while streaming ──────────────────────────────────────────────

# Fields the server COMPUTES for the editor's view of a staged dataset (see
# dev_server._get_staged_dataset). They are derived state, not dataset facts —
# and the editor round-trips whatever it was given, so without this they would be
# written into metadata.json and then survive publication, leaving a published
# dataset permanently flagged "staging". Twin: _upload_lib.php LUMEN_UP_COMPUTED.
_COMPUTED_META_KEYS = frozenset({
    "staging", "stagingState", "stagingEditable", "path", "key",
    "totalBytes", "receivedBytes", "publishedExists", "expiresInS",
})


def read_staged_metadata(type_dir: str, folder: str) -> dict | None:
    ds_dir = staging_dataset_dir(type_dir, folder)
    if ds_dir is None:
        return None
    return _read_json(ds_dir / "metadata.json")


def write_staged_metadata(type_dir: str, folder: str, meta: dict) -> tuple[int, dict]:
    """Persist an operator edit to a staged dataset's metadata.json.

    Sets ``metaLocked``, which makes plan()/write_chunk() skip any later re-send of
    metadata.json. That is what lets the operator rename channels and set a preview
    while the packs are still arriving without the transfer overwriting their work.
    """
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return 400, {"error": "invalid_dataset"}
    type_dir, folder = safe
    ds_dir = staging_dataset_dir(type_dir, folder)
    if ds_dir is None:
        return 400, {"error": "invalid_dataset"}
    if not isinstance(meta, dict):
        return 400, {"error": "bad_body"}

    existing = _read_json(ds_dir / "metadata.json") or {}
    merged = dict(existing)
    merged.update({k: v for k, v in meta.items() if k not in _COMPUTED_META_KEYS})
    merged["type"] = type_dir
    merged["folderName"] = folder
    merged["id"] = dataset_key(type_dir, folder)   # one id shape everywhere: '<type>/<folder>'
    merged["configured"] = True
    merged["lastModified"] = datetime.now().isoformat()
    ok, reason = _validate_metadata(merged, type_dir)
    if not ok:
        return 400, {"error": reason}

    key = dataset_key(type_dir, folder)
    with _journal_lock(key):
        journal = load_journal(type_dir, folder)
        if journal is None:
            return 409, {"error": "not_staged"}
        _make_dir(ds_dir)
        _atomic_write_json(ds_dir / "metadata.json", merged)
        journal["metaLocked"] = True
        entry = journal.setdefault("files", {}).setdefault(
            "metadata.json", {"chunkSize": DEFAULT_CHUNK_SIZE, "kind": "metadata", "tier": TIER_CORE})
        entry["size"] = (ds_dir / "metadata.json").stat().st_size
        entry["done"] = True
        entry["bits"] = _bitmap_encode(bytearray(1))
        _new_id(journal, entry)
        save_journal(journal)
        _write_table(journal)
    return 200, {"ok": True}


def save_staged_thumbnail(type_dir: str, folder: str, image_bytes: bytes) -> tuple[int, dict]:
    ds_dir = staging_dataset_dir(type_dir, folder)
    if ds_dir is None:
        return 400, {"error": "invalid_dataset"}
    if not (image_bytes[:4] == b"RIFF" or image_bytes[:8] == _MAGIC["png"][0]):
        return 400, {"error": "not_an_image"}
    key = dataset_key(type_dir, folder)
    with _journal_lock(key):
        journal = load_journal(type_dir, folder)
        if journal is None:
            return 409, {"error": "not_staged"}
        _atomic_write_bytes(ds_dir / "thumbnail.webp", image_bytes)
        entry = journal.setdefault("files", {}).setdefault(
            "thumbnail.webp", {"chunkSize": DEFAULT_CHUNK_SIZE, "kind": "thumbnail", "tier": TIER_CORE})
        entry["size"] = len(image_bytes)
        entry["done"] = True
        entry["bits"] = _bitmap_encode(bytearray(1))
        _new_id(journal, entry)
        save_journal(journal)
        _write_table(journal)
    return 200, {"ok": True}


# ── Publish ────────────────────────────────────────────────────────────────────

def publish_dataset(type_dir: str, folder: str, *, overwrite: bool = False,
                    hidden: bool = True) -> tuple[int, dict]:
    """Move a validated staged dataset into DATA_WEB.

    Published hidden by default: the operator decides when it appears in the
    public explorer, and a fresh import never surprises visitors. The move is a
    rename when staging and DATA_WEB share a filesystem (near-atomic); otherwise
    it copies into a sibling temp dir first and renames that into place, so a
    half-copied dataset is never visible under its final name.
    """
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return 400, {"error": "invalid_dataset"}
    type_dir, folder = safe
    src = staging_dataset_dir(type_dir, folder)
    if src is None or not src.is_dir():
        return 404, {"error": "not_staged"}

    verdict = validate_dataset(type_dir, folder)
    if not verdict.get("ok"):
        return 409, {"error": "validation_failed", **verdict}

    dest_base = (DATA_WEB / type_dir).resolve()
    dest = (dest_base / folder).resolve()
    try:
        dest.relative_to(dest_base)
    except ValueError:
        return 400, {"error": "invalid_dataset"}
    if dest.exists() and not overwrite:
        return 409, {"error": "already_exists"}

    key = dataset_key(type_dir, folder)
    carried = {"carriedKeys": [], "carriedGallery": False}
    with _journal_lock(key):
        meta = _read_json(src / "metadata.json") or {}
        changed = False
        if dest.exists():
            # Re-publishing over a live dataset replaces what the pipeline measures,
            # not what the operator curated (orientation, names, gallery…): those keys
            # are carried over unless the new upload states them itself.
            old_meta = _read_json(dest / "metadata.json") or {}
            for k in CURATED_KEYS:
                if k in old_meta and k not in meta:
                    meta[k] = old_meta[k]
                    carried["carriedKeys"].append(k)
                    changed = True
        if hidden:
            meta["hidden"] = True
            changed = True
        if changed:
            _atomic_write_json(src / "metadata.json", meta)
        _sweep_tmp_files(src)

        _make_dir(dest_base)
        replaced = None
        tmp = None
        try:
            if dest.exists():
                # Dot-prefixed, so neither the catalog nor a static URL ever sees it
                # (dev_server skips dot-folders and dot-segments).
                replaced = dest_base / f".replaced-{folder}-{int(time.time())}"
                _replace_retry(dest, replaced)
            try:
                _replace_retry(src, dest)
            except OSError:
                # Cross-device (staging on another volume): copy to a temp sibling,
                # then rename it into place so `dest` is never partially populated.
                tmp = dest_base / f".incoming-{folder}-{int(time.time())}"
                if tmp.exists():
                    shutil.rmtree(tmp, ignore_errors=True)
                shutil.copytree(src, tmp)
                _replace_retry(tmp, dest)
                tmp = None
                shutil.rmtree(src, ignore_errors=True)
        except OSError as exc:
            if tmp is not None:
                shutil.rmtree(tmp, ignore_errors=True)
            if replaced is not None and not dest.exists():
                try:
                    _replace_retry(replaced, dest)
                    replaced = None
                except OSError:
                    pass
            if _is_disk_full(exc):
                return 507, {"error": "insufficient_disk", "freeBytes": _free_bytes(DATA_WEB)}
            return 500, {"error": "publish_failed", "detail": exc.__class__.__name__}

        if replaced is not None:
            carried["carriedGallery"] = _carry_gallery(replaced, dest)
            # A file still held open (a viewer streaming a pack, an AV scan) makes
            # this fail on Windows; whatever survives is dot-named, invisible, and
            # reclaimed by recover_publish_leftovers() at the next start.
            shutil.rmtree(replaced, ignore_errors=True)

        _remove_state_files(type_dir, folder)
        _prune_empty(STAGING_DIR / type_dir)

    return 200, {"ok": True, "id": key, "hidden": hidden, **carried}


# Twin of preprocess/run_preprocess.py CURATED_KEYS — read, not imported (the
# server never imports the pipeline). `formatVersion` is pipeline-owned and must
# never be carried over a freshly produced value.
CURATED_KEYS = (
    "name", "description", "stage", "stageNumeric", "embryo", "line", "staining",
    "reporter", "hidden", "gallery", "tags", "notes", "created",
    "orientation", "orientationAxes", "upsideDown", "defaultView", "exposure",
    "linkedTrackingId", "relatedIds",
)
GALLERY_DIRNAME = "gallery"


def _carry_gallery(old_dir: Path, new_dir: Path) -> bool:
    """Move the replaced dataset's gallery/ (images + thumbnails) into the new one.

    An import never carries a gallery/ of its own (the allowlist has no rule for
    it), so the old folder is the only copy. Afterwards the gallery list in the new
    metadata.json keeps only entries whose file is really there."""
    src = old_dir / GALLERY_DIRNAME
    dst = new_dir / GALLERY_DIRNAME
    moved = False
    if src.is_dir() and not dst.exists():
        try:
            _replace_retry(src, dst)
            moved = True
        except OSError:
            try:
                shutil.copytree(src, dst)
                moved = True
            except OSError:
                shutil.rmtree(dst, ignore_errors=True)
    meta_path = new_dir / "metadata.json"
    meta = _read_json(meta_path)
    if isinstance(meta, dict) and isinstance(meta.get("gallery"), list):
        kept = [e for e in meta["gallery"]
                if isinstance(e, dict) and _gallery_file_present(dst, e.get("file"))]
        if kept != meta["gallery"]:
            if kept:
                meta["gallery"] = kept
            else:
                meta.pop("gallery", None)
            try:
                _atomic_write_json(meta_path, meta)
            except OSError:
                pass
    return moved


def _gallery_file_present(gdir: Path, name) -> bool:
    if not isinstance(name, str):
        return False
    name = name.replace("\\", "/").strip("/")
    if name.startswith(GALLERY_DIRNAME + "/"):
        name = name[len(GALLERY_DIRNAME) + 1:]
    if not name or "/" in name or name.startswith("."):
        return False
    return (gdir / name).is_file()


def _sweep_tmp_files(ds_dir: Path) -> None:
    """Remove our own atomic-write temp files left by a crash, so they are never
    carried into DATA_WEB with the dataset."""
    for dirpath, dirnames, filenames in os.walk(ds_dir):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith(_TMP_PREFIX):
                try:
                    os.unlink(os.path.join(dirpath, name))
                except OSError:
                    pass


_RE_REPLACED = re.compile(r"^\.replaced-(.+)-(\d+)$")
_RE_INCOMING = re.compile(r"^\.incoming-(.+)-(\d+)$")


def recover_publish_leftovers() -> list[str]:
    """Settle what an interrupted publish left in DATA_WEB/<type>/.

    ``.replaced-<folder>-<ts>``: the previous copy of a dataset. If ``<folder>``
    itself is missing, the crash fell between the two renames, so the old copy
    is put back; otherwise it is deleted. ``.incoming-<folder>-<ts>``: a partial
    cross-volume copy, always deleted. Run at server start; idempotent. Returns
    one line per action for the log.
    """
    log = []
    for type_dir in ALLOWED_TYPE_DIRS:
        base = DATA_WEB / type_dir
        if not base.is_dir():
            continue
        try:
            names = sorted(e.name for e in os.scandir(base) if e.is_dir(follow_symlinks=False))
        except OSError:
            continue
        for name in names:
            path = base / name
            m = _RE_REPLACED.match(name)
            if m:
                folder = m.group(1)
                live = base / folder
                if _SAFE_FOLDER_RE.match(folder) and not live.exists():
                    try:
                        _replace_retry(path, live)
                        log.append(f"restored {type_dir}/{folder} from an interrupted publish")
                        continue
                    except OSError as exc:
                        log.append(f"FAILED restoring {type_dir}/{folder}: {exc}")
                        continue
                shutil.rmtree(path, ignore_errors=True)
                log.append(("removed " if not path.exists() else "could not fully remove ")
                           + f"{type_dir}/{name}")
            elif _RE_INCOMING.match(name):
                shutil.rmtree(path, ignore_errors=True)
                log.append(("removed " if not path.exists() else "could not fully remove ")
                           + f"{type_dir}/{name}")
    return log


def discard_dataset(type_dir: str, folder: str) -> tuple[int, dict]:
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return 400, {"error": "invalid_dataset"}
    type_dir, folder = safe
    src = staging_dataset_dir(type_dir, folder)
    with _journal_lock(dataset_key(type_dir, folder)):
        if src is not None and src.is_dir():
            shutil.rmtree(src, ignore_errors=True)
        _remove_state_files(type_dir, folder)
        _prune_empty(STAGING_DIR / type_dir)
    return 200, {"ok": True}


def _prune_empty(path: Path) -> None:
    try:
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()
    except OSError:
        pass


def gc(max_age_s: int = STALE_AFTER_S) -> dict:
    """Reclaim INCOMPLETE imports untouched for longer than the grace period.

    Called opportunistically on every ``list`` so an abandoned transfer cannot pin
    disk forever, and exposed as an explicit action for the admin UI.

    A dataset in STATE_STAGED is deliberately exempt. It is complete, it passed
    validation, and the only thing left is a human clicking Publish — reclaiming
    that after a week away would delete tens of gigabytes of finished work to save
    the operator a re-upload they never asked for. The grace period covers uploads
    that DIED, which is what it was asked to cover.
    """
    result, _ = gc_and_list(max_age_s)
    return result


def gc_and_list(max_age_s: int = STALE_AFTER_S) -> tuple[dict, list[dict]]:
    """gc() plus the descriptions of what it kept — the admin list needs both, and
    walking every journal twice per poll was half its cost."""
    removed, kept = [], []
    for info in list_staged():
        last = info.get("lastActivityAt") or info.get("updatedAt")
        expired = last and _age_seconds(last) > max_age_s
        if expired and info.get("state") != STATE_STAGED:
            discard_dataset(info["type"], info["folder"])
            removed.append(info["key"])
        else:
            kept.append(info)
    return {"removed": removed, "kept": len(kept)}, kept


# ── Directory guards (.htaccess written at runtime) ──────────────────────────
# Twins of api/_admin_lib.php lumen_exec_ban_rules / lumen_data_web_guard /
# lumen_staging_guard / lumen_media_guard: the SAME bytes, so the two backends and
# the copy shipped in the repository (DATA_WEB/.htaccess) stop rewriting one
# another. A guard is (re)written only when the file lacks GUARD_MARKER. Every
# directive sits in an <IfModule> guard and none uses `Options` (a 500 on hosts
# that only allow FileInfo/AuthConfig overrides).
GUARD_MARKER = "lumen-guard v2"

EXEC_BAN_RULES = (
    "<IfModule mod_php.c>\n    php_flag engine off\n</IfModule>\n"
    "<IfModule mod_php7.c>\n    php_flag engine off\n</IfModule>\n"
    "<IfModule mod_php5.c>\n    php_flag engine off\n</IfModule>\n"
    '<FilesMatch "\\.(php|php[0-9]|phtml|phps|phar|cgi|pl|py|sh|shtml|htaccess)$">\n'
    "    <IfModule mod_authz_core.c>\n        Require all denied\n    </IfModule>\n"
    "    <IfModule !mod_authz_core.c>\n        Order allow,deny\n        Deny from all\n    </IfModule>\n"
    "</FilesMatch>\n"
    "<IfModule mod_mime.c>\n    RemoveHandler .php .phtml .phar .cgi .pl .py .sh .shtml\n"
    "    RemoveType .php .phtml .phar\n</IfModule>\n"
)

# DATA_WEB is web-served by construction, so it is the one directory that is both
# operator-writable and reachable. The import allowlist already refuses anything
# the pipeline does not emit, but a dataset can also arrive by SFTP or rsync. Every
# file under a dataset's download/ folder is served as an attachment: an operator-
# supplied XML or HTML report must never render as a document of this origin.
DATA_WEB_GUARD = (
    f"# Lumen3D — published dataset tree ({GUARD_MARKER}). Generated by the\n"
    "# platform (api/_upload_lib.php, upload_staging.py); keep the copy in the\n"
    "# repository (DATA_WEB/.htaccess) identical.\n"
    + EXEC_BAN_RULES
    + "<IfModule mod_headers.c>\n"
    '    Header set X-Content-Type-Options "nosniff"\n'
    "    <IfModule mod_setenvif.c>\n"
    '        SetEnvIf Request_URI "/download/" LUMEN_DOWNLOAD=1\n'
    '        Header set Content-Disposition "attachment" env=LUMEN_DOWNLOAD\n'
    "    </IfModule>\n"
    "</IfModule>\n"
)

STAGING_GUARD = (
    f"# Lumen3D upload staging ({GUARD_MARKER}) — bytes here have NOT been\n"
    "# validated yet and must never be reachable at a URL. The admin preview reads\n"
    "# them through the authenticated api/upload.php?action=blob proxy instead.\n"
    "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n"
    "<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n"
    "<IfModule mod_php.c>\n    php_flag engine off\n</IfModule>\n"
    "<IfModule mod_php7.c>\n    php_flag engine off\n</IfModule>\n"
)

# config/uploads/ (the media library): images only, never a script.
MEDIA_GUARD = (
    f"# Lumen3D media library ({GUARD_MARKER}). Generated by api/media.php.\n"
    + EXEC_BAN_RULES
    + '<IfModule mod_headers.c>\n    Header set X-Content-Type-Options "nosniff"\n</IfModule>\n'
)


def write_guard(path: Path, body: str) -> None:
    """Write ``body`` to ``path`` when its directory exists and the file lacks the
    current marker (a guard already written by either backend is left alone)."""
    try:
        if not path.parent.is_dir():
            return
        if path.exists() and GUARD_MARKER in path.read_text(encoding="utf-8", errors="replace"):
            return
        _atomic_write_bytes(path, body.encode("utf-8"))
    except OSError:
        pass


def ensure_dirs() -> None:
    """Create the staging root and (re)assert both directory guards.

    Written at runtime rather than relying on the shipped files: DATA_WEB is in
    the updater's protect list, so a deployed host would otherwise NEVER receive
    its execution ban through an update, and a staging root created at runtime
    would have no deny rule at all until the next release.
    """
    _make_dir(STAGING_DIR)
    _make_dir(STATE_DIR)
    write_guard(UPLOADS_DIR / ".htaccess", STAGING_GUARD)
    _make_dir(DATA_WEB)
    write_guard(DATA_WEB / ".htaccess", DATA_WEB_GUARD)
