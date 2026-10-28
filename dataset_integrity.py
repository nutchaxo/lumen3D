"""Dataset integrity check-up (admin tab "Data integrity").

Read-only. For one dataset it answers four questions and nothing else:
  * is anything MISSING   — metadata, thumbnail, manifest, index, every pack the manifest
                            names (existence + length), planes / mips of its format, gallery
                            and tracking files metadata refers to;
  * is anything EXTRA     — files of the pipeline trees no import would accept, leftovers of
                            an interrupted swap or conversion, gallery files metadata does
                            not list;
  * is it the LATEST format — `formatVersion` against `dataset_migrations.LATEST`, pending
                            migrations, a tree that fails its own validation;
  * is a STAGED (not yet published) dataset complete — `upload_staging.validate_dataset`.

Twin: api/_integrity_lib.php (same finding codes, same levels). Reuses the engines'
own validators so a verdict here can never disagree with what the viewer, the import or
the migrations would decide.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import dataset_migrations as dm
import upload_staging as us

LEVELS = ("error", "warn", "info")
MAX_LISTED = 20
# Directories the pipeline owns: only these are walked for unexpected files — download/,
# gallery/ and whatever the operator adds beside them are theirs.
PIPELINE_TREES = ("bricks", "planes", "mips")
_LEFTOVER_SUFFIXES = (".pre-swap", ".lumen-new")
_LEFTOVER_DIRS = ("bricks.previous",)
_ID_RE = re.compile(r"^([a-z0-9]+)/([^/\\]+)$")


def _finding(level: str, code: str, detail=None, files=None) -> dict:
    f = {"level": level, "code": code}
    if detail is not None:
        f["detail"] = str(detail)[:300]
    if files:
        f["files"] = list(files)[:MAX_LISTED]
    return f


def _dir_bytes(path: Path) -> int:
    total = 0
    for dirpath, _dirs, names in os.walk(path):
        for n in names:
            try:
                total += (Path(dirpath) / n).stat().st_size
            except OSError:
                pass
    return total


def _status_of(findings: list) -> str:
    levels = {f["level"] for f in findings}
    return "error" if "error" in levels else "warn" if "warn" in levels else "ok"


def _split_errors(codes: list[str]) -> list[dict]:
    """`code` or `code:detail` strings of the import validators → findings."""
    out = []
    for c in codes:
        code, _, detail = str(c).partition(":")
        out.append(_finding("error", code, detail or None))
    return out


def _gallery_findings(ds_dir: Path, meta: dict) -> list[dict]:
    out = []
    listed = {g.get("file") for g in (meta.get("gallery") or []) if isinstance(g, dict) and isinstance(g.get("file"), str)}
    folder = ds_dir / "gallery"
    present = {p.name for p in folder.iterdir() if p.is_file() and not p.name.startswith(".")} if folder.is_dir() else set()
    missing = sorted(f for f in listed if f not in present)
    extra = sorted(present - listed)
    if missing:
        out.append(_finding("error", "gallery_missing", files=missing))
    if extra:
        out.append(_finding("warn", "gallery_unlisted", files=extra))
    return out


def _tracking_findings(ds_dir: Path, meta: dict) -> list[dict]:
    tracking = meta.get("tracking")
    if not isinstance(tracking, dict):
        return []
    missing = []
    for key in ("tracksPath", "surfacePath"):
        v = tracking.get(key)
        if isinstance(v, str) and v and ".." not in v.split("/") and not v.startswith(("http:", "https:", "/")):
            cand = ds_dir / Path(*v.split("/"))
            # tracks.json is published as tracks.json or tracks.json.gz.
            if not cand.is_file() and not Path(str(cand) + ".gz").is_file():
                missing.append(v)
    return [_finding("error", "tracking_file_missing", files=missing)] if missing else []


def _leftovers(ds_dir: Path) -> list[dict]:
    out = []
    names = []
    for entry in ds_dir.iterdir():
        if entry.name.endswith(_LEFTOVER_SUFFIXES) or entry.name == ".swap-in-progress":
            names.append(entry.name)
    if names:
        out.append(_finding("warn", "interrupted_swap", files=sorted(names)))
    for d in _LEFTOVER_DIRS:
        p = ds_dir / d
        if p.is_dir():
            out.append(_finding("info", "previous_tree_kept", d, files=[d]))
            out[-1]["bytes"] = _dir_bytes(p)
    return out


def _unexpected_files(ds_dir: Path, type_dir: str) -> list[str]:
    stray = []
    for tree in PIPELINE_TREES:
        root = ds_dir / tree
        if not root.is_dir():
            continue
        for dirpath, dirnames, names in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for n in names:
                if n.startswith(us._TMP_PREFIX):
                    continue
                rel = (Path(dirpath) / n).relative_to(ds_dir).as_posix()
                if us.classify_path(type_dir, rel) is None:
                    stray.append(rel)
                    if len(stray) >= MAX_LISTED:
                        return stray
    return stray


def check_published(type_dir: str, folder: str) -> dict:
    ds_dir = (dm.DATA_WEB / type_dir / folder)
    row = {"id": f"{type_dir}/{folder}", "type": type_dir, "folder": folder, "name": folder,
           "staged": False, "latest": dm.LATEST}
    findings: list[dict] = []
    if not ds_dir.is_dir():
        row.update(status="error", findings=[_finding("error", "dataset_missing")])
        return row

    meta_path = ds_dir / "metadata.json"
    meta = us._read_json(meta_path) if meta_path.is_file() else None
    if not meta_path.is_file():
        findings.append(_finding("error", "missing_metadata"))
        meta = {}
    elif not isinstance(meta, dict):
        findings.append(_finding("error", "metadata_not_json"))
        meta = {}
    else:
        row["name"] = meta.get("name") if isinstance(meta.get("name"), str) and meta.get("name") else folder
        ok, reason = us._validate_metadata(meta, type_dir)
        if not ok:
            findings.append(_finding("error", reason or "metadata_invalid"))
        if meta.get("type") != type_dir or meta.get("id") != f"{type_dir}/{folder}":
            findings.append(_finding("error", "metadata_identity", f"type={meta.get('type')} id={meta.get('id')}"))

    if not (ds_dir / "thumbnail.webp").is_file():
        findings.append(_finding("warn", "missing_thumbnail"))

    if type_dir in us.VOLUME_TYPE_DIRS:
        st = dm.dataset_status(type_dir, folder, ds_dir)
        row["format"] = {"version": st.get("formatVersion"), "schema": st.get("bricksSchema")}
        if st.get("problem"):
            findings.append(_finding("error", st["problem"], st.get("problemDetail")))
        if st.get("pending"):
            findings.append(_finding("warn", "needs_repair" if st.get("repair") else "not_latest_format",
                                     ",".join(st["pending"])))
        findings.extend(_split_errors(us._check_bricks(ds_dir)))
        stray = _unexpected_files(ds_dir, type_dir)
        if stray:
            findings.append(_finding("warn", "unexpected_files", files=stray))
    else:
        findings.extend(_split_errors(us._check_2d_files(ds_dir)))

    findings.extend(_gallery_findings(ds_dir, meta))
    findings.extend(_tracking_findings(ds_dir, meta))
    findings.extend(_leftovers(ds_dir))
    row.update(status=_status_of(findings), findings=findings)
    return row


def check_staged(type_dir: str, folder: str) -> dict:
    info = us.describe(type_dir, folder)
    row = {"id": f"{type_dir}/{folder}", "type": type_dir, "folder": folder, "name": folder,
           "staged": True, "latest": dm.LATEST}
    if not info:
        row.update(status="error", findings=[_finding("error", "not_staged")])
        return row
    row["name"] = info.get("name") or folder
    row["state"] = info.get("state")
    v = us.validate_dataset(type_dir, folder)
    findings = _split_errors(v.get("errors") or [])
    detail = v.get("warnings") or []
    for f in findings:
        if f["code"] in ("incomplete_files", "stray_files"):
            f["files"] = detail[:MAX_LISTED]
    if info.get("state") == us.STATE_UPLOADING:
        findings = [_finding("info", "import_running")] + [f for f in findings if f["code"] != "incomplete_files"]
    if (dm.DATA_WEB / type_dir / folder).is_dir():
        findings.append(_finding("warn", "published_exists"))
    row.update(status=_status_of(findings), findings=findings)
    return row


def list_datasets() -> dict:
    published, staged = [], []
    for type_dir in dm.ALL_TYPES:
        base = dm.DATA_WEB / type_dir
        if not base.is_dir():
            continue
        for d in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if d.name.startswith(".") or not d.is_dir() or not dm._SAFE_FOLDER_RE.match(d.name):
                continue
            published.append({"id": f"{type_dir}/{d.name}", "type": type_dir, "folder": d.name, "staged": False})
    for info in us.list_staged():
        t, f = info.get("type"), info.get("folder")
        if isinstance(t, str) and isinstance(f, str):
            staged.append({"id": f"{t}/{f}", "type": t, "folder": f, "staged": True})
    return {"ok": True, "latest": dm.LATEST, "datasets": published + staged}


def handle(action: str, params: dict):
    if action == "list":
        return 200, list_datasets()
    if action == "check":
        ds = str(params.get("dataset") or "")
        staged = ds.startswith("staging:")
        m = _ID_RE.match(ds[len("staging:"):] if staged else ds)
        if not m or m.group(1) not in dm.ALL_TYPES or not dm._SAFE_FOLDER_RE.match(m.group(2)) or m.group(2) in (".", ".."):
            return 400, {"error": "invalid_dataset"}
        t, f = m.group(1), m.group(2)
        try:
            return 200, {"ok": True, "result": (check_staged if staged else check_published)(t, f)}
        except Exception as exc:  # one broken dataset must never blank the whole report
            return 200, {"ok": True, "result": {"id": f"{t}/{f}", "type": t, "folder": f, "name": f, "staged": staged,
                                                "latest": dm.LATEST, "status": "error",
                                                "findings": [_finding("error", "check_failed", f"{type(exc).__name__}: {exc}")]}}
    return 400, {"error": "Unknown action"}
