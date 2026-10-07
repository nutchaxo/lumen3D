# English images: run from anywhere
S=/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/w-e
cd $S
export UI_LANG=en IMG_DIR=/home/user/lumen3D/DOCS/documentation/img-en FIG_LANG=en
python3 make_figures.py
node s_modes2.mjs; node s_chan3.mjs; node s_chan2.mjs >/dev/null; node s_stream.mjs; node s_live.mjs
