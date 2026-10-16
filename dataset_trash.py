"""Dataset trash (admin Datasets tab "Delete" button).

Deleting a published dataset MOVES its folder to ``uploads/trash/<trashId>/data``
(a rename on the same volume: instant whatever the size) and writes
``uploads/trash/<trashId>/entry.json`` beside it. The trash is under ``uploads/``,
which is never web-served and never touched by an update.

* ``trashId`` is ``<type>__<folder>__<UTC stamp>-<random>``: it is unique per
  deletion, so the same dataset name can be deleted any number of times (delete,
  re-upload, delete again ...) and every copy stays in the trash side by side.
* An entry is kept ``RETENTION_DAYS`` days and then reclaimed (``purge_expired``,
  run on every list).
* Restoring puts the folder back under its original id. If a dataset of that name
  exists meanwhile (it was re-uploaded) the call answers 409 ``exists`` with a free
  ``suggested`` folder; the caller restores under that name or purges instead.

Twin of api/_trash_lib.php (same layout, same entry.json, same rules): a host can
move between the two backends without losing its trash.
"""

from __future__ import annotations

import errno
import json
import math
import os
import re
import secrets
import shutil
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

RETENTION_DAYS = 60
TRASH_DIRNAME = "trash"
ENTRY_FILE = "entry.json"
DATA_DIRNAME = "data"
ALLOWED_TYPE_DIRS = ("3d", "2d", "live")

_SAFE_FOLDER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")
_TRASH_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$")
# An entry whose data/ never arrived (killed between the two steps) is reclaimed
# once it is clearly not a delete in flight.
_ORPHAN_GRACE_S = 3600


def trash_root(uploads: Path) -> Path:
    return Path(uploads) / TRASH_DIRNAME


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _rmtree(path: Path) -> None:
    def _onerror(func, p, _exc):
        # A read-only file (Windows) blocks its own unlink: clear the bit and retry.
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    shutil.rmtree(path, onerror=_onerror)


def _tree_bytes(path: Path) -> int | None:
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.stat(os.path.join(root, name)).st_size
                except OSError:
                    pass
    except OSError:
        return None
    return total


def _write_json_atomic(path: Path, doc: dict) -> None:
    tmp = path.with_name(path.name + f".{secrets.token_hex(4)}.tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _split_id(dataset_id) -> tuple[str, str] | None:
    if not isinstance(dataset_id, str):
        return None
    parts = dataset_id.split("/", 1)
    if len(parts) != 2:
        return None
    type_dir, folder = parts[0].strip(), parts[1].strip()
    if type_dir not in ALLOWED_TYPE_DIRS:
        return None
    if folder in (".", "..") or not _SAFE_FOLDER_RE.match(folder):
        return None
    return type_dir, folder


def _entry_dir(uploads: Path, trash_id) -> Path | None:
    if not isinstance(trash_id, str) or not _TRASH_ID_RE.match(trash_id):
        return None
    return trash_root(uploads) / trash_id


def _read_entry(entry_dir: Path) -> dict | None:
    try:
        doc = json.loads((entry_dir / ENTRY_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _public(entry: dict, now: datetime) -> dict:
    expires = _parse_iso(entry.get("expiresAt"))
    left = None
    if expires is not None:
        left = max(0, math.ceil((expires - now).total_seconds() / 86400))
    return {
        "trashId": entry.get("trashId"),
        "id": entry.get("id"),
        "type": entry.get("type"),
        "folder": entry.get("folder"),
        "name": entry.get("name"),
        "stage": entry.get("stage"),
        "embryo": entry.get("embryo"),
        "deletedAt": entry.get("deletedAt"),
        "expiresAt": entry.get("expiresAt"),
        "daysLeft": left,
        "bytes": entry.get("bytes"),
    }


def move_to_trash(data_web: Path, uploads: Path, dataset_id) -> tuple[int, dict]:
    split = _split_id(dataset_id)
    if split is None:
        return 400, {"error": "Invalid dataset ID"}
    type_dir, folder = split
    src = Path(data_web) / type_dir / folder
    if not src.is_dir() or src.is_symlink():
        return 404, {"error": "Dataset not found"}

    meta = {}
    try:
        loaded = json.loads((src / "metadata.json").read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            meta = loaded
    except (OSError, ValueError):
        pass

    now = _now()
    trash_id = f"{type_dir}__{folder}__{now.strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(3)}"
    edir = trash_root(uploads) / trash_id
    try:
        edir.mkdir(parents=True, exist_ok=False)
    except OSError as exc:
        return 500, {"error": "trash_unavailable", "detail": str(exc)}

    entry = {
        "trashId": trash_id,
        "id": f"{type_dir}/{folder}",
        "type": type_dir,
        "folder": folder,
        "name": meta.get("name") if isinstance(meta.get("name"), str) and meta.get("name") else folder,
        "stage": meta.get("stage") if isinstance(meta.get("stage"), str) else None,
        "embryo": meta.get("embryo") if isinstance(meta.get("embryo"), str) else None,
        "deletedAt": _iso(now),
        "expiresAt": _iso(now + timedelta(days=RETENTION_DAYS)),
        "bytes": None,
    }
    try:
        _write_json_atomic(edir / ENTRY_FILE, entry)
        dst = edir / DATA_DIRNAME
        try:
            os.rename(src, dst)
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
            shutil.move(str(src), str(dst))     # another volume: copy, then remove
    except OSError as exc:
        _rmtree(edir)
        # A folder another process holds open (a migration, an antivirus scan) cannot
        # be renamed on Windows: say so instead of leaving a half move.
        return 409, {"error": "busy", "detail": str(exc)}

    entry["bytes"] = _tree_bytes(edir / DATA_DIRNAME)
    try:
        _write_json_atomic(edir / ENTRY_FILE, entry)
    except OSError:
        pass
    return 200, {"ok": True, "trashId": trash_id, "expiresAt": entry["expiresAt"]}


def purge_expired(uploads: Path, now: datetime | None = None) -> list[str]:
    """Reclaim every entry past its expiry and every orphaned half entry."""
    now = now or _now()
    removed: list[str] = []
    root = trash_root(uploads)
    if not root.is_dir():
        return removed
    for edir in sorted(root.iterdir()):
        if not edir.is_dir() or not _TRASH_ID_RE.match(edir.name):
            continue
        entry = _read_entry(edir)
        has_data = (edir / DATA_DIRNAME).is_dir()
        if entry is None or not has_data:
            try:
                age = now.timestamp() - edir.stat().st_mtime
            except OSError:
                continue
            if age > _ORPHAN_GRACE_S:
                _rmtree(edir)
                removed.append(edir.name)
            continue
        expires = _parse_iso(entry.get("expiresAt"))
        if expires is not None and expires <= now:
            _rmtree(edir)
            removed.append(edir.name)
    return removed


def list_entries(uploads: Path, now: datetime | None = None) -> dict:
    now = now or _now()
    try:
        purge_expired(uploads, now)
    except OSError:
        pass
    rows = []
    root = trash_root(uploads)
    if root.is_dir():
        for edir in root.iterdir():
            if not edir.is_dir() or not (edir / DATA_DIRNAME).is_dir():
                continue
            entry = _read_entry(edir)
            if entry is None or entry.get("trashId") != edir.name:
                continue
            rows.append(_public(entry, now))
    rows.sort(key=lambda r: r.get("deletedAt") or "", reverse=True)
    return {"entries": rows, "retentionDays": RETENTION_DAYS}


def _free_folder(data_web: Path, type_dir: str, folder: str) -> str:
    base = Path(data_web) / type_dir
    candidate = f"{folder}-restored"
    n = 2
    while (base / candidate).exists():
        candidate = f"{folder}-restored-{n}"
        n += 1
    return candidate


def restore(data_web: Path, uploads: Path, trash_id, folder=None) -> tuple[int, dict]:
    edir = _entry_dir(uploads, trash_id)
    entry = _read_entry(edir) if edir is not None and edir.is_dir() else None
    if entry is None or not (edir / DATA_DIRNAME).is_dir():
        return 404, {"error": "Not in trash"}
    type_dir = entry.get("type")
    original = entry.get("folder")
    if type_dir not in ALLOWED_TYPE_DIRS or not isinstance(original, str):
        return 500, {"error": "corrupt_entry"}
    target_folder = original
    if folder is not None and folder != "":
        if not isinstance(folder, str) or folder in (".", "..") or not _SAFE_FOLDER_RE.match(folder):
            return 400, {"error": "Invalid folder name"}
        target_folder = folder
    base = Path(data_web) / type_dir
    target = base / target_folder
    if target.exists():
        return 409, {"error": "exists", "folder": target_folder,
                     "suggested": _free_folder(data_web, type_dir, target_folder)}
    try:
        base.mkdir(parents=True, exist_ok=True)
        os.rename(edir / DATA_DIRNAME, target)
    except FileExistsError:
        return 409, {"error": "exists", "folder": target_folder,
                     "suggested": _free_folder(data_web, type_dir, target_folder)}
    except OSError as exc:
        if exc.errno == errno.EXDEV:
            shutil.move(str(edir / DATA_DIRNAME), str(target))
        else:
            return 409, {"error": "busy", "detail": str(exc)}

    new_id = f"{type_dir}/{target_folder}"
    # metadata.json names its own id; a renamed restore must agree with the folder.
    meta_path = target / "metadata.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if isinstance(meta, dict) and (meta.get("id") != new_id or meta.get("type") != type_dir):
            meta["id"] = new_id
            meta["type"] = type_dir
            _write_json_atomic(meta_path, meta)
    except (OSError, ValueError):
        pass
    _rmtree(edir)
    return 200, {"ok": True, "id": new_id}


def purge(uploads: Path, trash_id) -> tuple[int, dict]:
    edir = _entry_dir(uploads, trash_id)
    if edir is None or not edir.is_dir():
        return 404, {"error": "Not in trash"}
    _rmtree(edir)
    if edir.exists():
        return 500, {"error": "purge_incomplete"}
    return 200, {"ok": True}


def empty(uploads: Path) -> tuple[int, dict]:
    root = trash_root(uploads)
    count = 0
    if root.is_dir():
        for edir in list(root.iterdir()):
            if edir.is_dir() and _TRASH_ID_RE.match(edir.name):
                _rmtree(edir)
                if not edir.exists():
                    count += 1
    return 200, {"ok": True, "removed": count}
