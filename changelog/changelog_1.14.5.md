# Plateforme Web — v1.14.5

> **Nettoyage de deux erreurs console qui faisaient croire à un bug de publication.** Le diagnostic sur
> un hébergement réel l'a montré : la **publication fonctionnait déjà** (la trace console atteignait bien
> la branche de succès de `publish()`), mais deux messages rouges sans rapport parasitaient l'affichage —
> une icône manquante dans la palette et un 404 sur la découverte des langues.

## [FIXED]
- **Icône « Bouton » introuvable dans la palette** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — le widget Bouton utilisait l'icône Lucide `square-mouse-pointer`, **absente** de la version Lucide 0.344 embarquée (Lucide l'a renommée depuis `mouse-pointer-square` → `square-mouse-pointer` dans une version ultérieure). D'où un avertissement répété *« icon name was not found »* et une icône vide. Remplacée par `mouse-pointer-click`, présente et stable dans la version embarquée.
- **404 sur `api/languages` (découverte des langues)** ([js/core/i18n.js](../js/core/i18n.js)) — l'ordre d'essai des points de terminaison commençait par `api/languages` (sans extension), qui n'existe que sur le serveur de dev Python ; sur un hôte Apache/PHP il renvoyait un **404** (bruyant en console) avant de retomber sur `api/languages.php`. Nouvel ordre : **`api/languages.php` d'abord** (fonctionne sur PHP **et** sur le serveur Python, qui route les deux), puis les replis. Vérifié sur l'hôte réel : `api/languages.php` → 200, plus de 404. Les traductions se chargeaient de toute façon (repli), c'était uniquement du bruit.

> **Rappel : la publication marche déjà** (save → publish → « Publié ✓ »). Ces correctifs ne font que
> supprimer les erreurs console trompeuses. Console propre après mise à jour.

[Versioning] Plateforme Web → v1.14.5. changelog_1.14.5.md généré.
