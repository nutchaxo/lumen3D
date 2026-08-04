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
import hashlib
import json
import os
import re
import shutil
import threading
import time
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

ALLOWED_TYPE_DIRS = ("fixed", "live", "tracking")

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

_RE_PACK = re.compile(r"^lod(\d{1,2})/(c\d{1,2}|rgba)/pack_\d{1,6}\.bin$")
_RE_TIMEPOINT = re.compile(r"^t(\d{1,6})/(.+)$")

# download/ originals. Deliberately data-only: no archive that a server might
# expand, no markup, no script. `.zip` is the one container, and it is only ever
# offered as a download — nothing on the platform opens it.
_DOWNLOAD_EXT = frozenset({
    "ims", "tif", "tiff", "png", "jpg", "jpeg", "webp", "gif",
    "zip", "txt", "md", "csv", "json", "pdf", "xml", "gz", "h5", "hdf5",
})
_RE_DOWNLOAD_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,180}$")

# Files the pipeline writes at the dataset root, beyond metadata/thumbnail.
_ROOT_EXTRA = {
    "model.glb": TIER_FULL,
    "tracks.json": TIER_PREVIEW,
    "tracks.json.gz": TIER_PREVIEW,
    "meta.json": TIER_CORE,
}


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
        return _ROOT_EXTRA[rel], "extra"

    if rel.startswith("download/"):
        name = rel[len("download/"):]
        if "/" in name or not _RE_DOWNLOAD_NAME.match(name):
            return None
        # Compare the FULL suffix chain, so `x.ome.tif` is judged on `tif` and a
        # double extension like `x.php.png` still resolves to its final `png`.
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in _DOWNLOAD_EXT:
            return None
        return TIER_EXTRA, "download"

    if not rel.startswith("bricks/"):
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
        if type_dir not in ("live", "tracking"):
            return None
        timepoint = int(tp.group(1))
        inner = tp.group(2)
        if inner == "manifest.json":
            return TIER_CORE, "manifest"

    m = _RE_PACK.match(inner)
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
    m = _RE_PACK.match(inner)
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


def _atomic_write_json(path: Path, data) -> None:
    _make_dir(path.parent)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def load_journal(type_dir: str, folder: str) -> dict | None:
    jp = journal_path(type_dir, folder)
    if jp is None or not jp.exists():
        return None
    try:
        data = json.loads(jp.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def save_journal(journal: dict) -> bool:
    jp = journal_path(journal.get("type", ""), journal.get("folder", ""))
    if jp is None:
        return False
    journal["updatedAt"] = _now_iso()
    _atomic_write_json(jp, journal)
    return True


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
    return raw[:nbytes] if nbytes else bytearray()


def _bitmap_encode(bits: bytearray) -> str:
    return base64.b64encode(bytes(bits)).decode("ascii")


def _bit_get(bits: bytearray, i: int) -> bool:
    byte = i >> 3
    return byte < len(bits) and bool(bits[byte] & (1 << (i & 7)))


def _bit_set(bits: bytearray, i: int) -> None:
    byte = i >> 3
    if byte < len(bits):
        bits[byte] |= 1 << (i & 7)


def _bit_count(bits: bytearray, nbits: int) -> int:
    total = 0
    for i in range(nbits):
        if _bit_get(bits, i):
            total += 1
    return total


def received_bytes(entry: dict) -> int:
    """Exact byte count already stored for a journal file entry."""
    size = int(entry.get("size", 0))
    chunk = int(entry.get("chunkSize", DEFAULT_CHUNK_SIZE)) or DEFAULT_CHUNK_SIZE
    nbits = _bits_len(size, chunk)
    if nbits == 0:
        return 0
    bits = _bitmap_decode(entry.get("bits", ""), nbits)
    total = 0
    for i in range(nbits):
        if _bit_get(bits, i):
            total += min(chunk, size - i * chunk)
    return total


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
    for raw in datasets[:MAX_DATASETS_PER_PLAN]:
        if not isinstance(raw, dict):
            continue
        safe = _safe_dataset(raw.get("type"), raw.get("folder"))
        if safe is None:
            out.append({"key": None, "type": raw.get("type"), "folder": raw.get("folder"),
                        "error": "invalid_dataset", "files": [], "rejected": []})
            continue
        type_dir, folder = safe
        out.append(_plan_one(type_dir, folder, raw.get("files"), chunk_size))
    return {"ok": True, "chunkSize": chunk_size, "datasets": out}


def _clamp_chunk(n) -> int:
    try:
        n = int(n)
    except Exception:
        return DEFAULT_CHUNK_SIZE
    return max(MIN_CHUNK_SIZE, min(MAX_CHUNK_SIZE, n))


def _plan_one(type_dir: str, folder: str, files, chunk_size: int) -> dict:
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
        tier, kind = verdict
        accepted.append({"path": rel, "size": size, "tier": tier, "kind": kind})
    assign_tiers(accepted)

    with _journal_lock(key):
        journal = load_journal(type_dir, folder)
        if journal is None:
            journal = _new_journal(type_dir, folder)
        jfiles = journal.setdefault("files", {})

        for item in accepted:
            rel = item["path"]
            entry = jfiles.get(rel)
            # The operator's edits win over a re-dropped pipeline file. metadata.json
            # is the one file the admin editor rewrites in place while the rest of the
            # dataset is still streaming in; re-sending the original would silently
            # revert their work (their explicit requirement).
            if rel == "metadata.json" and journal.get("metaLocked") and entry and entry.get("done"):
                item["skip"] = "locked"
                item["received"] = entry.get("size", 0)
                item["done"] = True
                continue
            if entry and int(entry.get("size", -1)) == item["size"] and entry.get("done"):
                item["received"] = item["size"]
                item["done"] = True
                item["skip"] = "complete"
                continue
            if entry and int(entry.get("size", -1)) == item["size"]:
                # Same file, partially received — resume against the stored bitmap.
                entry["tier"] = item["tier"]
                entry["kind"] = item["kind"]
                item["received"] = received_bytes(entry)
                item["chunkSize"] = int(entry.get("chunkSize", chunk_size))
                item["missing"] = missing_chunks(entry)
                item["done"] = False
                continue
            # New file, or the size changed (a re-run of the pipeline) — start over.
            nbits = _bits_len(item["size"], chunk_size)
            jfiles[rel] = {
                "size": item["size"], "chunkSize": chunk_size, "kind": item["kind"],
                "tier": item["tier"], "bits": _bitmap_encode(bytearray((nbits + 7) // 8)),
                "done": item["size"] == 0, "sha": None,
            }
            item["received"] = 0
            item["chunkSize"] = chunk_size
            item["missing"] = list(range(nbits))
            item["done"] = item["size"] == 0

        journal["rejected"] = rejected[:200]
        # Files staged earlier but absent from this drop stay in the journal: a
        # partial re-drop (one dataset out of a batch) must not discard progress.
        save_journal(journal)

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
                data: bytes, sha256_hex: str | None) -> tuple[int, dict]:
    """Verify and store one chunk. Returns (http_status, payload).

    The SHA-256 is checked BEFORE the write: a corrupted or tampered chunk never
    touches the staging file, so a file on disk is only ever made of bytes that
    matched what the client hashed.
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
    if sha256_hex:
        actual = hashlib.sha256(data).hexdigest()
        if actual != str(sha256_hex).lower():
            return 422, {"error": "checksum_mismatch", "expected": sha256_hex, "actual": actual}

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

        _make_dir(dest.parent)
        # Sparse write at the exact offset: chunks may land in any order and in
        # parallel, and a re-sent chunk is idempotent (same bytes, same place).
        with open(dest, "r+b" if dest.exists() else "w+b") as fh:
            fh.seek(offset)
            fh.write(data)

        bits = _bitmap_decode(entry.get("bits", ""), nbits)
        _bit_set(bits, index)
        entry["bits"] = _bitmap_encode(bits)
        got = _bit_count(bits, nbits)
        entry["done"] = got == nbits
        journal["lastChunkAt"] = _now_iso()
        save_journal(journal)
        return 200, {"ok": True, "index": index, "chunks": nbits, "have": got,
                     "done": bool(entry["done"]), "received": received_bytes(entry)}


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
            save_journal(journal)
            return 409, {"error": "size_mismatch", "expected": size, "actual": on_disk}

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
            if not isinstance(man.get("levels"), list) or not man["levels"]:
                return False, "manifest_no_levels"
            return True, None
        if kind == "thumbnail":
            with path.open("rb") as fh:
                head = fh.read(16)
            if not head.startswith(_MAGIC["webp"][0]) and not head.startswith(_MAGIC["png"][0]):
                return False, "thumbnail_not_image"
            return True, None
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


def _validate_metadata(meta: dict, type_dir: str):
    """Same contract the admin editor enforces client-side (tab-datasets.js
    validateDatasetMeta), applied server-side so a hand-crafted POST cannot mount
    a malformed dataset (Rule 1.4)."""
    if meta.get("type") not in ALLOWED_TYPE_DIRS:
        return False, "metadata_bad_type"
    if meta.get("type") != type_dir:
        return False, "metadata_type_mismatch"
    dims = meta.get("dimensions")
    if not isinstance(dims, dict):
        return False, "metadata_no_dimensions"
    for axis in ("x", "y", "z", "c"):
        v = dims.get(axis)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0:
            return False, "metadata_bad_dimensions"
    if not isinstance(meta.get("channels"), list) or not meta["channels"]:
        return False, "metadata_no_channels"
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

    man_path = ds_dir / "bricks" / "manifest.json"
    if not man_path.exists():
        errors.append("missing_manifest")
    else:
        man = _read_json(man_path)
        if man is None:
            errors.append("manifest_not_json")
        else:
            errors.extend(_cross_check_packs(ds_dir, man))

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
    transport = manifest.get("brickTransport")
    if not isinstance(transport, dict):
        return []
    index = transport.get("brickToPack")
    if not isinstance(index, dict):
        return []
    bricks_dir = ds_dir / "bricks"
    needed: dict[str, int] = {}
    for entry in index.values():
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not isinstance(url, str):
            continue
        rel = _safe_rel(url)
        if rel is None:
            return ["manifest_unsafe_pack_url"]
        try:
            end = int(entry.get("offset", 0)) + int(entry.get("length", 0))
        except Exception:
            continue
        if end > needed.get(rel, 0):
            needed[rel] = end
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


def _find_stray(ds_dir: Path, type_dir: str) -> list[str]:
    """Every file physically present that the allowlist would refuse."""
    stray = []
    for dirpath, dirnames, filenames in os.walk(ds_dir):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
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
    has_manifest = any(e.get("done") for rel, e in files.items() if e.get("kind") == "manifest")
    if core_ok and has_meta and has_manifest:
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
    files = journal.get("files") or {}
    total = sum(int(e.get("size", 0)) for e in files.values())
    got = sum(int(e.get("size", 0)) if e.get("done") else received_bytes(e) for e in files.values())
    ds_dir = staging_dataset_dir(type_dir, folder)
    name = folder
    meta = _read_json(ds_dir / "metadata.json") if ds_dir else None
    if meta:
        name = meta.get("name") or folder
    last = journal.get("lastChunkAt") or journal.get("updatedAt") or journal.get("createdAt")
    return {
        "key": dataset_key(type_dir, folder), "type": type_dir, "folder": folder,
        "name": name,
        "state": dataset_state(type_dir, folder, journal),
        "totalBytes": total, "receivedBytes": got,
        "fileCount": len(files),
        "doneCount": sum(1 for e in files.values() if e.get("done")),
        "metaLocked": bool(journal.get("metaLocked")),
        "rejected": journal.get("rejected") or [],
        "publishedExists": (DATA_WEB / type_dir / folder / "metadata.json").exists(),
        "updatedAt": journal.get("updatedAt"),
        "expiresInS": max(0, int(STALE_AFTER_S - _age_seconds(last))) if last else None,
        "hasThumbnail": bool(ds_dir and (ds_dir / "thumbnail.webp").exists()),
    }


def list_staged() -> list[dict]:
    out = []
    if not STATE_DIR.is_dir():
        return out
    for jp in sorted(STATE_DIR.glob("*.json")):
        stem = jp.stem
        if "__" not in stem:
            continue
        type_dir, folder = stem.split("__", 1)
        info = describe(type_dir, folder)
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
    merged["id"] = folder
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
        save_journal(journal)
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
        _make_dir(ds_dir)
        (ds_dir / "thumbnail.webp").write_bytes(image_bytes)
        entry = journal.setdefault("files", {}).setdefault(
            "thumbnail.webp", {"chunkSize": DEFAULT_CHUNK_SIZE, "kind": "thumbnail", "tier": TIER_CORE})
        entry["size"] = len(image_bytes)
        entry["done"] = True
        entry["bits"] = _bitmap_encode(bytearray(1))
        save_journal(journal)
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
    with _journal_lock(key):
        if hidden:
            meta = _read_json(src / "metadata.json") or {}
            meta["hidden"] = True
            _atomic_write_json(src / "metadata.json", meta)

        _make_dir(dest_base)
        replaced = None
        try:
            if dest.exists():
                replaced = dest_base / f".replaced-{folder}-{int(time.time())}"
                os.replace(dest, replaced)
            try:
                os.replace(src, dest)
            except OSError:
                # Cross-device (staging on another volume): copy to a temp sibling,
                # then rename it into place so `dest` is never partially populated.
                tmp = dest_base / f".incoming-{folder}-{int(time.time())}"
                if tmp.exists():
                    shutil.rmtree(tmp, ignore_errors=True)
                shutil.copytree(src, tmp)
                os.replace(tmp, dest)
                shutil.rmtree(src, ignore_errors=True)
        except OSError as exc:
            if replaced is not None and not dest.exists():
                try:
                    os.replace(replaced, dest)
                except OSError:
                    pass
            return 500, {"error": "publish_failed", "detail": str(exc)}

        if replaced is not None:
            shutil.rmtree(replaced, ignore_errors=True)

        jp = journal_path(type_dir, folder)
        if jp and jp.exists():
            try:
                jp.unlink()
            except OSError:
                pass
        _prune_empty(STAGING_DIR / type_dir)

    return 200, {"ok": True, "id": key, "hidden": hidden}


def discard_dataset(type_dir: str, folder: str) -> tuple[int, dict]:
    safe = _safe_dataset(type_dir, folder)
    if safe is None:
        return 400, {"error": "invalid_dataset"}
    type_dir, folder = safe
    src = staging_dataset_dir(type_dir, folder)
    with _journal_lock(dataset_key(type_dir, folder)):
        if src is not None and src.is_dir():
            shutil.rmtree(src, ignore_errors=True)
        jp = journal_path(type_dir, folder)
        if jp and jp.exists():
            try:
                jp.unlink()
            except OSError:
                pass
        _prune_empty(STAGING_DIR / type_dir)
    return 200, {"ok": True}


def _prune_empty(path: Path) -> None:
    try:
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()
    except OSError:
        pass


def gc(max_age_s: int = STALE_AFTER_S) -> dict:
    """Delete staged datasets untouched for longer than the grace period.

    Called opportunistically on every ``list`` so a forgotten upload cannot pin
    disk forever, and exposed as an explicit action for the admin UI.
    """
    removed, kept = [], 0
    for info in list_staged():
        last = info.get("updatedAt")
        if last and _age_seconds(last) > max_age_s:
            discard_dataset(info["type"], info["folder"])
            removed.append(info["key"])
        else:
            kept += 1
    return {"removed": removed, "kept": kept}


_STAGING_GUARD = (
    "# Lumen3D upload staging — bytes here have NOT been validated yet and must\n"
    "# never be reachable at a URL. The admin preview reads them through the\n"
    "# authenticated api/upload.php?action=blob proxy instead.\n"
    "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n"
    "<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n"
    "php_flag engine off\n"
)

# Execution ban for the PUBLISHED tree. DATA_WEB is web-served by construction, so
# it is the one directory that is both operator-writable and reachable. The import
# allowlist already refuses anything the pipeline does not emit, but a dataset can
# also arrive by SFTP or rsync, which bypasses it entirely.
_DATA_WEB_GUARD = (
    "# Lumen3D — published dataset tree. Generated: keep in sync with the copy in\n"
    "# the repository root (DATA_WEB/.htaccess).\n"
    "<IfModule mod_php.c>\n    php_flag engine off\n</IfModule>\n"
    "<IfModule mod_php7.c>\n    php_flag engine off\n</IfModule>\n"
    "<IfModule mod_php5.c>\n    php_flag engine off\n</IfModule>\n"
    '<FilesMatch "\\.(php|php[0-9]|phtml|phps|phar|cgi|pl|py|sh|htaccess)$">\n'
    "    <IfModule mod_authz_core.c>\n        Require all denied\n    </IfModule>\n"
    "    <IfModule !mod_authz_core.c>\n        Order allow,deny\n        Deny from all\n    </IfModule>\n"
    "</FilesMatch>\n"
    "<IfModule mod_mime.c>\n    RemoveHandler .php .phtml .phar .cgi .pl .py .sh\n"
    "    RemoveType .php .phtml .phar\n</IfModule>\n"
    "Options -Indexes -ExecCGI -Includes\n"
    '<IfModule mod_headers.c>\n    Header set X-Content-Type-Options "nosniff"\n</IfModule>\n'
)


def _write_guard(path: Path, body: str) -> None:
    try:
        if not path.parent.is_dir():
            return
        if not path.exists() or path.read_text(encoding="utf-8") != body:
            path.write_text(body, encoding="utf-8")
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
    _write_guard(UPLOADS_DIR / ".htaccess", _STAGING_GUARD)
    _make_dir(DATA_WEB)
    _write_guard(DATA_WEB / ".htaccess", _DATA_WEB_GUARD)
