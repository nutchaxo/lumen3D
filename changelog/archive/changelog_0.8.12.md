# Plateforme Web v0.8.12 — 2026-06-08

## [ADDED] Chargement de Volume en Arrière-plan (Background Loading)
- **Fluidité de Transition** : Lorsqu'un modèle 3D est déjà chargé, le basculement vers une résolution supérieure (comme la résolution *Native*) s'exécute entièrement en arrière-plan dans la mémoire CPU. Les nouvelles textures ne sont activées et envoyées au GPU WebGL qu'une fois le chargement 100% complété.

## [OPTIMIZED] Fluidité UI & Optimisation Réseau
- **Zéro Interruption (60 FPS)** : L'interaction utilisateur (rotation, translation) reste fluide et réactive pendant le chargement progressif des briques de haute résolution.
- **Synchronisation du Worker** : Ajout d'une attente d'initialisation asynchrone du Web Worker garantissant le déport de toutes les opérations de fetch et de décompression Gzip en dehors du thread principal.

## [FIXED] Résolution des Erreurs Réseau (Zero-404)
- **Bypass des Chunks Vides** : Les requêtes vers les briques absentes de l'index du manifest (faisant partie du background filtré) retournent directement un buffer rempli de zéros sans émettre de requêtes HTTP erronées, éliminant les erreurs 404 dans les logs réseau.
