S=/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad
rm -f $S/r2-18/chk/*; cp /home/user/lumen3D/DOCS/documentation/img/ch18/*.svg $S/r2-18/chk/
cd $S && node svg2png.mjs $(ls $S/r2-18/chk/*.svg)
