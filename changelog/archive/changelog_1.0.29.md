# Plateforme Web — v1.0.29

## [FIXED]
- **ELE-23 (BUG-002)** — `js/core/svr-manager.js` : `writeBrick`/`writeRgbaBrick` ne mettaient à jour la PageTable que si `pageData[ptIdx+3]===0` (alpha). Quand `getSlot` recycle un slot par éviction, le nouveau slot n'était jamais re-pointé → **brick fantôme** lisant le mauvais slot d'atlas (corruption visuelle silencieuse). La PageTable est désormais **toujours** re-pointée vers le slot que `getSlot` vient d'attribuer (invariant : `PT[brick] === _slotCoord(getSlot(brick))`). Réutilise un unique `_slotCoord(slotIndex)` (supprime un appel dupliqué). _Note : la fermeture complète des bricks fantômes nécessite aussi le rebuild de `slotToBrick` à la taille `maxSlots` finale (STREAMING-13) — hors périmètre, à suivre._
- Test : `tests/js/test_svr_pagetable_recycle.mjs` (vm : re-point inconditionnel après injection d'un alpha stale) + `node --check`.
