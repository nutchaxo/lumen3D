# Changelogs — Plateforme Web

Convention de versionnage : **la version de la plateforme = le `changelog_X.Y.Z.md` le plus
récent du niveau plat de ce dossier**. C'est la source de vérité lue par `dev_server.py`
(`_max_version`), `api/_admin_lib.php` (`admin_max_version`), `tools/check_version.py` et
`tools/build_pipeline_bundle.py` (version de référence du pack de traitement). Un bump de version
= ajouter un nouveau fichier ici — jamais de constante à éditer.

## Organisation

- **Niveau plat** : les lignes mineures récentes. À ce jour, il contient les fichiers de `1.3.0`
  à `1.65.0`.
- **`archive/`** : l'historique antérieur (`0.x` à `1.2.6`), même format de nommage. Le calcul de
  version l'ignore : le glob est non récursif (serveurs, `build_release.py`) et
  `check_version.py` ne parcourt que le niveau plat. N'y déplacer une ligne mineure que lorsqu'elle
  est remplacée au niveau plat.
- **`README.md`** : ignoré par le calcul de version (le nom doit commencer par `changelog_`).

Règles appliquées par `tools/check_version.py` sur le niveau plat : un nom `changelog_*` qui ne se lit
pas en `X.Y.Z` est une erreur ; deux fichiers pour la même version (même numérotation après
suppression des zéros) sont une erreur ; un fichier vide est une erreur. En CI, `ci.yml` lance
`check_version.py --no-tag` et `release.yml` lance `check_version.py --tag <tag>`.

## Format d'un changelog

Titre : `# Changelog vX.Y.Z (Plateforme Web)`, puis des sections `## [TAG]`.

Sections du format courant : `[ADDED]` (fonctionnalités, outils), `[OPTIMIZED]` (perf, shaders,
parsing), `[FIXED]` (bugs), `[CHANGED]` (comportement modifié). Les anciens fichiers (`1.3.x` à
`1.54.0`) utilisent aussi `[NOTE]`, `[REMOVED]`, `[TESTS]` et `[VERIFIED]` ; les nouveaux n'en ont pas
besoin. Forme canonique : `changelog_1.55.0.md` et `changelog_1.65.0.md` (`archive/changelog_0.12.45.md`
pour l'ancien format).

**Une entrée par puce**, au format `- **Titre court**: ce qui change et pourquoi`. Le titre doit tenir
seul : l'onglet « Mises à jour » de l'admin affiche le gras initial comme titre replié. Sans gras, le
titre est le texte avant le premier `: `, sinon la première phrase (`splitEntryTitle` dans
`js/pages/admin/markdown.js`).

**Langue** : les fichiers à partir de `1.55.0` sont en **anglais** ; les fichiers antérieurs restent
en français.

## Lien avec les releases GitHub

- Un tag `vX.Y.Z` doit égaler la version max du niveau plat : `release.yml` le vérifie avec
  `tools/check_version.py --tag` avant toute publication.
- Chaque release embarque `lumen3d-release-notes.json` : **tous** les changelogs du niveau plat, du
  plus récent au plus ancien (`tools/build_release.py:build_release_notes`). Un hôte qui se met à
  jour de plusieurs versions lit ainsi les notes de chaque version absorbée. Le fichier figure dans
  `SHA256SUMS`, donc dans la signature de la release.
