#!/usr/bin/env bash
# Regenerates tests/fixtures/ij-wave3 with ImageJ 1.54p (GUI-less ImageJ instance; needs a desktop session for java.awt dialogs in macro mode). Local only, never CI.
# Usage: tools/ij_fixtures/run3.sh <path-to-ij-1.54p.jar> [pkg ...]     pkg: thr enh fft sel io ov ana edit fiji lib
set -euo pipefail
JAR="${1:?path to ij-1.54p.jar}"; shift || true
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../tests/fixtures/ij-wave3"
TMP="$(mktemp -d)"; if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; fi
trap 'rm -rf "$TMP"' EXIT
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
javac -nowarn -encoding UTF-8 -cp "$JAR" -d "$TMP" "$HERE"/*.java
mkdir -p "$OUT"
# clean preferences: ImageJ reads IJ_Prefs from the user home, which would leak the operator's settings into the fixtures
mkdir -p "$TMP/home"
java -Duser.home="$TMP/home" -cp "$TMP$SEP$JAR" Main3 "$OUT" "$@"
