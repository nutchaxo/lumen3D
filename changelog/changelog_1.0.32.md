# Plateforme Web — v1.0.32

## [FIXED]
- **ELE-24 (BUG-003)** — `js/viewers/volume-viewer.js` : le fallback `dims.brickSize || 128` (à **9 sites**) contredisait la taille réelle de brick (**64** : slot d'atlas SVR `svr-manager.js`, uniform `brickSize` du shader, decode worker, et `3-chunk_packer.py`). Si `brickSize` manquait dans un niveau du manifest, le placement d'atlas devenait **catastrophiquement faux (facteur 2/axe)**. Remplacé par une constante autoritaire `VOLUME_BRICK_SIZE = 64` aux 9 sites. Le `BRICK_SIZE = 128` legacy de `brick-loader.js` n'est pas autoritaire.
- Test : `tests/js/test_volume_viewer_bricksize.mjs` (0 occurrence de `|| 128`, 9 de `|| VOLUME_BRICK_SIZE`, cohérence 64 cross-module) + `node --check`.
