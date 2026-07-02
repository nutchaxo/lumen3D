#!/usr/bin/env python3
"""Validate the Lumen3D web platform version against changelog/ filenames.

The web platform has no __version__ constant: the newest
``changelog/changelog_X.Y.Z.md`` filename at the *flat* level of
``changelog/`` is the single source of truth. ``changelog/archive/`` holds
retired entries and is ignored by version computation.

Usage:
    python tools/check_version.py --tag v1.5.0   # release guard (tag == max)
    python tools/check_version.py --no-tag       # structural validation only
"""

import argparse
import re
import sys
from pathlib import Path

CHANGELOG_RE = re.compile(r"^changelog_(\d+)\.(\d+)\.(\d+)\.md$")

REPO_ROOT = Path(__file__).resolve().parents[1]
CHANGELOG_DIR = REPO_ROOT / "changelog"


def parse_tag(tag):
    """Parse 'vX.Y.Z' or 'X.Y.Z' into an (X, Y, Z) int tuple, or None."""
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", tag)
    if not m:
        return None
    return tuple(int(g) for g in m.groups())


def format_version(version):
    """Render an (X, Y, Z) tuple as 'X.Y.Z'."""
    return ".".join(str(n) for n in version)


def collect_flat_versions(changelog_dir):
    """Scan the flat level of changelog/ (subdirectories ignored).

    Returns (versions, errors) where versions maps each (X, Y, Z) tuple to
    the list of filenames claiming it — more than one filename means a
    semantic duplicate (e.g. leading zeros) — and errors lists changelog_*
    filenames that do not match the full pattern. Other files (e.g.
    README.md) are not changelog entries and are ignored.
    """
    versions = {}
    errors = []
    for entry in sorted(changelog_dir.iterdir()):
        if entry.is_dir() or not entry.name.startswith("changelog_"):
            continue
        m = CHANGELOG_RE.match(entry.name)
        if not m:
            errors.append(f"unparseable changelog filename: {entry.name}")
            continue
        version = tuple(int(g) for g in m.groups())
        versions.setdefault(version, []).append(entry.name)
    return versions, errors


def validate(tag_version):
    """Run all checks; return a list of error messages (empty = pass).

    tag_version is an (X, Y, Z) tuple for a release guard, or None for
    structural validation only.
    """
    if not CHANGELOG_DIR.is_dir():
        return [f"changelog directory not found: {CHANGELOG_DIR}"]

    versions, errors = collect_flat_versions(CHANGELOG_DIR)
    if not versions:
        errors.append("no changelog_X.Y.Z.md files at the flat level of changelog/")
        return errors

    for version, names in sorted(versions.items()):
        if len(names) > 1:
            errors.append(
                f"semantically duplicate version {format_version(version)}: "
                + ", ".join(names)
            )

    max_version = max(versions)
    check_version = tag_version if tag_version is not None else max_version

    if tag_version is not None:
        if tag_version not in versions:
            errors.append(
                f"no changelog file for tag version {format_version(tag_version)} "
                f"(expected changelog/changelog_{format_version(tag_version)}.md)"
            )
        if tag_version != max_version:
            errors.append(
                f"tag version {format_version(tag_version)} != newest changelog "
                f"version {format_version(max_version)} "
                f"({versions[max_version][0]})"
            )

    if check_version in versions:
        path = CHANGELOG_DIR / versions[check_version][0]
        if not path.read_text(encoding="utf-8").strip():
            errors.append(f"changelog file is empty: {path.name}")

    return errors


def main():
    parser = argparse.ArgumentParser(
        description="Check the web platform version derived from changelog/ filenames."
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--tag", help="release tag to validate (vX.Y.Z or X.Y.Z)")
    mode.add_argument(
        "--no-tag", action="store_true", help="structural validation only"
    )
    args = parser.parse_args()

    tag_version = None
    if args.tag is not None:
        tag_version = parse_tag(args.tag)
        if tag_version is None:
            print(f"ERROR: malformed tag {args.tag!r} (expected vX.Y.Z)")
            return 1

    errors = validate(tag_version)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    versions, _ = collect_flat_versions(CHANGELOG_DIR)
    print(
        f"OK: {len(versions)} changelog entries, "
        f"newest version {format_version(max(versions))}"
        + (f", tag {args.tag} matches" if tag_version is not None else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
