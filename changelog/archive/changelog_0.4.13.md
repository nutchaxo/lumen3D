# Plateforme Web v0.4.13

**Date :** 01 Juin 2026

### [FIXED]
- **Bug de la vue 3D en mode Mesure persistant :** Forçage du rafraîchissement du cache du navigateur (cache buster). La correction précédente (v0.4.12) n'était pas appliquée par le navigateur car le fichier JavaScript restait en cache. Le comportement est maintenant définitivement corrigé.
- **Perte des datasets au rechargement de la page :** Résolution d'un défaut de communication entre la fenêtre `compare` et ses iframes `viewer`. L'application `compare` attendait une confirmation d'état des visionneuses individuelles, mais la fonction de partage d'état n'était pas exposée. La synchronisation via l'URL est désormais complète et fiable au rechargement.
