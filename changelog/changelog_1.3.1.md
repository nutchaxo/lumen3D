# Plateforme Web — v1.3.1

> **Download Center du viewer recentré sur l'explorateur de fichiers.** Le Download Center du **viewer** n'affiche plus que l'explorateur du dossier `download/` du dataset (redessiné dans un style moderne) plus un bouton **Mesures CSV** propre ; la section « Generated exports » et les catégories statiques `DownloadManifest` (catalogue, métadonnées, vignette…) en sont retirées. Le rendu est désormais **scope-aware** : les pages **Tracking** et **Compare** conservent leur modal d'export (figures, graphe, espace de travail, exports personnalisés) — la simplification du viewer ne les régresse pas.

## [OPTIMIZED]
- **Explorateur de fichiers redessiné** ([js/core/export-manager.js](../js/core/export-manager.js), [css/tools.css](../css/tools.css)) — lignes **fines** (40 px) à une seule ligne au lieu de la grille épaisse `.download-item`, nom tronqué en ellipse, badge d'extension en pilule mono, panneau encadré + barre de fil d'Ariane, icône de téléchargement révélée au survol. **Vraie icône Lucide par type de fichier, colorée par catégorie** : image (`file-image`, cyan), tableur (`file-spreadsheet`, vert), archive (`file-archive`, orange), volume `.ims`/NRRD (`box`, violet), données `.json` (`file-json`, ambre), modèle 3D `.glb` (`shapes`, rose), document (`file-text`, gris). Les 19 icônes employées sont validées présentes dans Lucide 0.344.
- **Rendu scope-aware du Download Center** — `_renderDownloads` route selon `ctx.scope` : `viewer`/`explorer` → explorateur de fichiers ; `tracking`/`compare` → boutons d'export (figures/graphe/espace de travail + exports personnalisés via `getCustomExports`). Évite que le retrait de la section « Generated exports » côté viewer ne casse les Download Centers de Tracking (mesures + graphe) et Compare (figure composite).

## [FIXED]
- **Mesures CSV conservées au propre** — bouton « Measurements CSV » discret dans l'entête de la section, affiché uniquement quand des mesures existent (viewer). Sur Tracking, les mesures restent exportées via les exports personnalisés de la page.
- **Code mort retiré** — `_itemHtml`, `_categoryHtml` (rendu des catégories `DownloadManifest`) et l'ancienne carte d'icônes supprimés de `export-manager.js`. `DownloadManifest` n'est plus consommé par le modal.

## [TESTS]
- `tests/js/test_export_manager_scope.mjs` (nouveau) — garde la régression de modal partagé : `tracking`/`compare` surfacent bien leurs exports personnalisés (mesures tracking, figure compare) ; `viewer` montre l'explorateur et pas les boutons d'export.
- `tests/js/test_export_manager_explorer.mjs` (mis à jour) — mapping d'icônes (`csv`→`file-spreadsheet`, `png`→`file-image`) + nouvelle fonction `_catForExt` (catégorie de couleur).
- `tests/js/test_export_manager.mjs` (supprimé) — testait `_itemHtml`, retiré ; la couverture XSS est assurée par les lignes de l'explorateur.
- Non-régression : suite JS complète verte.

[Versioning] Plateforme Web → v1.3.1. changelog_1.3.1.md généré.
