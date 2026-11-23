#!/usr/bin/env bash
# Local only (never shipped, never CI). Opens every ImageJ / Fiji command's dialog in the REAL application and records its keys.
# Needs a desktop session (java.awt dialogs and image windows appear while it runs; leave the machine alone).
#   ImageJ 1.54p :  tools/ij_fixtures/macro/run_dialogkeys.sh ij  <path/to/ij-1.54p.jar> [out.json] [--only "a;b"]
#   Fiji         :  tools/ij_fixtures/macro/run_dialogkeys.sh fiji [out.json]            env FIJI (default D:/APT/3A/BIOIMAGING/Fiji)
# Defaults: out = tests/fixtures/ij-macro/ij-dialogs.json | fiji-macro-keys.json. Extra arguments go to DialogKeys.
set -euo pipefail
MODE="${1:?ij | fiji}"; shift
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../../tests/fixtures/ij-macro"
TMP="$(mktemp -d)"; if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; fi
trap 'rm -rf "$TMP"' EXIT
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
mkdir -p "$ROOT" "$TMP/home"
case "$MODE" in
  ij)
    JAR="${1:?path to ij-1.54p.jar}"; shift
    OUT="$ROOT/ij-dialogs.json"; if [ $# -gt 0 ] && [[ "$1" != --* ]]; then OUT="$1"; shift; fi
    javac -nowarn -encoding UTF-8 -cp "$JAR" -d "$TMP" "$HERE/DialogKeys.java"
    # clean user.home: IJ_Prefs would leak the operator's settings into the keys and defaults
    java -Duser.home="$TMP/home" -Dfile.encoding=UTF-8 -cp "$TMP$SEP$JAR" DialogKeys "$OUT" "$@"
    ;;
  fiji)
    FIJI="${FIJI:-D:/APT/3A/BIOIMAGING/Fiji}"
    OUT="$ROOT/fiji-macro-keys.json"; if [ $# -gt 0 ] && [[ "$1" != --* ]]; then OUT="$1"; shift; fi
    JH="$(ls -d "$FIJI"/java/win64/*/ | head -1)"; JAVA="$JH/bin/java"; JAVAC="$JH/bin/javac"; [ -x "$JAVAC" ] || JAVAC=javac
    CP="$FIJI/jars/*;$FIJI/plugins/*"
    "$JAVAC" -nowarn -encoding UTF-8 -cp "$CP" -d "$TMP" "$HERE/DialogKeys.java" "$HERE/FijiScijava.java"
    # the Fiji commands the Studio maps (PLAN Appendix A): GenericDialog ones through DialogKeys, SciJava ones through FijiScijava
    printf '%s\n' "Auto Threshold" "Auto Local Threshold" "Enhance Local Contrast (CLAHE)" "Tubeness" "Directionality" \
      "Analyze Skeleton (2D/3D)" "Local Thickness (complete process)" "Coloc 2" "Cell Counter" "16 colors" "HiLo" "Anisotropic Diffusion 2D" "Re-order Hyperstack ..." > "$TMP/fiji-names.txt"
    "$JAVA" -Duser.home="$TMP/home" -Dplugins.dir="$FIJI" -Dij.dir="$FIJI" -Dfile.encoding=UTF-8 -cp "$TMP;$CP" DialogKeys "$OUT" --fiji --names-file "$TMP/fiji-names.txt" "$@"
    "$JAVA" -Duser.home="$TMP/home" -Dplugins.dir="$FIJI" -Dij.dir="$FIJI" -Dfile.encoding=UTF-8 -cp "$TMP;$CP" FijiScijava "$OUT"
    ;;
  *) echo "mode: ij | fiji" >&2; exit 2;;
esac
