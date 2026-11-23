#!/usr/bin/env bash
# Regenerates tests/fixtures/ij-macro/golden.json with ImageJ 1.54p (headless). Local only, never CI.
# Usage: tools/ij_fixtures/macro/run_macro.sh <path-to-ij-1.54p.jar> [out.json [corpusDir]]
set -euo pipefail
JAR="${1:?path to ij-1.54p.jar}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../../tests/fixtures/ij-macro"
OUT="${2:-$ROOT/golden.json}"
CORPUS="${3:-$ROOT/corpus}"
TMP="$(mktemp -d)"; if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; fi
trap 'rm -rf "$TMP"' EXIT
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
javac -nowarn -encoding UTF-8 -cp "$JAR" -d "$TMP" "$HERE/MacroProbe.java" "$HERE/MacroGolden.java"
mkdir -p "$TMP/stub"; javac -nowarn -encoding UTF-8 -d "$TMP/stub" "$HERE/stub/ij/gui/GenericDialog.java"
java -Djava.awt.headless=true -Dfile.encoding=UTF-8 -Dmacro.stubdir="$TMP/stub" -cp "$TMP$SEP$JAR" MacroGolden "$CORPUS" "$OUT"
