#!/usr/bin/env bash
# Local only (never shipped, never CI). Runs a class of this folder against a Fiji install.
# Usage: run_fiji.sh <MainClass> [args...]      env: FIJI (default D:/APT/3A/BIOIMAGING/Fiji), FIJI_TMP (class dir)
# The classes are compiled against Fiji's own jars; Fiji's bundled Java runs them (GUI mode: some plugins open windows).
set -euo pipefail
FIJI="${FIJI:-D:/APT/3A/BIOIMAGING/Fiji}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="${FIJI_TMP:-$(mktemp -d)}"; mkdir -p "$TMP"; if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; fi
JH="$(ls -d "$FIJI"/java/win64/*/ | head -1)"
JAVA="$JH/bin/java"; JAVAC="$JH/bin/javac"
[ -x "$JAVAC" ] || JAVAC=javac
CP="$FIJI/jars/*;$FIJI/plugins/*"
"$JAVAC" -nowarn -encoding UTF-8 -cp "$CP" -d "$TMP" "$HERE"/../*.java "$HERE"/*.java
CLS="$1"; shift
# clean user.home: ImageJ reads IJ_Prefs (blackBackground, measurements, ...) from it; the operator's own preferences must not leak into a capture
mkdir -p "$TMP/home"
"$JAVA" -Duser.home="$TMP/home" -Dplugins.dir="$FIJI" -Dij.dir="$FIJI" -cp "$TMP;$CP" "$CLS" "$@"
