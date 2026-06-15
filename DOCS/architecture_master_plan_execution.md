# Architecture Master Plan - Revue Technique Et Plan D'Execution

Date: 2026-04-28  
Contexte code actuel: `WebGL + Three.js + slices WebP + pipeline preview/native + option bricks`  
Cible proposee: `WebGPU + WASM + pre-baking exhaustif + OME-Zarr streaming`

## Statut D'Execution (2026-04-28)

- Phase 0: `TERMINEE`
  - Telemetry runtime active (`PerfTelemetry`) avec spans d'initialisation, chargement volume, rendu coupe, fetch/decode image, upload texture, first interaction, frame-time.
  - QA CDP profile-aware (`desktop`, `mobile-throttled`) avec export JSON (`--out`) et scenario `full` / `viewer-only`.
  - Baseline consolidee: `DOCS/perf_baseline.md`.
- Phase 1: `TERMINEE`
  - Nouveau preprocess out-of-core ajoute: `preprocess/brick_preprocessor_dask.py`.
  - Manifest v2 enrichi: LODs, hash SHA-256, histogrammes/stats, index chunks (AABB + occupancy), support live multi-timepoints (`bricks/t000/...`).
  - Viewer adapte pour manifests bricks timepoint-scopes (selection automatique du sous-chemin timepoint).
  - Generation pyramides 2D ajoutee: `preprocess/generate_deepzoom_tiles.py` (tiles `256x256` + `tiles2d/manifest.json`, orchestrable via `run_all.py --build-tiles2d`).
- Phase 2: `TERMINEE` (front existant)
  - Streaming bricks fonctionnel via `loadBrickedVolumeStream` + `BrickLoader`.
  - Priorisation centre-peripherie, batch dynamique, cancel/restart robuste.
  - Fallback automatique slices classiques si manifest absent.
- Phase 3: `INTEGREE` (front JS, WASM optionnel)
  - Module `AABBIntersector` (js/core/aabb-intersector.js): implementation JS pure du Slab Method, avec detection auto WASM si compile.
  - Worker `smart-slicer-worker.js` (js/components/smart-slicer-worker.js): intersection + smart fetch + sampling pixels, entierement off-thread.
  - Integration dans `viewer.js`: dispatch oblique worker, rendu canvas, progression, annulation.
  - Script build WASM pret: `wasm/build_wasm.bat` (necessite Emscripten SDK).
  - Validation: le JS fallback tourne en <1ms pour 1000 chunks sur desktop.
- Phase 5: `INTEGREE` (front)
  - Module `DeepZoomViewer` (js/components/deepzoom-viewer.js): encapsulation OpenSeadragon, manifest tiles2d, navigation Z, events viewport.
  - Integration viewer.html: bouton toggle 2D, conteneur DeepZoom, controles Z-slice, retour 3D.
  - OpenSeadragon CDN charge en defer.
  - Masquage automatique du bouton si source tiles2d absente pour le dataset.

---

## 1) Verdict Global

Le plan est ambitieux et va dans la bonne direction, mais il doit etre ajuste sur 4 points pour rester realiste en production:

1. `Zero-math client` ne peut pas etre absolu:
   - Le client doit encore faire des maths de navigation, transforms camera, interpolation de LUT, et composition finale.
   - La bonne cible est: `zero full-volume CPU scan at runtime`, pas `zero math`.
2. `WebGPU only` n'est pas viable aujourd'hui sur tout le parc:
   - Il faut `WebGPU primary + WebGL2 fallback` (desktop, iOS, Android heterogene).
3. Le pre-baking des AABB seuls est insuffisant pour l'oblique rapide:
   - Il faut aussi un `index spatial par LOD`, plus `bitmask non-vide` par brique.
4. WASM intersection est utile, mais ce n'est pas toujours le bottleneck #1:
   - Le plus gros gain vient souvent de la reduction des fetch/decode/transfers.

Conclusion: architecture tres solide si on la convertit en migration progressive, avec KPIs stricts.

---

## 2) Etat Actuel Du Projet (Important Pour Le Gap)

Le code courant a deja des briques utiles:

1. Pipeline qualite multi-niveaux 3D:
   - `preview`, `balanced`, `high`, `native` dans `js/viewers/volume-viewer.js`.
2. Cache LRU image + cache LRU volume.
3. Mode streaming bricks deja implemente cote front (`BrickLoader` + `loadBrickedVolumeStream`), mais manifests absents dans `DATA_WEB`.
4. Coupe 2D preview/native deja asynchrone avec worker (`volume-slicer-worker.js`).
5. Export natif deja present (viewer + studio), avec composition haute resolution.

Implication: il ne faut pas refaire from-scratch. Il faut remplacer les points critiques par etapes.

---

## 3) Ajustements Techniques Sur Le Master Plan

### 3.1 Preprocess out-of-core

Ton orientation `Dask + Zarr + pre-baking` est la bonne.
Corrections a appliquer:

1. Ne pas stacker systematiquement tout RGBA en un seul tableau geant avant ecriture.
2. Ecrire directement bloc par bloc vers Zarr (ou `da.store` sur chunk graph optimise).
3. Pre-calculer par LOD:
   - histogrammes globaux par canal,
   - histogrammes par brique (ou au minimum p01/p99/mean/std + empty ratio),
   - mask occupancy (non-empty voxels),
   - index AABB compact.

### 3.2 Index intersection

WASM C++ AABB-plane test est bon.
Ajout conseille:

1. Support d'un `slab thickness` (plan epais), pas seulement plan infinitesimal.
2. Tri de priorite des chunks (distance camera + viewport projected area).
3. Sortie WASM: IDs + priorites, pas seulement IDs.

### 3.3 WebGPU

Le shader WGSL propose est correct comme base.
Ajouts necessaires pour prod:

1. Transfer function texture (LUT 1D/2D), pas juste min/max hardcoded.
2. Jitter + early ray termination + step adaptation.
3. Empty space skipping via occupancy grid 3D (pas uniquement alpha test local).
4. Multi-pass optionnel pour qualite (mobile vs desktop tiers).

### 3.4 Mode 2D verite terrain

OpenSeadragon/DZI est pertinent pour coupes 4k+.
Decision pratique:

1. Garder Studio Canvas pour annotations/edit.
2. Ajouter un mode `source tile viewer` dedie (lecture pyramidale 2D), puis bridge annotation.

---

## 4) Plan D'Execution Recommande (Par Phases)

## Phase 0 - Instrumentation Et Baseline (obligatoire)

Objectif: mesurer avant d'optimiser.

Livrables:

1. Telemetrie JSON par session:
   - temps fetch, decode, upload texture, first-interaction, frame-time.
2. Scenarios bench standardises:
   - fixed 4 canaux, live multi-timepoints, mobile throttled.
3. Rapport baseline dans `DOCS/perf_baseline.md`.

Acceptance:

1. Reproductibilite des mesures.
2. Comparaison avant/apres possible sur chaque PR.

## Phase 1 - Data Layer Production (Python)

Objectif: alimenter le front avec metadata riches.

Livrables:

1. Nouveau preprocess `Dask out-of-core`.
2. Generation `bricks/manifest.json` complete:
   - LODs, dimensions, brick size, hash, histogram stats, occupancy info.
3. Generation pyramides 2D (DZI/ome-tiff tiles) pour mode coupe source.

Acceptance:

1. Dataset 27GB traite sans OOM.
2. Manifest valide sur fixed+live.
3. Hash verification front fonctionnelle.

## Phase 2 - Streaming Bricks Front

Objectif: rendre le streaming bricks reel et progressif en prod.

Livrables:

1. Activer `loadBrickedVolumeStream` en chemin principal si manifest present.
2. Priorisation chunks visible-first.
3. UI progress non bloquante + cancel/restart robuste.

Acceptance:

1. Manipulation camera fluide pendant stream.
2. Remplacement progressif low->high observable.
3. Fallback slices automatique si erreur manifest/bricks.

## Phase 3 - WASM Intersection Engine

Objectif: calcul oblique chunks-to-fetch hors JS.

Livrables:

1. Module WASM (`aabb_plane_intersect`) integre via worker.
2. API JS stable:
   - input: plane/slab + index chunks,
   - output: chunk IDs priorises.
3. Tests de coherence numerique JS vs WASM.

Acceptance:

1. Selection chunks oblique < 1 ms desktop cible.
2. Pas de regressions de precision visible.

## Phase 4 - WebGPU Renderer

Objectif: moteur principal desktop moderne.

Livrables:

1. Renderer WebGPU (WGSL) feature-flagge.
2. Fallback WebGL2 garanti.
3. Parite fonctionnelle minimale:
   - clipping, LUT canaux, MIP/average, mesure picking compatible.

Acceptance:

1. Visuel coherent WebGL vs WebGPU.
2. Gain mesurable sur scenes volumetriques lourdes.

## Phase 5 - 2D Deep Zoom Source Mode

Objectif: navigation coupes natives ultra-fluides.

Livrables:

1. Mode OpenSeadragon (ou equivalent tuiles 2D).
2. Passage viewer 3D -> coupe source -> studio annotation.
3. Export final natif avec annotations vectorielles.

Acceptance:

1. Zoom/pan 4k+ sans lag.
2. Calibration metrique conservee.

---

## 5) KPIs Cibles (A Negotiation)

1. Time-to-first-volume (preview): < 1.2 s desktop, < 2.5 s mobile.
2. Time-to-interactive after quality switch: < 150 ms freeze cumule.
3. Oblique slice request to visible preview: < 400 ms.
4. Native slice render (webp stack): < 1.5 s median.
5. Peak RAM tab desktop (dataset lourd): reduction >= 30% vs baseline.

---

## 6) Risques Et Mitigations

1. Risque: fragmentation GPU memoire sur gros volumes.
   - Mitigation: bricking + LOD + eviction stricte.
2. Risque: support WebGPU heterogene.
   - Mitigation: fallback WebGL2 maintenu en first-class.
3. Risque: pipeline preprocess trop long.
   - Mitigation: parallisation Dask + cache incremental + resume.
4. Risque: derive complexite produit.
   - Mitigation: feature flags et gates de release par phase.

---

## 7) Recommandation Immediate

Demarrer par `Phase 0 + Phase 1` avant toute migration renderer.

Raison:

1. Sans data layer robuste, WebGPU/WASM n'ont pas de matiere exploitable.
2. Les gains les plus rapides viennent souvent du pre-baking + streaming discipline.
3. Les KPIs objectivent les choix techniques et evitent les regressions silencieuses.

---

## 8) Fichiers Cible Pour Le Demarrage (Codebase Actuel)

1. `preprocess/brick_preprocessor.py` (et nouveau preprocess dask).
2. `preprocess/generate_catalog.py` (exposer manifest bricks + pyramides 2D).
3. `js/viewers/volume-viewer.js` (chemin principal streaming).
4. `js/core/brick-loader.js` (priorisation + stats + cancellation fine).
5. `js/components/volume-slicer.js` (alignement oblique data source).
6. `preprocess/browser_qa.py` (bench probes et assertions perf).

Ce plan est directement exploitable pour une execution en PRs incrementales, avec risques controles.
