set -x
for L in fr en es nl; do
  sh /tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/admin/restore_legacy.sh
  D=/home/user/lumen3D/DOCS/admin-guide/img; [ $L = fr ] || D=/home/user/lumen3D/DOCS/admin-guide/img-$L
  (cd /tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/admin-i18n && UI_LANG=$L IMG_DIR=$D timeout 1500 node s3_dupd.mjs)
done
sh /tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/admin/restore_legacy.sh
echo ALLDONE
