# Plateforme Web v0.5.0 — 2026-06-01

## [ADDED] Curseur filtre gaussien visible en permanence
- Le curseur **Filtre gaussien σ** est désormais affiché directement sous le résumé 
  de chaque canal, **sans avoir besoin de déployer** la section avancée.
- Le slider est renommé de "Denoise σ" → "Filtre gaussien σ" pour être cohérent 
  avec l'interface du DataPreprocessor.
- La valeur par défaut est chargée depuis `display_defaults.denoise_sigma` du 
  `metadata.json` (défini lors du preprocessing).

## [OPTIMIZED] Application du filtre gaussien au relâchement
- Le filtre gaussien n'est plus appliqué à chaque micro-mouvement du slider 
  (événement `input`), mais uniquement au **relâchement** (événement `change`).
- Pendant le glissement, seule l'étiquette de la valeur σ est mise à jour en temps 
  réel (retour visuel immédiat sans reconstruction coûteuse de la texture).
