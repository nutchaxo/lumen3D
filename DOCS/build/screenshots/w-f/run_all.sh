#!/bin/bash
# Regenerates every screenshot of chapter 12 (about 40 minutes: software WebGL).
# French:  UI_LANG=fr bash run_all.sh                 -> DOCS/documentation/img/ch12
# English: UI_LANG=en bash run_all.sh                 -> DOCS/documentation/img-en/ch12  (IMG_DIR overrides)
cd "$(dirname "$0")"
for s in ${SCRIPTS:-toolbar measure visuels orient slice studio zstack misc decomp live live5 d2 d22 cmp}; do
  echo "== $s"; node $s.mjs || echo "FAILED $s"
done
python3 make_avant_apres.py
python3 make_crops.py
