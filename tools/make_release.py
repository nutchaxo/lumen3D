#!/usr/bin/env python3
"""
IRIBHM Microscopy Platform - release helper
===========================================
Starts a release; it does NOT create the GitHub release itself.

The Web platform version is the newest ``changelog/changelog_X.Y.Z.md`` (the
project convention - there is no version constant). This tool:
  1. checks the changelog structure (tools/check_version.py),
  2. refuses to run from a dirty tree or from a branch other than ``main``
     (override: --allow-branch / --allow-dirty),
  3. tags ``vX.Y.Z`` at HEAD (if the tag doesn't already exist) and pushes it.

Pushing the tag triggers ``.github/workflows/release.yml``, which runs the whole
test suite, builds the signed zip + SHA256SUMS(.sig) + release notes + processing
packs, and only then publishes the release with all its assets. Creating the
release here too would publish an asset-less release first (the updater would then
fall back to an unverifiable source zipball), so the release is left to CI.

Usage:
    python tools/make_release.py                 # release the latest changelog version
    python tools/make_release.py --version 1.4.0 # release a specific version
    python tools/make_release.py --dry-run       # print what would happen, do nothing
    python tools/make_release.py --yes           # skip the confirmation prompt
    python tools/make_release.py --watch         # follow the CI run afterwards (needs gh)
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


def git_out(*args: str) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True)
    return r.stdout.strip() if r.returncode == 0 else ""




def main() -> int:
    ap = argparse.ArgumentParser(description="Tag and push a release; CI builds and publishes it.")
    ap.add_argument("--version", help="Version to release (default: newest changelog).")
    ap.add_argument("--dry-run", action="store_true", help="Print actions without running them.")
    ap.add_argument("--yes", action="store_true", help="Skip the confirmation prompt.")
    ap.add_argument("--allow-branch", action="store_true", help="Allow tagging a branch other than main.")
    ap.add_argument("--allow-dirty", action="store_true", help="Allow tagging with uncommitted changes.")
    ap.add_argument("--watch", action="store_true", help="Follow the release workflow with `gh run watch`.")
    args = ap.parse_args()

    version = args.version or latest_version()
    if not version:
        print("No changelog/changelog_X.Y.Z.md found - nothing to release.", file=sys.stderr)
        return 1
    tag = f"v{version}"
    changelog = CHANGELOG_DIR / f"changelog_{version}.md"
    if not changelog.exists() or not changelog.read_text(encoding="utf-8").strip():
        print(f"Changelog {changelog.name} is missing or empty.", file=sys.stderr)
        return 1

    print(f"Platform version : {version}")
    print(f"Tag              : {tag}")
    print(f"Release notes    : {changelog.relative_to(ROOT)}")

    guard = subprocess.run([sys.executable, str(ROOT / "tools" / "check_version.py"), "--no-tag"], cwd=ROOT)
    if guard.returncode != 0:
        print("Changelog structure check failed.", file=sys.stderr)
        return 1

    branch = git_out("rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main" and not args.allow_branch:
        print(f"\nHEAD is on '{branch}', not 'main'. A release is cut from main "
              f"(merge dev -> main first), or pass --allow-branch.", file=sys.stderr)
        return 1
    if git_out("status", "--porcelain") and not args.allow_dirty:
        print("\nThe working tree has uncommitted changes; commit or stash them "
              "(or pass --allow-dirty).", file=sys.stderr)
        return 1

    if not args.yes and not args.dry_run:
        ans = input(f"\nTag HEAD as {tag} and push it (CI then builds and publishes the release)? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            print("Aborted.")
            return 0

    print("\n- Tagging -")
    if tag_exists(tag):
        print(f"  tag {tag} already exists locally - skipping tag creation")
    else:
        r = run(["git", "tag", "-a", tag, "-m", f"Plateforme Web {version}"], dry=args.dry_run)
        if r is not None and r.returncode != 0:
            print("git tag failed.", file=sys.stderr)
            return 1
    r = run(["git", "push", "origin", tag], dry=args.dry_run)
    if r is not None and r.returncode != 0:
        print("git push failed.", file=sys.stderr)
        return 1

    print("\nTag pushed. .github/workflows/release.yml now tests, builds, signs and publishes "
          f"{tag}; follow it in the repository's Actions tab.")
    if args.watch and not args.dry_run:
        if subprocess.run(["gh", "--version"], capture_output=True).returncode != 0:
            print("GitHub CLI (gh) not found - skipping --watch.", file=sys.stderr)
        else:
            subprocess.run(["gh", "run", "watch", "--exit-status"], cwd=ROOT)
    print("Dry run complete." if args.dry_run else "Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
