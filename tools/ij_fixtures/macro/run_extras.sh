#!/usr/bin/env bash
# Regenerates the goldens of the Recorder, #@ script parameters, Process > Batch > Macro and Process > Math > Macro
# (tests/fixtures/ij-macro/{recorder,params,math,batch}-golden.json + their data folders). Contract:
# DOCS/studio-advanced/macros/EXTRAS.md section 14. Local only, never CI, never shipped.
#
#   tools/ij_fixtures/macro/run_extras.sh <recorder|params|math|batch|all> [path/to/ij-1.54p.jar]
#
# The jar defaults to $FIJI/jars/ij-1.54p.jar; FIJI defaults to D:/APT/3A/BIOIMAGING/Fiji (params runs on Fiji's jars and JDK).
# recorder, math and batch need a desktop session (java.awt windows; RecorderGolden shows image windows and moves the mouse
# focus while it runs: leave the machine alone for a minute). IJM_ONLY=<substring of a case id> runs only the matching cases.
set -euo pipefail
WHAT="${1:?recorder | params | math | batch | all}"
FIJI="${FIJI:-D:/APT/3A/BIOIMAGING/Fiji}"
JAR="${2:-$FIJI/jars/ij-1.54p.jar}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../../tests/fixtures/ij-macro"
TMP="$(mktemp -d)"
if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; JAR="$(cygpath -m "$JAR")"; ROOT="$(cygpath -m "$ROOT")"; HERE="$(cygpath -m "$HERE")"; fi
trap 'rm -rf "$TMP"' EXIT
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
mkdir -p "$ROOT" "$TMP/home" "$TMP/ijdir/macros" "$TMP/ijdir/plugins"
# Clean user.home (IJ_Prefs would leak the operator's settings), an empty ImageJ folder (macros/BatchMacro.ijm lands there),
# the root locale (String.format and d2s follow it) and UTC (file dates).
JOPTS=(-Duser.home="$TMP/home" -Dfile.encoding=UTF-8 -Duser.language=en -Duser.country=US -Duser.timezone=UTC -Dijm.only="${IJM_ONLY:-}")
compile_ij() { javac -nowarn -encoding UTF-8 -cp "$JAR" -d "$TMP/ij" "$HERE/MathGolden.java" "$HERE/BatchGolden.java" "$HERE/RecorderGolden.java"; }
run_one() {
  case "$1" in
    math)     java "${JOPTS[@]}" -cp "$TMP/ij$SEP$JAR" MathGolden "$ROOT" ;;
    batch)    java "${JOPTS[@]}" -Dij.dir="$TMP/ijdir" -Dplugins.dir="$TMP/ijdir" -cp "$TMP/ij$SEP$JAR" BatchGolden "$ROOT" ;;
    recorder) java "${JOPTS[@]}" -Dij.dir="$TMP/ijdir" -Dplugins.dir="$TMP/ijdir" -cp "$TMP/ij$SEP$JAR" RecorderGolden "$ROOT" ;;
    params)
      JH="$(ls -d "$FIJI"/java/win64/*/ | head -1)"; JAVA="$JH/bin/java"; JAVAC="$JH/bin/javac"; [ -x "$JAVAC" ] || JAVAC=javac
      CP="$FIJI/jars/*$SEP$FIJI/plugins/*"
      mkdir -p "$TMP/fiji"
      "$JAVAC" -nowarn -encoding UTF-8 -cp "$CP" -d "$TMP/fiji" "$HERE/ParamGolden.java" "$HERE/MathGolden.java"
      # headless Fiji: the IJ1 macro engine of imagej-legacy, no UI; the case files are written to a scratch folder
      # --add-opens: imagej-legacy patches the ij classes at start-up (Java 17+ refuses it otherwise)
      "$JAVA" --add-opens=java.base/java.lang=ALL-UNNAMED "${JOPTS[@]}" -Djava.awt.headless=true -Dplugins.dir="$FIJI" -Dij.dir="$FIJI" -Dscijava.log.level=warn \
        -cp "$TMP/fiji$SEP$CP" ParamGolden "$ROOT" "$TMP/scripts" ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
}
mkdir -p "$TMP/ij"
case "$WHAT" in
  all) compile_ij; for w in math batch recorder params; do run_one "$w"; done ;;
  params) run_one params ;;
  math|batch|recorder) compile_ij; run_one "$WHAT" ;;
  *) echo "unknown: $WHAT" >&2; exit 2 ;;
esac
