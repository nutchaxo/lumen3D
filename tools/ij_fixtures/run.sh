#!/usr/bin/env bash
# Regenerates tests/fixtures/ij-wave2 with ImageJ 1.54p (headless). Local only, never CI.
# Usage: tools/ij_fixtures/run.sh <path-to-ij-1.54p.jar> [pkg ...]
set -euo pipefail
JAR="${1:?path to ij-1.54p.jar}"; shift || true
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../tests/fixtures/ij-wave2"
TMP="$(mktemp -d)"; if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; fi
trap 'rm -rf "$TMP"' EXIT
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
javac -nowarn -encoding UTF-8 -cp "$JAR" -d "$TMP" "$HERE"/*.java
mkdir -p "$OUT"
java -Djava.awt.headless=true -cp "$TMP$SEP$JAR" Main "$OUT" "$@"
