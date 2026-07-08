# Changelog - Plateforme Web

## v0.12.3

### [ADDED]
- **Empty Space Skipping (WebGL) :** Ajout de la génération et de l'injection d'une `occupancyMap` dans les shaders de rendu volumétrique. Permet au raymarching de traverser les zones vides (noires) du volume beaucoup plus rapidement, avec un impact drastique sur les FPS pour les hautes résolutions (1024x1024 et plus).
- **Mode Auto Dynamique (Style Imaris) :** Implémentation du mode "Auto" de chargement de briques. Ce mode surveille l'occupation à l'écran du volume 3D (`VolumeViewer.computeScreenPixelSize`) et déclenche automatiquement des rechargements partiels en tâche de fond (`_scheduleBackgroundQuality`) vers des résolutions plus fines (`512x512`, `1024x1024` ou `native`) lorsque l'utilisateur zoome sur le spécimen.
