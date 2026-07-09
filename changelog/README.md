# Changelogs — Plateforme Web

Convention de versionnage : **la version de la plateforme = le `changelog_X.Y.Z.md` le plus
récent de CE niveau (plat)**. C'est la source de vérité lue par `dev_server.py`
(`_max_version`), `api/admin.php` (`admin_max_version`) et `tools/check_version.py`.
Un bump de version = ajouter un nouveau fichier ici — jamais de constante à éditer.

## Organisation

- **Niveau plat** : les lignes mineures récentes (à ce jour, depuis `1.3.0`).
  Seules les versions `≤ 1.2.x` (et toute la série `0.x`) sont archivées.
- **`archive/`** : tout l'historique antérieur, même format de nommage.
  Le calcul de version ignore `archive/` (glob non-récursif) — n'y déplacer une
  ligne mineure que lorsqu'elle est bien remplacée au niveau plat.

## Format d'un changelog

Sections `[ADDED]` (fonctionnalités/outils), `[OPTIMIZED]` (perf, shaders, parsing),
`[FIXED]` (bugs). Voir `archive/changelog_0.12.45.md` pour la forme canonique.

## Lien avec les releases GitHub

Un tag `vX.Y.Z` doit toujours égaler la version max de ce dossier — vérifié en CI
par `tools/check_version.py --tag` avant toute publication. Les notes de release
sont le contenu du changelog correspondant.
