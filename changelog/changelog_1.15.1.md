# Plateforme Web — v1.15.1

> **Le widget « Derniers éléments » n'affichait rien.** Corrigé : il appelait une méthode du
> catalogue qui n'existe pas, donc la liste restait vide. Il liste désormais bien les jeux de
> données (les plus récents d'abord), avec un message clair quand il n'y en a aucun.

## [FIXED]
- **Widget « Derniers éléments » (`latest-datasets`) vide** ([js/core/page-renderer.js](../js/core/page-renderer.js)) — le rendu appelait `Catalog.list()`, une méthode **inexistante** (l'API du catalogue expose `getAll()`). La garde `if (Catalog.list)` était donc toujours fausse → la liste restait vide → le widget rendait une grille sans aucune carte (il n'a jamais fonctionné depuis son introduction). Correctif : utiliser `Catalog.getAll()`, trié par date décroissante (les plus récents d'abord, comme la section « en vedette » de la page d'accueil), puis limité au nombre demandé. Ajout d'un **état vide** localisé (« Aucun jeu de données à afficher pour le moment. ») quand le catalogue ne contient encore aucun élément, pour que le widget ne paraisse plus cassé. Nouvelle clé i18n `pages.noDatasetsYet` (en/fr/es). **Vérifié : éditeur (3 cartes pour count 3, colonnes respectées) + page publiée (4 cartes) + état vide en français ; 0 erreur console.**

[Versioning] Plateforme Web → v1.15.1. changelog_1.15.1.md généré.
