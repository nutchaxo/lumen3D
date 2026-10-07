#!/bin/bash
S=/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad
cd /home/user/lumen3D
python3 DOCS/build/build_docs.py --preview DOCS/documentation DOCS/documentation/complete/01-vue-ensemble.md DOCS/documentation/complete/02-technologies.md DOCS/documentation/complete/03-pages.md --out $S/w-b/preview.pdf --png $S/w-b/png 2>&1 | tail -2
rm -rf $S/w-b/hi; mkdir $S/w-b/hi; pdftoppm -r 80 -png $S/w-b/preview.pdf $S/w-b/hi/p
