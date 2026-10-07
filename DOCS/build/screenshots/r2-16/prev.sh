#!/bin/bash
S=/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/r2-16
cd /home/user/lumen3D && python3 DOCS/build/build_docs.py --preview DOCS/documentation DOCS/documentation/complete/16-personnaliser.md --out $S/preview.pdf --png $S/png 2>&1 | grep -E "pages\)|Error|error" ; cd $S && python3 spreads.py
