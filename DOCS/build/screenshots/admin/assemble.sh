#!/bin/sh
# Assemble the guide from md/p*.md and copy the screenshots it references into DOCS/admin-guide/img/
S=/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/admin
D=/home/user/lumen3D/DOCS/admin-guide
cat $S/md/p1.md $S/md/p2.md $S/md/p3.md $S/md/p4.md $S/md/p5.md > $D/GUIDE-ADMINISTRATEUR.md
for f in $(grep -o 'img/[a-zA-Z0-9_-]*\.png' $D/GUIDE-ADMINISTRATEUR.md | sort -u); do
  n=$(basename $f)
  if [ -f $S/png/$n ]; then cp $S/png/$n $D/img/$n; else echo "kept/missing: $n"; fi
done
