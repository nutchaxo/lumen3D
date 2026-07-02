## [OPTIMIZED]
- **Suppression du Bottleneck CPU (LUT) :** Le script `volume-viewer.js` appliquait une modification de seuil (LUT / Floor) brique par brique sur le *Main Thread* avant l'envoi au GPU. Pour le LOD 1024, cela représentait plus de 2,1 milliards d'itérations CPU par chargement, causant un "stuttering" (micro-blocages) sévère pendant l'affichage progressif des chunks. Ce calcul redondant a été retiré puisque le *Fragment Shader* de WebGL s'en occupe déjà avec le paramètre `channelMins`.

## [FIXED]
- **Forçage du Cache Navigateur :** Les modifications du Web Worker n'avaient pas été prises en compte lors du dernier essai car le navigateur conservait l'ancienne version des fichiers Javascript. Les "Cache Busters" (`?v=...`) du `viewer.html` et de l'instanciation du Web Worker ont été incrémentés à `v127` pour garantir l'exécution du nouveau code asynchrone `webp-lossless`.
