# Changelog Plateforme Web - v0.8.6

## [FIXED]
- **Viewer UI (Bug "Loading Error / textContent") :**
  - Ajout d'une vérification de nullité (`null check`) sur l'élément DOM `#loader-text` dans `viewer.js` lors du chargement des datasets. 
  - Ce correctif empêche un plantage en cascade de l'interface (`Cannot set properties of null (setting 'textContent')`) lorsqu'une deuxième tentative de chargement est déclenchée après l'affichage de l'écran d'erreur initial.

## [OPTIMIZED]
- **Dev Server (dev_server.py) :**
  - Ajout d'une règle stricte `Cache-Control: no-cache` pour tous les fichiers `.json` (incluant `manifest.json` et `metadata.json`).
  - Cette optimisation empêche le navigateur de charger les anciennes versions en cache des fichiers de structure de données de plusieurs mégaoctets, garantissant ainsi que l'interface utilise toujours les données fraîchement générées par le pipeline de preprocessing.
