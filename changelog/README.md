# Changelogs — Plateforme Web

Convention de versionnage : **la version de la plateforme = le `changelog_X.Y.Z.md` le plus
récent de CE niveau (plat)**. C'est la source de vérité lue par `dev_server.py`
(`_max_version`), `api/admin.php` (`admin_max_version`) et `tools/check_version.py`.
Un bump de version = ajouter un nouveau fichier ici — jamais de constante à éditer.

## Organisation

- **Niveau plat** : les deux lignes mineures les plus récentes (lisibilité).
- **`archive/`** : tout l'historique antérieur, même format de nommage.
  Le calcul de version ignore `archive/` (glob non-récursif) — n'y déplacer une
  ligne mineure que lorsqu'une plus récente la remplace au niveau plat.

## Format d'un changelog

Sections `[ADDED]` (fonctionnalités/outils), `[OPTIMIZED]` (perf, shaders, parsing),
`[FIXED]` (bugs). Voir `archive/changelog_0.12.45.md` pour la forme canonique.

## Lien avec les releases GitHub

Un tag `vX.Y.Z` doit toujours égaler la version max de ce dossier — vérifié en CI
par `tools/check_version.py --tag` avant toute publication. Les notes de release
sont le contenu du changelog correspondant.
