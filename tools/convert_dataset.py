#!/usr/bin/env python3
"""Convert a published dataset to the latest format on this machine (SPEC §14.10).

    python tools/convert_dataset.py DATA_WEB/3d/E85-Em1 [--workers 8] [--keep-previous]
    python tools/convert_dataset.py DATA_WEB/live/LS-01 --to 4

Runs every pending migration of the dataset (m002 planes, m003 layer MIPs, m004 bricks v3,
m005 resolution × compression matrix) with the Python server executor — the same code,
journal and tile store as the admin Data updates tab of a Python host, so an interrupted run
resumes where it stopped. The dataset must sit in a deployment layout,
`<DATA_WEB>/<type>/<folder>/` with type 3d or live; the job's journal and tile store go to
`<DATA_WEB>/../uploads/migrations/` unless --uploads names another folder (it needs about as
much free space as the result).

The converted folder is then dragged into the admin Import tab of a host that cannot convert
it itself (a PHP host such as a shared web space): the import accepts a format-5 tree and
validates it whole before publishing.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import dataset_migrations as dm  # noqa: E402


def _fmt_s(s: float) -> str:
    s = int(s)
    return f"{s // 3600}h{s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60}m{s % 60:02d}s"


def run_migration(ds_id: str, mid: str, workers: int, keep_previous: bool, out=None) -> dict:
    """Plan, run every unit with the server executor, finalize. Returns the finalize answer."""
    out = out or sys.stdout
    t0 = time.monotonic()
    plan = dm.plan_job(ds_id, mid)
    total = max(1, plan.get("total") or 0)
    last = -1.0
    while True:
        r = dm.unit_run(ds_id, mid, max_seconds=20, workers=workers)
        done, total = r.get("done", 0), max(1, r.get("total") or total)
        now = time.monotonic()
        if now - last >= 5 or done >= total:
            rate = done / max(1e-6, now - t0)
            eta = (total - done) / rate if rate > 0 else 0
            print(f"  {mid}: {done}/{total} units ({100 * done / total:.0f} %)"
                  + (f", {_fmt_s(eta)} left" if done < total else ""), file=out, flush=True)
            last = now
        if done >= total:
            break
    while True:
        fin = dm.finalize(ds_id, mid, max_seconds=60, keep_previous=keep_previous)
        if fin.get("complete"):
            break
        a = fin.get("assembly") or {}
        print(f"  {mid}: assembling {a.get('written', 0)}/{a.get('steps', a.get('packs', '?'))}", file=out, flush=True)
    print(f"  {mid}: done in {_fmt_s(time.monotonic() - t0)}, format {fin.get('formatVersion')}", file=out, flush=True)
    return fin


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dataset", help="the dataset folder, <DATA_WEB>/<3d|live>/<folder>")
    ap.add_argument("--to", type=int, default=None, help="stop at this format version (default: the latest)")
    ap.add_argument("--workers", type=int, default=max(1, min(16, (os.cpu_count() or 2) - 1)),
                    help="units converted at once (m005)")
    ap.add_argument("--uploads", default=None, help="folder of the job journals and tile stores")
    ap.add_argument("--keep-previous", action="store_true",
                    help="keep the replaced brick tree as bricks.previous/ (m004, m005)")
    ap.add_argument("--list", action="store_true", help="show the pending migrations and stop")
    args = ap.parse_args(argv)

    ds_dir = Path(args.dataset).resolve()
    type_dir, folder = ds_dir.parent.name, ds_dir.name
    data_web = ds_dir.parent.parent
    if not (ds_dir / "metadata.json").is_file():
        print(f"error: {ds_dir} has no metadata.json", file=sys.stderr)
        return 2
    if type_dir not in ("3d", "live"):
        print(f"error: the dataset must sit in <DATA_WEB>/3d/ or <DATA_WEB>/live/ (found {type_dir!r})", file=sys.stderr)
        return 2
    uploads = Path(args.uploads).resolve() if args.uploads else data_web.parent / "uploads"
    dm.configure(data_web.parent, data_web=data_web, uploads_dir=uploads)
    target = args.to or dm.LATEST
    ds_id = f"{type_dir}/{folder}"
    row = dm.dataset_status(type_dir, folder, ds_dir)
    if row.get("problem"):
        print(f"error: {row['problem']}: {row.get('problemDetail') or ''}", file=sys.stderr)
        return 1
    by_id = {m["id"]: m for m in dm.registry()}
    pending = [mid for mid in row["pending"] if by_id[mid]["to"] <= target]
    print(f"{ds_id}: format {row['formatVersion']}, latest {dm.LATEST}; "
          f"pending: {', '.join(pending) if pending else 'nothing'}", flush=True)
    if args.list or not pending:
        return 0
    if not dm.server_capabilities().get("migrations", {}).get(pending[-1], {}).get("available", False):
        caps = dm.server_capabilities()["migrations"].get(pending[-1], {})
        print(f"error: this Python cannot run {pending[-1]}: {', '.join(caps.get('reasons') or [])}", file=sys.stderr)
        return 1
    t0 = time.monotonic()
    for mid in pending:
        try:
            run_migration(ds_id, mid, args.workers, args.keep_previous)
        except dm.MigrationError as exc:
            print(f"error: {mid}: {exc.code}{': ' + exc.detail if exc.detail else ''}", file=sys.stderr)
            return 1
    meta = json.loads((ds_dir / "metadata.json").read_text(encoding="utf-8"))
    print(f"{ds_id}: format {meta.get('formatVersion')} in {_fmt_s(time.monotonic() - t0)}. "
          "Drag the folder into Admin > Import to publish it on another host.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
