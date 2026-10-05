#!/usr/bin/env python3
"""Run EVERY test of the repository and exit non-zero if any fails.

Discovers tests/test_*.py, tests/test_*.js, tests/test_*.php and
tests/js/test_*.mjs, runs each in its own subprocess (timeout per file) and
prints a summary.

A test that cannot run in this environment (missing PHP extension, no network,
missing interpreter) must say so explicitly: print a line starting with "SKIP"
(or let unittest report skipped tests). The runner lists every skip by name and,
with --strict-skips (what CI uses), turns any skip into a failure, so a test
that silently stops running cannot pass for green.

    python tests/run_all.py                    # everything
    python tests/run_all.py -k upload          # only files whose path contains 'upload'
    python tests/run_all.py -j 4               # run four files at a time
    python tests/run_all.py --strict-skips --check-clean   # CI mode

--check-clean additionally fails when a test left new or modified files in the
working tree (tests must write to temp directories only).
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"

_UNITTEST_SKIP = re.compile(r"\(skipped=\d+")
_SKIP_LINE = re.compile(r"^\s*(?:\[?SKIP(?:PED)?\]?)\b", re.IGNORECASE | re.MULTILINE)


def find_php() -> str | None:
    for cand in ("php", r"C:\php-portable\php.exe"):
        found = shutil.which(cand) or (cand if os.path.isfile(cand) else None)
        if found:
            return found
    return None


def discover(pattern: str | None) -> list[tuple[str, Path]]:
    found: list[tuple[str, Path]] = []
    for path in sorted(TESTS.glob("test_*.py")):
        found.append(("python", path))
    for path in sorted(TESTS.glob("test_*.js")):
        found.append(("node", path))
    for path in sorted(TESTS.glob("test_*.php")):
        found.append(("php", path))
    for path in sorted((TESTS / "js").glob("test_*.mjs")):
        found.append(("node", path))
    if pattern:
        found = [(k, p) for k, p in found if pattern in p.relative_to(ROOT).as_posix()]
    return found


def command(kind: str, path: Path, php: str | None) -> list[str] | None:
    if kind == "python":
        return [sys.executable, str(path)]
    if kind == "node":
        node = shutil.which("node")
        return [node, str(path)] if node else None
    if kind == "php":
        return [php, str(path)] if php else None
    return None


def run_one(kind: str, path: Path, php: str | None, timeout: int, env: dict) -> dict:
    rel = path.relative_to(ROOT).as_posix()
    cmd = command(kind, path, php)
    if cmd is None:
        return {"name": rel, "status": "skip", "reason": f"no {kind} interpreter on PATH", "time": 0.0, "out": ""}
    started = time.time()
    try:
        proc = subprocess.run(cmd, cwd=str(ROOT), env=env, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        out = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        return {"name": rel, "status": "fail", "reason": f"timeout after {timeout}s", "time": time.time() - started, "out": out}
    out = (proc.stdout or "") + (proc.stderr or "")
    elapsed = time.time() - started
    if proc.returncode != 0:
        return {"name": rel, "status": "fail", "reason": f"exit {proc.returncode}", "time": elapsed, "out": out}
    if _SKIP_LINE.search(out) or _UNITTEST_SKIP.search(out):
        skip_line = next((ln.strip() for ln in out.splitlines() if _SKIP_LINE.match(ln) or _UNITTEST_SKIP.search(ln)), "skipped")
        return {"name": rel, "status": "skip", "reason": skip_line[:160], "time": elapsed, "out": out}
    return {"name": rel, "status": "pass", "reason": "", "time": elapsed, "out": out}


def git_state() -> set[str] | None:
    try:
        r = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=str(ROOT),
                           capture_output=True, text=True, timeout=60)
    except Exception:
        return None
    return set(r.stdout.splitlines()) if r.returncode == 0 else None


def main() -> int:
    ap = argparse.ArgumentParser(description="Run every test of the repository.")
    ap.add_argument("-k", dest="pattern", help="only run files whose repo-relative path contains this text")
    ap.add_argument("-j", dest="jobs", type=int, default=1, help="files to run concurrently (default 1)")
    ap.add_argument("--timeout", type=int, default=300, help="seconds allowed per file (default 300)")
    ap.add_argument("--strict-skips", action="store_true", help="a skipped test counts as a failure")
    ap.add_argument("--check-clean", action="store_true", help="fail if the tests changed the working tree")
    ap.add_argument("--verbose", action="store_true", help="print the output of passing tests too")
    args = ap.parse_args()

    tests = discover(args.pattern)
    if not tests:
        print("No tests discovered.", file=sys.stderr)
        return 1
    php = find_php()

    scratch = tempfile.mkdtemp(prefix="lumen-tests-")
    env = dict(os.environ)
    env.update({"PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
                "TMPDIR": scratch, "TEMP": scratch, "TMP": scratch})

    before = git_state() if args.check_clean else None
    print(f"Running {len(tests)} test files ({sum(1 for k, _ in tests if k == 'python')} python, "
          f"{sum(1 for k, _ in tests if k == 'node')} node, {sum(1 for k, _ in tests if k == 'php')} php)"
          f"{'' if php else ' - php NOT found'}\n")

    results: list[dict] = []
    t0 = time.time()
    try:
        with cf.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            futures = [pool.submit(run_one, k, p, php, args.timeout, env) for k, p in tests]
            for fut in futures:
                r = fut.result()
                results.append(r)
                tag = {"pass": "PASS", "fail": "FAIL", "skip": "SKIP"}[r["status"]]
                extra = f"  ({r['reason']})" if r["reason"] else ""
                print(f"[{tag}] {r['name']}  {r['time']:.1f}s{extra}", flush=True)
                if r["status"] == "fail" or (args.verbose and r["status"] == "pass"):
                    tail = "\n".join(r["out"].splitlines()[-25:])
                    print("      " + tail.replace("\n", "\n      "), flush=True)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    failed = [r for r in results if r["status"] == "fail"]
    skipped = [r for r in results if r["status"] == "skip"]
    passed = [r for r in results if r["status"] == "pass"]
    dirty: list[str] = []
    if args.check_clean and before is not None:
        after = git_state() or set()
        dirty = sorted(after - before)

    print(f"\n{len(passed)} passed, {len(failed)} failed, {len(skipped)} skipped "
          f"in {time.time() - t0:.0f}s")
    if skipped:
        print("Skipped:")
        for r in skipped:
            print(f"  - {r['name']}: {r['reason']}")
    if failed:
        print("Failed:")
        for r in failed:
            print(f"  - {r['name']}: {r['reason']}")
    if dirty:
        print("Tests modified the working tree:")
        for line in dirty:
            print(f"  - {line}")

    bad = bool(failed) or bool(dirty) or (args.strict_skips and bool(skipped))
    if args.strict_skips and skipped:
        print("--strict-skips: skipped tests are failures.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
