#!/usr/bin/env python3
"""
IRIBHM Microscopy Platform — GitHub release helper
==================================================
Bootstraps the release pipeline the admin "Mises à jour" tab checks against.

The Web platform version is the newest ``changelog/changelog_X.Y.Z.md`` (the
project convention — there is no version constant). This tool:
  1. reads that version,
  2. tags ``vX.Y.Z`` at HEAD (if the tag doesn't already exist) and pushes it,
  3. creates a GitHub release ``vX.Y.Z`` whose body is that changelog file,

so ``GET /api/admin.php?action=update_check`` (which queries
``releases/latest``) returns a real release and the admin one-click update has a
zipball to download.

Usage:
    python tools/make_release.py                 # release the latest changelog version
    python tools/make_release.py --version 1.4.0 # release a specific version
    python tools/make_release.py --dry-run       # print what would happen, do nothing
    python tools/make_release.py --yes           # skip the confirmation prompt

Requires the GitHub CLI (`gh`) authenticated against the repo.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG_DIR = ROOT / "changelog"
_VERSION_RE = re.compile(r"^changelog_(\d+)\.(\d+)\.(\d+)\.md$")


def latest_version() -> str | None:
    versions = []
    for f in CHANGELOG_DIR.glob("changelog_*.md"):
        m = _VERSION_RE.match(f.name)
        if m:
            versions.append(tuple(int(x) for x in m.groups()))
    return ".".join(map(str, sorted(versions)[-1])) if versions else None


def run(cmd: list[str], *, dry: bool, capture: bool = False) -> subprocess.CompletedProcess | None:
    printable = " ".join(cmd)
    if dry:
        print(f"  [dry-run] {printable}")
        return None
    print(f"  $ {printable}")
    return subprocess.run(cmd, check=False, text=True,
                          capture_output=capture)


def tag_exists(tag: str) -> bool:
    r = subprocess.run(["git", "tag", "--list", tag], cwd=ROOT, text=True, capture_output=True)
    return tag in r.stdout.split()


def release_exists(tag: str) -> bool:
    r = subprocess.run(["gh", "release", "view", tag], cwd=ROOT, text=True, capture_output=True)
    return r.returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Tag + publish a GitHub release for the platform.")
    ap.add_argument("--version", help="Version to release (default: newest changelog).")
    ap.add_argument("--dry-run", action="store_true", help="Print actions without running them.")
    ap.add_argument("--yes", action="store_true", help="Skip the confirmation prompt.")
    args = ap.parse_args()

    version = args.version or latest_version()
    if not version:
        print("No changelog/changelog_X.Y.Z.md found — nothing to release.", file=sys.stderr)
        return 1
    tag = f"v{version}"
    changelog = CHANGELOG_DIR / f"changelog_{version}.md"
    if not changelog.exists():
        print(f"Changelog {changelog.name} not found.", file=sys.stderr)
        return 1

    print(f"Platform version : {version}")
    print(f"Tag              : {tag}")
    print(f"Release notes    : {changelog.relative_to(ROOT)}")

    if subprocess.run(["gh", "--version"], capture_output=True).returncode != 0:
        print("\nGitHub CLI (gh) not found / not on PATH. Install it and `gh auth login` first.", file=sys.stderr)
        return 1

    if release_exists(tag) and not args.dry_run:
        print(f"\nRelease {tag} already exists on GitHub — nothing to do.")
        return 0

    if not args.yes and not args.dry_run:
        ans = input(f"\nTag HEAD as {tag}, push it, and publish a GitHub release? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            print("Aborted.")
            return 0

    print("\n— Tagging —")
    if not tag_exists(tag):
        run(["git", "tag", "-a", tag, "-m", f"Plateforme Web {version}"], dry=args.dry_run)
        run(["git", "push", "origin", tag], dry=args.dry_run)
    else:
        print(f"  tag {tag} already exists locally — skipping tag creation")

    print("\n— Publishing GitHub release —")
    run(["gh", "release", "create", tag,
         "--title", f"Plateforme Web {version}",
         "--notes-file", str(changelog)], dry=args.dry_run)

    print("\nDone." if not args.dry_run else "\nDry run complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
