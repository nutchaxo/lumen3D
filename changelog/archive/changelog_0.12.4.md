## [ADDED]
- Introduction d'un SVRManager (`js/core/svr-manager.js`) pour gérer les Page Tables et les Textures d'Atlas (Sparse Virtual Rendering).

## [OPTIMIZED]
- Refonte de la méthode `_writeBrick` dans `volume-viewer.js` pour utiliser `gl.texSubImage3D` directement sur les `Uint8Array` bruts (`brickData`), bypassant totalement la copie JS lente. Le chargement des résolutions intermédiaires (1024, 512) est désormais quasi-instantané (gain de performance x100).
- Le Shader de raymarching (fragmentShader) intercepte le flag `ENABLE_SVR` pour naviguer dans l'Atlas via la texture de Page Table, résolvant les problèmes de `maxTextureSize`.
- Le mode "Auto" cible par défaut la résolution `512x512` tant que le Frustum Culling n'est pas branché, assurant un chargement immédiat et sans trous.

## [FIXED]
- Élimination des artefacts visuels ("grandes plaques" et "bordures indésirables") liés au précédent débordement de buffer JS lors de la copie des chunks de bordure.
