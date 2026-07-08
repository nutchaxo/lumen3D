# Plateforme Web v0.4.10

**Date :** 01 Juin 2026

### [ADDED]
- **Synchronisation d'URL (Workspace State) :** L'état complet de l'espace de travail est maintenant sérialisé, compressé (via `CompressionStream` natif) et encodé en base64URL dans le hash de l'URL (`#state=...`).
  - Fonctionne pour le `Viewer` classique (caméra, colorimétrie, mesures, grilles, axes).
  - Fonctionne pour le mode `Compare` (layout complet, datasets de chaque panneau, et l'état individuel de chaque vue synchronisé via `postMessage`).
- L'URL se met à jour en temps réel (débouncé à 1 seconde) sans rafraîchir la page ni polluer l'historique de navigation (`replaceState`).
- Partage simple d'un lien pour recréer à l'identique une disposition (coupes, couleurs, layout multi-vues).

### [OPTIMIZED]
- **Restauration asynchrone sécurisée :** Dans la vue *Compare*, les états des sous-vues iframes sont injectés de manière asynchrone via message dès que le viewer enfant est prêt pour éviter toute erreur de chargement.
