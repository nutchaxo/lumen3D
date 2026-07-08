# Plateforme Web v0.8.14 — 2026-06-08

## [OPTIMIZED] Raymarching Invariant à l'Angle (Correction de l'éclat)
- **Taille d'étape constante** : Remplacement du calcul d'étape dynamique dépendant de l'angle par une taille d'étape de raymarching constante dans l'espace local (`float delta = 1.0 / float(steps)`).
- **Stabilité de la texture pendant la rotation** : Résout le problème de l'allègement ou de l'amincissement de la texture lors de la rotation de l'embryon, assurant que la densité et la luminosité du modèle restent rigoureusement identiques quel que soit l'angle de vue.
- **Optimisation de la boucle de rendu** : Adaptation du test de sortie de la boucle de marche des rayons (`float(i) * delta >= bounds.y - bounds.x`) pour économiser des cycles GPU en sortant immédiatement de la boîte.

## [FIXED] Transition de Résolution sans Couture (Seamless Quality Switches)
- **Seeding asynchrone par paquets** : L'opération d'interpolation/seeding de l'ancien volume vers le nouveau est maintenant exécutée de manière asynchrone par morceaux de 16 tranches Z à l'aide de `requestAnimationFrame`. Elle ne bloque plus le thread principal et maintient un affichage réactif à 60 FPS (zéro freeze CPU).
- **Affichage persistant lors du chargement** : L'ancien volume reste pleinement visible et interactif pendant que la nouvelle texture est initialisée en tâche de fond. Le visualiseur ne bascule sur la nouvelle texture qu'une fois celle-ci entièrement initialisée avec les données de départ (évitant tout écran noir intermédiaire).
- **Élimination des re-téléchargements GPU bloquants** : Les textures sont configurées avec `needsUpdate = false` dès leur création pour court-circuiter le téléversement intégral automatique de Three.js (800 Mo) qui échouait en raison d'erreurs d'alignement WebGL, privilégiant les mises à jour partielles à 100%.
