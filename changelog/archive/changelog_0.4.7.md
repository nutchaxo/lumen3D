# Plateforme Web - v0.4.7

## [ADDED]
- **Documentation Technique Modulaire (LaTeX) :** Création d'une documentation complète de 50 pages au format LaTeX dans le dossier `DOCS/WebPlatform/`. Redéfinition des chapitres détaillés :
  - **Chapitre 0** : Introduction et Vue d'Ensemble (Architecture globale, Philosophie "Zéro approximation", Flux de données global, Arborescence et Sécurité).
  - **Chapitre 1** : Page Explorer (Logique du catalogue, calcul des thumbnails).
  - **Chapitre 2** : Page Viewer 3D (Raymarching, shaders fragment, calcul d'intersection, histogrammes, mesures).
  - **Chapitre 3** : Page Tracking (Dynamic lineage trees, nearest neighbors, tracking timeline).
  - **Chapitre 4** : Page Compare (iFrame synchronization, postMessage protocol, Channel Decomposition, Physical Scaling).
  - **Chapitre 5** : Page DeepZoom (Tiled rendering integration, Custom TileSource).
  - **Chapitre 6** : DataPreprocessor Python (Bricking progressive loading, Kabsch 3D registration).
  - **Chapitre 7** : Références bibliographiques.

## [OPTIMIZED]
- **Robustesse du code LaTeX :** Automatisation du traitement des caractères spéciaux (tels que les underscores `_` hors mode mathématique) et mise en conformité de la coloration listings avec le compilateur PlmLaTeX (utilisation de `language=Java` en repli pour le code JavaScript et suppression de `language=bash`).
