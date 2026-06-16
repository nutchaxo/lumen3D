# Plateforme Web — v1.0.30

## [FIXED]
- **ELE-25 (BUG-004)** — `js/core/brick-decode-worker.js` + `js/core/brick-loader.js` : en mode grid, `packing.cols` par défaut valait **16** alors que la mosaïque réelle (`3-chunk_packer.py`) est **8×8** pour `bs=64` → délacement Z totalement erroné (silencieux, `ok:true`) si un manifest grid omet `cols`. Le défaut est désormais **dérivé de la géométrie réelle** (`ceil(bs / ceil(sqrt(bs)))` → 8 pour 64), corrigé **identiquement** dans le worker et le fallback du loader (sinon les deux chemins re-divergent). Une valeur `cols` explicite et valide est toujours respectée.
- Test : `tests/js/test_brick_decode_cols.mjs` (mosaïque 512² encodant l'index de tuile : `cols` dérivé = 8 place la slice Z au bon tile ; le 16 historique donnait 0) + `node --check` + non-régression `test_brick_decode_cancel.mjs`.
