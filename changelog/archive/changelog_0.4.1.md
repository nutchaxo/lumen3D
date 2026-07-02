# Changelog v0.4.1

## [ADDED]
- **Compare Studio** : Support global et unifié du canevas pour le mode Compare, avec menus flottants indépendants par image.
- **Outil de Décomposition** : Bouton pour séparer automatiquement les canaux d'un dataset sur plusieurs iframes.
- **Echelles et Mesures Multi-Scales** : Les annotations du Studio s'adaptent à la résolution locale de l'image sur laquelle elles sont dessinées via layoutMaps.

## [OPTIMIZED]
- Architecture par postMessage pour isoler les threads des iframes tout en garantissant un export global efficace.

## [FIXED]
- Fermeture automatique du panneau latéral de configuration d'une vue Compare lorsqu'on clique à l'extérieur.
