# Plateforme Web — v1.0.31

## [FIXED]
- **ELE-30 (LEAK-001)** — `js/viewers/volume-grid.js` : `rebuild()` retirait les groupes grid/axes de la scène (`_scene.remove`) **sans disposer** leurs ressources GPU → fuite à chaque rebuild (resize / changement de grille, appelé en boucle). Ajout de `_disposeGroup()` (dispose récursif des geometries, materials et `CanvasTexture` des sprites X/Y/Z) appelé avant chaque `remove`, plus une méthode publique `dispose()` pour le teardown complet (switch de dataset / destruction du viewer). **Sûr vis-à-vis d'ArrowHelper** : ses géométries line/cone sont des singletons partagés au niveau module (three r0.167) → seul leur `material` (par instance) est disposé, jamais la géométrie partagée (sinon tous les autres ArrowHelper seraient corrompus).
- Test : `tests/js/test_volume_grid_dispose.mjs` (vm : geometries/materials/maps de sprite disposés ; géométrie ArrowHelper partagée NON disposée) + `node --check`.
