# Changelog 0.3.5

## [OPTIMIZED]
- Refonte complète du moteur de preprocessing pour supporter les chunks 3D 32x32x32 natifs
- Utilisation de aw-u8-gzip\ compressé pour éviter le traitement CPU WebP sur le navigateur
- Mise en cache ultra-rapide via traitement RAM, conversion en 8-bit et filtrage background 3σ
- Downscaling bilinéaire des axes X/Y via \PIL.Image\ avec maintien de la profondeur Z
- Changement du pool vers \ThreadPoolExecutor\ pour réduire drastiquement l'overhead du multiprocessing sous Windows
- Contournement de l'engorgement SMB en exécutant les threads directement sans duplication de contexte.

## [FIXED]
- Correction d'un bug de parsing des attributs \HDF5\ (\info.attrs\) qui transformait des byte-arrays en dimensions x1xZ\ au lieu de reconstruire la string originale.
