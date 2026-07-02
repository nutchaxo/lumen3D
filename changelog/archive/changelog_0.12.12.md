# Changelog 0.12.12 (Plateforme Web)

## [OPTIMIZED]
- **Réutilisation globale du OffscreenCanvas :** Dans `brick-decode-worker.js`, le canvas hors-écran et son contexte 2D sont désormais déclarés de manière globale au niveau du Worker. Ils sont réutilisés à chaque brique décodée et redimensionnés uniquement si nécessaire, éliminant les allocations massives et le garbage collection intempestif.
- **Libération immédiate du GPU (VRAM) :** Appel systématique de `bmp.close()` sur l'instance d'ImageBitmap décodée dans le worker dès que l'image est copiée. Cela évite l'accumulation d'images en mémoire GPU et résout les chutes de performances / VRAM pressure.
- **Télémétrie & Visibilité des Logs :** Réinitialisation systématique du compteur global de logs `window._loggedWriteBrick = 0` à chaque chargement de niveau de qualité. Auparavant, les logs de chargement étaient épuisés par la prévisualisation (50 briques max) et le chargement de la résolution principale s'effectuait en silence.

## [ADDED]
- **Mesure de performance du Worker de décodage :** Transmission des métriques de temps de décodage (parsing WebP, copie GPU) du Worker Pool vers le thread principal. Les temps détaillés de décodage sont désormais affichés dans la console aux côtés du temps d'écriture WebGL sous le tag `[PERF-LOAD]`.
