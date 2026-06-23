# Plateforme Web — v1.2.5

> **Restauration d'espace de travail jouée avant l'init des plugins.** Au chargement d'une URL `#state=…`, l'état sauvegardé était ré-appliqué AVANT `PluginRegistry.initAll()` — donc `setState()`/`applyState()` des plugins étaient appelés sur des instances non initialisées (contexte `_ctx` null, champs `undefined`), levant des exceptions tracées et perdant silencieusement l'état du plugin. Corrigé en déplaçant la restauration sous `initAll()`.

## [FIXED]
- **Ordre init : restauration workspace/z-stack avant `initAll` (ELE-26)** ([js/pages/viewer.js](../js/pages/viewer.js)) : dans `init()`, le bloc de restauration (`#state` URL, `_pendingWorkspaceState`, `_pendingZstackState`) s'exécutait à un point situé **au-dessus** de la construction du `moduleCtx` + `PluginRegistry.initAll(moduleCtx)`. Les plugins n'ayant pas encore reçu leur contexte, leurs `setState`/`applyState` plantaient :
  - `[chunk-debug] enable failed: Cannot read properties of undefined (reading 'copy')` — `this._v` (THREE.Vector3 alloué dans `init`) absent.
  - `[PluginRegistry] setState failed for "measure-distance": Cannot read properties of null (reading 'measurements')` — `this._ctx` null.
  - `[PluginRegistry] setState failed for "zstack-browser": Cannot read properties of null (reading '_state')` — `this._ctx` null.
  Le bloc de restauration est désormais exécuté **après** `initAll()`/`bindToolbarButtons()`, donc sur des plugins pleinement initialisés (et après le chargement du volume, déjà awaité plus haut). L'état des plugins (chunk-debug actif, mesures, z-stack) est restauré correctement au lieu d'être perdu. Aucune autre logique modifiée (la caméra/les canaux étaient déjà restaurés sans `_isInitialized`, comportement inchangé).

## [TESTS]
- Non-régression : suite JS complète verte (**46 tests JS**). `viewer.js` n'est pas chargeable en headless (Three.js/DOM) — vérification syntaxique + revue de l'ordre d'exécution.

[Versioning] Plateforme Web → v1.2.5. changelog_1.2.5.md généré.
