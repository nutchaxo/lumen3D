# Plateforme Web v0.5.3 — 2026-06-04

## [OPTIMIZED] Filtre gaussien : pool de Workers parallèles (~3-4x plus rapide)

### Avant (v0.5.2) — 1 seul Worker
```
rawChannelData → Worker unique → blur séquentiel de N slices → résultat
Temps : ~2-4s pour ~100 slices
```

### Après (v0.5.3) — Pool de Workers
```
rawChannelData → split en N chunks → N Workers en parallèle → assemblage résultat
N = min(4, navigator.hardwareConcurrency)
Temps : ~0.5-1.5s pour ~100 slices (parallélisme CPU)
```

### Détails techniques
- `BLUR_POOL_SIZE` = min(4, `navigator.hardwareConcurrency`)
- Chaque Worker reçoit un chunk de `depth / N` slices (zero-copy Transferable)
- Les résultats sont assemblés dans l'ordre via `_blurAssemblers` Map
- Les Workers renvoient `chunkIndex` pour l'assemblage correct
- Fallback automatique si le pool ne peut pas être créé

## [FIXED] Écran noir au rechargement de page (état caméra perdu)

### Cause racine
Au rechargement, le volume preview chargeait en premier et appelait `fitCameraToVolume()`
avec la scale de la preview. Puis l'état URL restaurait la caméra avec les valeurs de l'ancienne
session (basées sur la scale high). La différence de scale preview/high causait un décalage de
la distance caméra → le volume devenait invisible.

### Fix
Avant de charger le volume, si un état URL `#state=` ou un `_pendingWorkspaceState` avec
une caméra existe, on pré-marque `_hasLoadedVolume = true` via la nouvelle API
`VolumeViewer.setHasLoadedVolume(true)`. Ainsi, `fitCameraToVolume()` n'est **jamais**
appelé lors du chargement preview, et l'état caméra sauvé est restauré tel quel après le
chargement.

### Fichiers modifiés
- `volume-viewer.js` : nouvelle API `setHasLoadedVolume(bool)`
- `viewer.js` : pré-détection de l'état caméra pending avant le chargement
