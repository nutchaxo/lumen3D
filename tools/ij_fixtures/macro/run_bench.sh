#!/usr/bin/env bash
# Times tests/js/bench_ijm/*.ijm with ImageJ 1.54p (headless). Local only, never CI.
# Usage: tools/ij_fixtures/macro/run_bench.sh <path-to-ij-1.54p.jar> [out.json] [runs]
set -euo pipefail
JAR="${1:?path to ij-1.54p.jar}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HERE/../../../tests/js/bench_ijm"
OUT="${2:-$DIR/imagej-timings.json}"
TMP="$(mktemp -d)"; if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; fi
trap 'rm -rf "$TMP"' EXIT
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
javac -nowarn -encoding UTF-8 -cp "$JAR" -d "$TMP" "$HERE/BenchIjm.java"
java -Djava.awt.headless=true -cp "$TMP$SEP$JAR" BenchIjm "$DIR" "$OUT" "${3:-5}"
