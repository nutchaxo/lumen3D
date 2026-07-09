# Plateforme Web — v1.13.5

> **Correctif crash au boot du viewer (`_hostCtx` null dans le sandbox).** Depuis que le bundling (v1.13.4)
> permet enfin au viewer de charger sur les hôtes rate-limités, un bug d'ordonnancement latent se déclenchait :
> un composant émet `channels-updated` **avant** que `PluginSandbox.bindContext` n'ait installé le contexte
> hôte → `_projectChannels` lisait `_hostCtx.channels` avec `_hostCtx` à `null` → **le boot plantait à
> mi-chemin**, laissant le viewer à moitié initialisé (plugins absents, outils sans effet, slicer inerte,
> couleurs de canaux à retoggler).

## [FIXED]
- **Crash `Cannot read properties of null (reading 'channels')` au démarrage du viewer** ([js/core/plugin-sandbox.js](../js/core/plugin-sandbox.js)) — `PluginSandbox.emit('channels-updated')` (viewer.js:300, dans le handler de changement de canal) peut s'exécuter pendant le boot **avant** `bindContext` (viewer.js:416). Sans garde, `_projectChannels`/`_projectInfo` déréférençaient `_hostCtx` (`null`) → exception non rattrapée qui **avortait tout le boot** ; d'où : le plugin installé (chunk-debug) n'apparaissait pas, aucun outil hors catégorie Tools ne répondait, l'outil « Slice through volume » affichait son panneau mais restait inerte (pas de preview, plan figé, « Open in Studio » KO), et les canaux ne prenaient leur couleur qu'après masquage/réaffichage. Correctif : `emit` sort tôt s'il n'y a pas de contexte hôte lié ou aucun plugin sandboxé à l'écoute (`!_hostCtx || _hosts.size === 0`), et `_projectChannels`/`_projectInfo` gardent `_hostCtx &&` (défensif, pour l'appel RPC `channels.getState`). Le boot va désormais jusqu'à `bindContext` et **toute l'initialisation (barre d'outils, plugins, slicer, couleurs) s'exécute**.

[Versioning] Plateforme Web → v1.13.5. changelog_1.13.5.md généré.
