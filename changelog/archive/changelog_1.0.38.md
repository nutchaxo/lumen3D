# Plateforme Web — v1.0.38

## [FIXED]
- **STREAMING-2 / DEAD-026 / BUG-036** — Constante `BRICK_SIZE` de repli corrigée de **128 → 64** dans `js/core/brick-loader.js` (+ commentaire d'en-tête « bricks (128³) » → « (64³) »). 128 était une valeur legacy qui ne correspondait à **aucune** brick réelle (le pipeline `preprocess/3-chunk_packer.py` produit toujours des bricks **64³**, mosaïquées 8×8 en tuiles 512²) et la cible de décodage / le SVRManager / le shader sont tous codés en dur à 64. La constante n'était donc jamais la bonne valeur : soit le manifest fournit `brickSize:64` (et le repli n'est jamais atteint), soit il l'omet et **128 produisait une corruption**. Tous les sites de repli deviennent corrects :
  - `getDimensions(lod).brickSize` → 64 quand un niveau omet `brickSize` (chemin d'upload GPU déjà aligné sur 64 par ELE-24/`VOLUME_BRICK_SIZE`) ;
  - `getCacheStats().memoryEstimateMB` → estimation correcte (256 KiB/brick) au lieu de **8× trop** (128³ vs 64³) — **BUG-036** ;
  - quatre chemins de décodage de repli (`_decodeWebpBrickInWorkerPool`, etc.) → taille correcte.
- **BUG-fetch-worker** — `js/core/brick-fetch-worker.js` : les deux blank-bricks de repli (`new Uint8Array(bs³·channels)` quand un pack manque ou qu'un fetch échoue) utilisaient le littéral `|| 128` → buffer vide **8× surdimensionné** mal interprété en aval. Corrigé en `|| 64`.
- Test : `tests/js/test_brick_size_64.mjs` (comportemental : `getDimensions` retombe sur 64 quand `brickSize` absent, honore un `brickSize` explicite ; structurel : constante = 64, en-tête corrigé, les deux replis du fetch-worker = 64) + non-régression sur la suite brick-loader (`concurrency`, `manifest-validate`, `degrade`, `decode-cols`).
