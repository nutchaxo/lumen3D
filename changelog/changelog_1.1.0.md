# Plateforme Web — v1.1.0

> Système de plugins **totalement autonome** : déposer un dossier dans `js/modules/<placement>/<id>/` suffit pour que la plateforme détecte le plugin et incorpore ses contrôles dans le viewer au rechargement ; le retirer les enlève proprement. Plus aucun manifeste codé en dur ni bouton de toolbar écrit à la main. Les placements `shaders` et `channels` étaient déjà metadata-driven ; ce lot amène le placement `tools` au même niveau et coupe les couplages nommés résiduels. Vérifié par tests structurels (Node vm) + tests serveur (aucune page navigateur — datasets absents en local).

## [ADDED]
- **Auto-découverte hybride des plugins** — `PluginRegistry.discover()` ([js/core/plugin-registry.js](../js/core/plugin-registry.js)) résout la liste des modules selon un ordre de repli robuste : (1) endpoint live `GET /api/plugins`, (2) manifeste statique généré `js/modules/manifest.json`, (3) liste cœur embarquée (plancher anti-crash, Rule 1.1). Un corps non-JSON (PHP servi en statique) ou un 404 déclenche le repli sans casser le boot.
- **Endpoint serveur `/api/plugins`** — `dev_server.py` scanne `js/modules/{tools,channels,shaders}/*/plugin.json`, valide chaque nom de dossier avec `_SAFE_FOLDER_RE` (pas de path-traversal, Rule 1.4) et **réécrit `js/modules/manifest.json`** à chaque appel, gardant le repli statique à jour sans étape manuelle. Alias `/api/plugins.php`.
- **Miroir PHP** — `api/plugins.php` reproduit l'endpoint pour les hôtes legacy (même scan, même validation de noms).
- **Générateur autonome** — `tools/gen_plugins_manifest.py` produit `js/modules/manifest.json` en standalone (déploiement statique sans avoir lancé `dev_server.py`).
- **Génération dynamique de la toolbar** — `PluginRegistry.buildToolbarButtons()` crée les boutons d'outils depuis `plugin.json` (cluster via `group`, position via `order`, `action`/`toggle` → `data-plugin-id`, `tool` → chip `data-tool`, plus `icon`/`i18nTitle`/`i18nAria`/`buttonId`). Idempotent (re-build sans doublon, OK pour les N iframes de la page compare). Visibilité déclarative : `requires:["deepzoom2d"]` masque le bouton tant que le dataset n'offre pas la source.
- **Métadonnées `plugin.json` (tools)** — nouveaux champs optionnels `buttonId`, `i18nTitle`, `i18nAria`, `tool`, `shortcut`, `requires` (tous avec repli — les plugins existants restent valides).

## [OPTIMIZED]
- **Placement `tools` aligné sur `shaders`/`channels`** — la toolbar est désormais pilotée par le contenu de `js/modules/tools/`, comme le `<select>` de render-mode et les contrôles par-canal l'étaient déjà. Suppression du manifeste de 18 entrées codé en dur dans `viewer.js` et des boutons statiques de `viewer.html` (clusters conservés comme cibles d'injection `data-tool-group`, seul l'outil cœur `navigate` reste statique).
- **Raccourcis clavier d'outils data-driven** — `js/core/tool-manager.js` : `ToolManager.registerTool()` + table de raccourcis construite depuis les plugins `subtype:"tool"`. Ajouter/retirer un outil ajoute/retire son raccourci sans édition du gestionnaire.

## [FIXED]
- **Couplages nommés coupés (sûreté au retrait)** — les trois boutons « Layouts » (`deepzoom-2d`, `decompose-channels`, `zstack-browser`), auparavant câblés à la main par id, passent par le chemin générique `data-plugin-id` → `activate()`. Suppression des auto-bindings concurrents dans leurs `index.js` et dans `DecompositionPanel` (nouvelle méthode publique `DecompositionPanel.toggle()`), éliminant le risque de double-déclenchement et la dépendance au timing DOMContentLoaded.
- **Raccourci `c` réparé** — il pointait vers un outil `cut` sans chip correspondant (mort) ; il active désormais l'outil `slice` (déclaré par `slice-inspector`).
- **`tips.orientationAxes` manquant** — clé i18n absente des trois langues (`en`/`fr`/`es`) alors que le bouton la référençait ; ajoutée, le tooltip n'affiche plus la clé brute.

## [TESTS]
- `tests/js/test_plugin_autonomy.mjs` (nouveau) — harnais Node vm : repli hybride de `discover()` (endpoint → manifeste → défaut embarqué, rejet du non-JSON), `loadModules` enregistre les 14 outils + 2 shaders + 2 channels, et `buildToolbarButtons` génère les bons boutons (cluster, ordre, `data-plugin-id` vs `data-tool`, visibilité `requires`, idempotence).
- `tests/test_dev_server_plugins.py` (nouveau) — `_list_plugins` sur l'arbre réel (18 plugins) et sur un arbre temporaire : ajout/retrait de dossier, `plugin.json` malformé ignoré, mismatch de placement rejeté, nom de dossier non sûr ignoré, forme du manifeste écrit.
- Non-régression : suite complète verte (28 tests JS, 8 tests Python) après le lot.
