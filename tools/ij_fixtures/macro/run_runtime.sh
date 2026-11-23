#!/usr/bin/env bash
# Regenerates tests/fixtures/ij-macro/runtime-golden.json: the image-model corpus of the macro runtime
# (tests/fixtures/ij-macro/runtime/<group>/<case>.ijm: pixels, statistics, histograms, fills and draws, stacks, ranges, Results,
# selections, thresholds, calibration, getValue) run through ImageJ 1.54p headless by the language oracle (MacroGolden.java, one class
# loader per case). tests/js/test_ij_macro_pixels.mjs runs the same files through the Studio and compares. Local only, never CI.
# Usage: tools/ij_fixtures/macro/run_runtime.sh <path-to-ij-1.54p.jar>
set -euo pipefail
JAR="${1:?path to ij-1.54p.jar}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../../tests/fixtures/ij-macro"
if command -v cygpath >/dev/null 2>&1; then JAR="$(cygpath -m "$JAR")"; ROOT="$(cygpath -m "$ROOT")"; fi
exec "$HERE/run_macro.sh" "$JAR" "$ROOT/runtime-golden.json" "$ROOT/runtime"
