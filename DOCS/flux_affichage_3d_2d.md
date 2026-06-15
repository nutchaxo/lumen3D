# Flux D'Affichage 3D/2D - Viewer et Studio

Date de reference: 2026-04-28  
Code de reference: `js/viewers/volume-viewer.js`, `js/components/volume-slicer.js`, `js/components/volume-slicer-worker.js`, `js/core/brick-loader.js`, `js/pages/viewer.js`, `js/components/studio-editor.js`.

## 1. Objectif de ce document

Decrire integralement les flux de donnees et de rendu:

1. Chargement des volumes 3D (preview / balanced / high / native / bricks).
2. Gestion des qualites, caches, et transitions.
3. Generation des coupes 2D (preview et native).
4. Rendu Studio 2D et recomposition canaux.
5. Pipeline d'export final (PNG/WebP/JSON).
6. Taille des donnees manipulees (ordre de grandeur reel dans `DATA_WEB`).

---

## 2. Stack technique utilisee

- Rendu 3D: `Three.js` + `WebGL` (`Data3DTexture` / `DataTexture3D`).
- Rendu 2D: Canvas 2D (`ImageData`, `drawImage`, overlays vectoriels).
- Chargement image: `fetch` + `createImageBitmap` (fallback `<img>`).
- Concurrence:
  - 3D slices: chargement parallele limite (`CONCURRENT_IMAGE_LOADS=10`).
  - prefetch: `PRELOAD_IMAGE_LOADS=6`.
  - coupes 2D: worker dedie (`volume-slicer-worker.js`) avec annulation par `jobId`.
- Option streaming bricks: `BrickLoader` (LRU memoire, hash SHA-256 optionnel).

---

## 3. Pipeline 3D principal (slices WebP)

Entree: `ViewerApp._loadTimepoint(...)` -> `VolumeViewer.loadVolume(...)`.

Etapes:

1. Selection qualite via `QUALITY_PRESETS`:
   - `preview`: `preview/slices`, `maxTextureSize=256`, `maxDepthSamples=56`
   - `balanced`: `slices`, `640`, `128`
   - `high`: `slices`, `1024`, `192`
   - `native`: `slices`, `2048`, `320`
2. Construction de la liste des slices `z/c` a charger (echantillonnage Z via `zIndices`).
3. Chargement parallele des WebP -> decodage -> insertion dans `Uint8Array` RGBA 3D.
4. Nettoyage fond volume (`_suppressBackgroundVolume`) avant upload GPU.
5. Creation texture 3D (`Data3DTexture`) et activation shader ray-marching.
6. Calcul histogrammes canaux (`_computeChannelHistograms`) et publication UI.

Remarques perf:

- Le volume est stocke en `Uint8 RGBA` meme si `c < 4`.
- Cout memoire CPU brut d'un volume actif: `width * height * depth * 4` octets.
- Cout GPU comparable (texture 3D RGBA8).

Exemple brut `1024x1024x192`: environ 805 MB (CPU) + environ 805 MB (GPU), hors overhead.

---

## 4. Gestion des qualites et transition utilisateur

Politique actuelle (`ViewerApp`):

1. En `auto`: charge `preview` d'abord.
2. Puis charge `high` en arriere-plan (`_scheduleBackgroundQuality`).
3. UI reste interactive pendant montee en qualite.

Controles existants:

- `VolumeViewer.setQualityTarget(...)`
- `VolumeViewer.onQualityProgress(...)`
- Overlay progress (`quality-stream-progress`).

Caches:

- Cache images 2D source: `_imageCache` (LRU, limite `IMAGE_CACHE_LIMIT=640`).
- Cache volumes reconstruits: `_volumeCache` (LRU, limite `VOLUME_CACHE_LIMIT=4`).

---

## 5. Streaming bricks (mode optionnel)

Entree: `VolumeViewer.loadBrickedVolumeStream(...)`.

Contrat attendu:

- `DATA_WEB/.../bricks/manifest.json`
- Fichiers: `bricks/lod{n}/c{c}/x###_y###_z###.webp`
- Metadonnees de hash optionnelles (`manifest.hashes`) verifiees cote client.

Comportement:

1. Si manifest absent/invalide: fallback automatique vers pipeline slices classique.
2. Si disponible: chargement par lots de briques (batch dynamique), triees centre -> peripherie.
3. Ecriture progressive dans texture 3D active (`needsUpdate=true` en continu).
4. Progression remontee en continu (`onProgress`, `_emitQualityState`).

Etat actuel du workspace:

- Aucun `DATA_WEB/**/bricks/manifest.json` detecte au moment de ce document.
- Le flux bricks est implemente cote front mais non alimente par les donnees presentes.
- Generation offline disponible: `preprocess/brick_preprocessor.py`.

---

## 6. Pipeline coupe 2D preview

Entree: mode coupe -> `ViewerApp._renderSlicePreview()` -> `VolumeSlicer.renderPreview(...)`.

Source des donnees:

- Volume 3D actif deja en memoire (`VolumeViewer.getSamplingVolume()`), pas de refetch disque.

Traitement:

1. Definition plan (`mode`, `yaw/pitch/roll`, `projection`, `slabThickness`).
2. Echantillonnage volume en plan 2D (nearest/trilinear selon cas).
3. Suppression fond coupe + masque alpha.
4. Composition RGB via LUT canaux (`min/max/gamma/opacity`).
5. Dessin sur `slice-preview-canvas`.

Sortie:

- `sliceResult`: `{raw, mask, canvas, pixelSizeUm, planeSpec, ...}`.

---

## 7. Pipeline coupe 2D native (haute resolution)

Entree: bouton native / ouverture Studio -> `VolumeSlicer.renderNative(...)`.

Source des donnees:

- WebP natifs dans `DATA_WEB/.../slices`.
- Fallback OME-Zarr possible via proxy manifeste (`.codex-slice-proxy.json`).

Traitement:

1. Mapping pixels du plan vers coordonnees source.
2. Lecture slices Z/c necessaires, decodage image.
3. Re-echantillonnage intensite, MIP/average selon projection.
4. Suppression fond coupe, composition LUT.
5. Callback de progression (`onProgress`) + annulation (`AbortController` + `jobId`).

Worker:

- `volume-slicer-worker.js` utilise par defaut.
- Fallback main-thread en cas d'echec worker.

---

## 8. Studio 2D

Entree:

1. Demande de rendu natif de la coupe active.
2. Ouverture du Studio uniquement quand la coupe native est disponible.

Rendu:

- Canvas 2D infini (pan/zoom/rotation viewport).
- Image source + calques vectoriels (distance, angle, texte, scalebar, etc).

Canaux:

- Recomposition locale via `VolumeSlicer.recompose(...)` sur `raw + mask`.
- Histogrammes recalcules sur coupe active (`computeChannelHistograms`).

Document:

- Modele `StudioDocument v2` avec `planeSpec`, `channelState`, `calibration`, `layers`.

---

## 9. Exports finaux

### 9.1 Export coupe (viewer)

- `VolumeSlicer.exportSlice(...)`:
  - compose image sur fond noir (masque les zones alpha),
  - ajoute legende scalebar et metadata stamp,
  - format PNG/WebP.

### 9.2 Export natif HQ (viewer)

- `viewer.js` (`btn-hq-download`):
  - tente `renderNative(...)` en resolution max source,
  - compose background (noir/blanc/transparent selon preset export),
  - incruste annotations + stamp.

### 9.3 Export Studio PNG

- `StudioEditor._exportPng()`:
  - tente source native maximale,
  - compose sur fond noir,
  - rasterise calques vectoriels a l'echelle native,
  - ajoute stamp metadata.

### 9.4 Export Studio JSON

- Export document editable complet (`version`, `layers`, `channelState`, calibration...).

---

## 10. Tailles de donnees observees (workspace actuel)

Mesures directes sur `DATA_WEB` (fichiers presents localement):

### Dataset fixed `Egfl7eGFP-E75-Em1-18112025-GFP555-Pecam1-10x-2xzoom-4avg`

- `slices`: 616 fichiers, 60.55 MB
- `bundles/web_slices.zip`: 63,557,542 bytes (environ 60.6 MB)
- `preview/slices`: 193 fichiers, 0.16 MB
- `bundles/preview_slices.zip`: 181,872 bytes

### Dataset fixed `Egfl7eGFP-E8-Em3-18112025-GFP555-Pecam1-10x-2xzoom-4avg`

- `slices`: 1028 fichiers, 53.65 MB
- `bundles/web_slices.zip`: 56,569,204 bytes (environ 54.0 MB)
- `preview/slices`: 193 fichiers, 0.19 MB

### Dataset live `E7-E825-21122023-DAPI-Pecam1488-Flk1mCherry-RFP647-10x-stack`

- `slices`: 120 fichiers, 27.80 MB
- `bundles/web_slices.zip`: 29,168,534 bytes (environ 27.8 MB)
- `preview/slices`: 121 fichiers, 0.22 MB

Implication:

- Le preview est tres leger et adapte au first paint.
- Le cout dominant est la montee en qualite (`slices` / `web_slices.zip`) et surtout l'occupation RAM/GPU apres reconstruction volumique.

---

## 11. Preprocess offline associe

Scripts principaux:

- `preprocess/convert_fixed.py`, `preprocess/convert_live.py`:
  - conversion en WebP slices 8-bit.
- `preprocess/generate_web_optimizations.py`:
  - generation `preview/slices` (downsample) + `preview/manifest.json`.
- `preprocess/brick_preprocessor.py`:
  - generation optionnelle bricks 128^3 + `bricks/manifest.json` + hashes SHA-256.
- `preprocess/brick_preprocessor_dask.py`:
  - generation out-of-core (Dask) des manifests bricks v2 enrichis (LOD/stats/occupancy/hash/timepoints).
- `preprocess/generate_deepzoom_tiles.py`:
  - generation des pyramides 2D tilees (`tiles2d/manifest.json`) pour mode source slice multi-zoom.

---

## 12. Points deja instrumentes pour audit performance

- Progress qualite: `VolumeViewer.onQualityProgress`.
- Etat source qualite: `_qualityState` (`mode`, `progress`, `message`).
- Stats cache:
  - `VolumeViewer.getCacheStats()`
  - `BrickLoader.getCacheStats()`
- Smoke tests navigateur: `preprocess/browser_qa.py`.

Ce document couvre les flux tels qu'implementes dans le code courant, sans backend applicatif.

---

## 13. Pipeline Smart Slicer (oblique bricks, off-thread)

Entree: coupe oblique activee + manifest bricks charge.

Composants:

- `js/core/aabb-intersector.js` (`AABBIntersector`): intersection AABB-Plan (Slab Method, JS pur + WASM optionnel).
- `js/components/smart-slicer-worker.js`: Web Worker dedie (intersection + fetch + sampling).
- `viewer.js` (`_requestWorkerSlice`, `_renderWorkerSliceResult`): dispatch et rendu.

Flux:

1. `_renderSlicePreview()` detecte mode oblique + manifest bricks pret (`_canUseSmartSlicer`).
2. Dispatch message `EXTRACT_SLICE` au worker avec `planeSpec` + `outputWidth/Height`.
3. Worker calcule intersection AABB-Plan sur tous les chunks (JS ou WASM).
4. Worker fetch uniquement les briques intersectees (Smart Fetch) via `createImageBitmap` + `OffscreenCanvas`.
5. Worker echantillonne les pixels du plan a travers les briques chargees.
6. Worker renvoie `Uint8Array` pixels via `Transferable` (zero-copy).
7. Main thread cree `ImageData` et `putImageData` sur `slice-preview-canvas`.

WASM:

- Compilation optionnelle via `wasm/build_wasm.bat` (Emscripten).
- Detection automatique au demarrage: `AABBIntersector.initWasm('wasm/slicer_intersector.js')`.
- Si absent: fallback JS transparent (~0.5ms pour 1000 chunks).

---

## 14. Mode 2D Ground Truth (DeepZoom)

Entree: bouton "2D Mode" dans la toolbar Layouts.

Composants:

- `js/components/deepzoom-viewer.js` (`DeepZoomViewer`): encapsulation OpenSeadragon.
- `viewer.html`: conteneur `deepzoom-container` + controles Z-slice.
- `viewer.js` (`_bindDeepZoomToggle`, `_enterDeepZoom`, `_exitDeepZoom`).

Flux:

1. `_bindDeepZoomToggle()` verifie si source `deepzoom2d` existe dans `volumeSources`.
2. Si absent: bouton masque (`display:none`).
3. Clic bouton: `_enterDeepZoom()` cache WebGL canvas, affiche conteneur DeepZoom.
4. Charge `tiles2d/manifest.json` via `DeepZoomViewer.loadManifest(...)`.
5. OpenSeadragon affiche la pyramide de tuiles avec zoom/pan fluide.
6. Controles Z-slice: boutons prev/next, label Z courant.
7. "Back to 3D": detruit OpenSeadragon, restaure WebGL canvas, `VolumeViewer.resize()`.

Prerequis data:

- `preprocess/generate_deepzoom_tiles.py` doit avoir genere les tuiles dans `DATA_WEB/.../tiles2d/`.
- Le `manifest.json` doit contenir: `width`, `height`, `tileSize`, `levels`, `sliceCount`, `basePath`.
- Source declaree dans le catalogue via `VolumeSourceManager.normalizeSources()` avec `kind: 'deepzoom2d'`.
