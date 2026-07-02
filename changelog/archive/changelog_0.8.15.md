# Plateforme Web v0.8.15 — 2026-06-08

## [OPTIMIZED] Rendu Multicanal & Élimination du Lag
- **Gating des Samplers par Uniforms d'Activation** : Les appels à `texture(mapX, uvw)` dans la boucle de raymarching (512 étapes) du fragment shader ont été placés derrière des conditions combinant le nombre de canaux et leur statut d'activation (`en0 == 1`, `en1 == 1`, etc.).
- **Gain de Performance Majeur** : Les canaux désactivés dans l'interface utilisateur ne sollicitent plus d'opérations de texture 3D WebGL au niveau du GPU, garantissant une fluidité maximale (60 FPS constants) y compris en résolutions élevées (1024x1024 et Native) lorsque certains canaux sont coupés.

## [FIXED] Résolution de la Disparition des Canaux (Regional WebGL Fallback)
- **Fallback d'Upload Régional** : Correction d'une anomalie où le chargeur de briques (`_updateGPUTextureRegion`) annulait silencieusement l'envoi de tranches de pixels si Three.js n'avait pas encore alloué l'identifiant de texture WebGL (`__webglTexture`) sur le GPU (ce qui se produit fréquemment lors d'une transition asynchrone avant le premier rendu du nouveau volume).
- **Initialisation Forcée** : En l'absence de structure GPU allouée, la texture est marquée avec `needsUpdate = true` et un rendu de trame est programmé. Le GPU charge alors la texture au complet sur le cycle suivant, créant l'identifiant et permettant aux mises à jour partielles successives via `texSubImage3D` de s'exécuter normalement.
