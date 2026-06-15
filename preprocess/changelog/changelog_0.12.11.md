# Changelog v0.12.11

## Plateforme Web

### [FIXED]
- **Télémétrie Invisible / Caching Agressif** : Le Web Worker était sournoisement coincé sur une ancienne version codée en dur (`v129`) dans `brick-loader.js`. Cela explique pourquoi aucune amélioration n'était visible et que les logs de télémétrie étaient manquants : le navigateur réutilisait en boucle l'ancien Worker caché dans son cache local ! Le worker a maintenant un `cache-buster` dynamique (`Date.now()`) garantissant qu'il exécute toujours le code le plus récent.
- La limite du nombre de Worker Pool à un maximum de 4 coeurs s'applique désormais réellement.
