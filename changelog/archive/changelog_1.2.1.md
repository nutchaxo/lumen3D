# Plateforme Web — v1.2.1

> **Retrait des plugins « Save workspace » et « Restore workspace ».** Les deux boutons dédiés de la barre d'outils du viewer (`js/modules/tools/save-workspace`, `js/modules/tools/restore-workspace`) sont supprimés. La logique de persistance d'état (`ExportManager.saveWorkspace` / `restoreWorkspace`) reste intacte et continue d'être exposée via le **Download Center** (boutons « Save state » / « Restore state ») ainsi que par les pages **Tracking** et **Compare**, qui ont leurs propres contrôles indépendants des plugins retirés.

## [FIXED]
- **Suppression des plugins `save-workspace` et `restore-workspace`** — dossiers `js/modules/tools/{save-workspace,restore-workspace}/` (plugin.json + index.js + `lang/`) retirés. Références de découverte nettoyées : entrées ôtées du manifeste statique [js/modules/manifest.json](../js/modules/manifest.json) et de la liste de repli embarquée `_DEFAULT_MODULE_PATHS` dans [js/core/plugin-registry.js](../js/core/plugin-registry.js) (plancher anti-crash, Rule 1.1). Commentaire d'ancrage de la barre d'outils `export` mis à jour dans [viewer.html](../viewer.html).

## [TESTS]
- `tests/js/test_plugin_autonomy.mjs` — compteurs ajustés à l'ensemble de plugins final (consolidé avec le retrait `deepzoom-2d` / `natural-fluorescence`) : défaut embarqué **15** chemins, `tools` **11**, `shaders` **2**, cluster `export` **2** boutons, ordre attendu `['download-center', 'screenshot']`. `tests/test_dev_server_plugins.py` : plancher 19 → **15**, `natural-fluorescence` retiré des plugins requis.
- Non-régression : suite complète verte (47 tests JS + 11 tests Python).

[Versioning] Plateforme Web → v1.2.1. changelog_1.2.1.md généré.
