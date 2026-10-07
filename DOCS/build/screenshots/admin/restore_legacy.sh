#!/bin/sh
# Restore the two legacy demo datasets (formats 1 and 2) from the backup and clear the migration journal.
S=${S:-/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad}
R=/home/user/lumen3D
for d in Embryo-E8-Em5-Pecam1-Sox2 Embryo-E9-Em6-Pecam1-Sox2; do rm -rf "$R/DATA_WEB/3d/$d"; cp -a "$S/legacy-backup/$d" "$R/DATA_WEB/3d/$d"; done
rm -rf "$R/uploads/migrations"
