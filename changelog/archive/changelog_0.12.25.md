# Changelog 0.12.25 (Plateforme Web)

## [ADDED]
- **Affichage des Chunks Progressif :**
  - Restauration de l'affichage progressif des briques durant le chargement de données volumétriques.
  - Implémentation d'un système de file d'attente (`_dirtyRegions`) pour accumuler les briques décodées sur le CPU (`tex.image.data`).
  - Téléchargement GPU partiel et asynchrone des briques accumulées via des appels optimisés de `gl.texSubImage3D` (au lieu de ré-uploader l'entièreté de la texture 3D de plusieurs centaines de Mo à chaque mise à jour).
  - Rafraîchissement progressif fluide sur l'écran sans causer de blocage ou de chute de FPS sur le thread principal.

## [OPTIMIZED]
- **Mode Résolution Auto (Zoom/Rotation) :**
  - Les ajustements dynamiques de qualité (diminution des pas du Raymarching et du ratio de pixels lors des mouvements) sont maintenant isolés exclusivement au mode **Auto**.
  - En mode Résolution Fixe (ex: 512x512, 1024x1024, Native), la résolution est conservée à 100% de sa valeur sans aucune réduction en interaction, respectant le comportement brut désiré.

## [FIXED]
- **Chargement des Résolutions Supérieures au Zoom (Auto Mode) :**
  - Correction de `_preferredAutoQuality()` pour interroger dynamiquement les niveaux de détail réels (`levels`) du manifeste du volume (`_brickManifest`).
  - Sélection automatique du meilleur niveau de détail (LOD) selon l'échelle en pixels de l'affichage du volume (`computeScreenPixelSize`), avec une limite de sécurité à 600 millions de voxels pour éviter les crashes mémoire sur les volumes gigantesques.
  - Correction de `VolumeViewer.setQualityTarget` pour recevoir le mode parent (`_qualityMode`) et éviter d'écraser la modalité d'interaction adaptative.
  - Incrément du cache-buster global à `v149` dans `viewer.html` pour invalider les scripts mis en cache.
