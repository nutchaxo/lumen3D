# Plateforme Web v0.8.16 — 2026-06-08

## [FIXED] Résolution Définitive de la Disparition du Canal 2 (Pecam1647)
- **Allocation Mémoire GPU Explicite** : Modification de `loadBrickedVolumeStream` pour forcer l'allocation immédiate de la mémoire texture 3D via `gl.texImage3D` avec un buffer initialisé à `null` dès la création de chaque texture de canal.
- **Bénéfice** : Évite les échecs silencieux et erreurs WebGL `INVALID_OPERATION` lors des appels progressifs de `gl.texSubImage3D` exécutés par le chargement de briques asynchrones en arrière-plan, garantissant que le Canal 2 s'affiche correctement dans toutes les résolutions (512x512, 1024x1024, Native).

## [OPTIMIZED] Recompilation Dynamique du Shader & Élimination du Lag
- **Dynamic Shader Recompilation** : Implémentation d'un système de recompilation à la demande basé sur Three.js `defines` (`ENABLE_CHANNEL_X`).
- **Gating Statique du Raymarching** : Les samplers et calculs de transfert des canaux désactivés sont totalement ignorés par le compilateur GPU lors de la marche des rayons (512 étapes max), ce qui élimine l'aplatissement (flattening) des branches par le compilateur.
- **Bénéfice** : Fluidité restaurée à 60 FPS constants durant l'interaction et la rotation du volume 3D lorsque des canaux sont désactivés.
- **Propagation aux Projections** : Les `defines` sont également transmis dynamiquement au shader de projection de `VolumeGrid`.
