#!/usr/bin/env bash
# Regenerates tests/fixtures/ij-macro/files-golden.json: the file-function corpus of the macro VFS
# (tests/fixtures/ij-macro/files/<group>/<case>/{macro.ijm,in/,case.json,setup.ijm}) run through the real ij-1.54p.jar headless.
# Local only, never CI. Contract: DOCS/studio-advanced/macros/FILES.md section 15.
#
#   tools/ij_fixtures/macro/run_files.sh <path-to-ij-1.54p.jar>                 # writes files-golden.json
#   tools/ij_fixtures/macro/run_files.sh <path-to-ij-1.54p.jar> --make-inputs   # (re)writes the images of <case>/in/ from <case>/setup.ijm
#   tools/ij_fixtures/macro/run_files.sh <path-to-ij-1.54p.jar> out.json [filesDir]
#
# IJM_ONLY=<substring of group/case> runs only the matching cases (a partial run, e.g. while writing one).
# The granted folder of every case is the real directory /ijm-vfs-golden/ on the drive of the current directory (the script
# cds to the repository); it is only touched when it does not exist or the marker file /ijm-vfs-golden.marker sits beside it.
set -euo pipefail
JAR="${1:?path to ij-1.54p.jar}"
MODE="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../../tests/fixtures/ij-macro"
FILES="${3:-$ROOT/files}"
OUT="$ROOT/files-golden.json"
[ -n "$MODE" ] && [ "$MODE" != "--make-inputs" ] && OUT="$MODE"
SRC="$HERE/../../../DOCS/studio-advanced/macros/ij-src"
TMP="$(mktemp -d)"; HOMEDIR="$(mktemp -d)"
if command -v cygpath >/dev/null 2>&1; then
  TMP="$(cygpath -m "$TMP")"; HOMEDIR="$(cygpath -m "$HOMEDIR")"; JAR="$(cygpath -m "$JAR")"
  FILES="$(cygpath -m "$FILES")"; OUT="$(cygpath -m "$OUT")"; SRC="$(cygpath -m "$SRC")"
fi
trap 'rm -rf "$TMP" "$HOMEDIR"' EXIT
SEP=":"; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) SEP=";";; esac
javac -nowarn -encoding UTF-8 -cp "$JAR" -d "$TMP" "$HERE/FileProbe.java" "$HERE/FileGolden.java"
mkdir -p "$TMP/stub"; javac -nowarn -encoding UTF-8 -d "$TMP/stub" "$HERE/stub/ij/gui/GenericDialog.java"
cd "$HERE/../../.."
ARGS=("$FILES" "$OUT"); [ "$MODE" = "--make-inputs" ] && ARGS=(--make-inputs "$FILES")
exec java -Djava.awt.headless=true -Dfile.encoding=UTF-8 -Duser.timezone=UTC -Duser.language=en -Duser.country=US \
  -Duser.home="$HOMEDIR" -Dmacro.stubdir="$TMP/stub" -Dijm.srcdir="$SRC" -Dijm.only="${IJM_ONLY:-}" -cp "$TMP$SEP$JAR" FileGolden "${ARGS[@]}"
