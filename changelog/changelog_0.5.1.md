# Plateforme Web v0.5.1 — 2026-06-01

## [FIXED] Filtre gaussien fait disparaître le modèle 3D
- **Bug** : Changer le sigma du filtre gaussien déclenchait un `loadVolume()` complet 
  (rechargement de toutes les slices + création d'une nouvelle texture 3D). Pendant le 
  chargement (~15-60s), l'ancienne texture était détruite → écran noir.
- **Correction** : Le blur gaussien est désormais appliqué **in-place** sur le buffer 
  RGBA de la texture existante. Seules les slices du canal modifié sont rechargées, le 
  blur est appliqué, puis `texture.needsUpdate = true` met à jour le GPU sans détruire 
  la texture → **pas de clignotement**.
- Le modèle 3D reste visible pendant toute la durée du calcul.

## [FIXED] Labels Min/Max affichent une échelle 0-100 au lieu de 0-255
- **Bug** : Les labels "Min X" et "Max Y" sous l'histogramme multipliaient la valeur 
  normalisée [0,1] par 100 (→ "Min 5, Max 100"). Or les données stockées sont en 
  uint8 [0-255].
- **Correction** : Multiplication par 255 au lieu de 100. Affichage correct : 
  "Min 13, Max 220" etc.
- Les handles restent positionnés en pourcentage du conteneur (inchangé, correct).

## [OPTIMIZED] Application du filtre gaussien au relâchement
- Le filtre gaussien ne s'applique plus à chaque pixel de mouvement du slider, 
  mais uniquement au relâchement du curseur (événement `change` au lieu de `input`).
