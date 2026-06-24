# Plateforme Web — v1.3.2

> **Plus d'erreurs console au chargement d'un modèle avec espace de travail sauvé.** Lorsqu'un dataset était ouvert avec un état d'espace de travail à restaurer (lien `#state=` ou état préchargé), deux plugins lançaient une `TypeError` parce que leur `setState`/`applyState` était appelé **avant** que `PluginRegistry.initAll()` ne leur fournisse leur `ViewerContext` (`this._ctx` encore `null`). La restauration de l'état des plugins est désormais différée jusqu'après l'initialisation des modules — la caméra et les états plugins se restaurent proprement, sans rien casser.

## [FIXED]
- **Restauration de l'état des plugins après `initAll()`** ([js/pages/viewer.js](../js/pages/viewer.js)) — `_applyWorkspaceStateNow()` s'exécute pendant `init()` **avant** `PluginRegistry.initAll()`. Il bufferise maintenant la portion `state.plugins` dans `_pendingPluginState` quand le viewer n'est pas encore initialisé, puis la vide juste après `initAll()`/`bindToolbarButtons()`. Au runtime (`_isInitialized`), la restauration reste immédiate. Supprime les deux erreurs :
  - `setState failed for "measure-distance": Cannot read properties of null (reading 'measurements')`
  - `setState failed for "zstack-browser": Cannot read properties of null (reading '_state')`
- **Garde-fou côté registre** ([js/core/plugin-registry.js](../js/core/plugin-registry.js)) — `setWorkspaceState()` ignore désormais un module encore à l'état `registered` (son `index.js` a appelé `implement()` mais `init(ctx)` n'a pas tourné → contexte `null`). Défense en profondeur : un plugin non initialisé ne reçoit jamais `setState`.

## [TESTS]
- `tests/js/test_plugin_workspace_preinit.mjs` (nouveau) — vérifie que `setWorkspaceState()` n'appelle pas `setState` sur un module `registered` (aucun crash pré-init) et le délivre correctement une fois `initAll()` passé.
- Non-régression : suite plugins (`test_plugin_autonomy`, `test_channel_plugin_preinit`, `test_plugin_lang`, `test_i18n_plugins`, `test_plugin_review_fixes`) verte.

[Versioning] Plateforme Web → v1.3.2. changelog_1.3.2.md généré.
