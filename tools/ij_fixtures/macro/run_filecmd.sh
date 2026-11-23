#!/usr/bin/env bash
# Runs FileCmdProbe (option keys of ImageJ 1.54p's file commands) against the real jar. Local only, never CI.
# Usage: tools/ij_fixtures/macro/run_filecmd.sh <path-to-ij-1.54p.jar>
set -euo pipefail
JAR="${1:?path to ij-1.54p.jar}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; fi
trap 'rm -rf "$TMP"' EXIT
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
javac -nowarn -encoding UTF-8 -cp "$JAR" -d "$TMP" "$HERE/FileCmdProbe.java"
java -Djava.awt.headless=false -Dfile.encoding=UTF-8 -Duser.home="$TMP" -cp "$TMP$SEP$JAR" FileCmdProbe | grep '^P|'
