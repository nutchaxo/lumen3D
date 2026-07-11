# Plateforme Web — v1.14.3

> **L'éditeur affiche maintenant une page d'accueil FIDÈLE à la vraie landing.** Ouvrir Accueil (ou À
> propos) dans l'éditeur montrait un modèle générique (« Bienvenue » + derniers datasets) qui ne
> correspondait pas à la page réelle vue par les visiteurs. Ces pages intégrées ont un design codé à la
> main (héros, statistiques, types de données, datasets en vedette) qui n'est pas fait de blocs ; le
> modèle de départ mirroir désormais ce contenu réel.

## [ADDED]
- **Modèle de départ fidèle pour Accueil / À propos** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — le modèle reprend **exactement les mêmes textes localisés** que la vraie landing (`landing.*`) et la page À propos (`about.*`), dans **toutes les langues disponibles** (lu via `I18n.loadLanguage`), structuré en sections : **héros** (titre + sous-titre + bouton « Explorer les données »), **grille de statistiques** (jeux de données / spécimens / cellules / régions), **types de données** (3 colonnes Imagerie fixée / en direct / Suivi cellulaire avec descriptions et liens), **datasets en vedette**. Résultat : ce que tu édites ressemble à la page réelle, et en **publiant**, `index.html` affiche exactement ta version (vérifié bout-en-bout : éditeur → publier → `index.html` identiques). Un modèle minimal sert de repli si les dictionnaires ne sont pas encore chargés.
- **Statistiques dynamiques réelles dans les widgets** ([js/core/page-renderer.js](../js/core/page-renderer.js), [js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — le widget « Statistiques » gère désormais quatre sources live tirées de `Catalog.getStats()` : **datasets, spécimens, cellules, régions** (avant : seulement le nombre de datasets). Le sélecteur de source de l'éditeur propose les quatre + « Fixe » (valeur manuelle).

## [OPTIMIZED]
- **Interpolation des jetons white-label dans le contenu par blocs** ([js/core/page-renderer.js](../js/core/page-renderer.js)) — `PageRenderer` remplace maintenant les jetons `{brand}`, `{specimen}`, `{specimenPlural}`, `{org}`… dans **tout** texte de widget (comme `I18n.t()` le fait pour le reste du site), à partir de `InstanceConfig.tokens()`. Le contenu par blocs reflète donc l'identité de l'opérateur — sur le site publié **et** dans l'iframe de l'éditeur (mêmes octets) — au lieu d'afficher un nom de domaine figé ou un jeton littéral. Un texte sans `{` n'est pas touché (chemin rapide). Vérifié : `{specimenPlural}` → « embryons » dans l'aperçu comme en live.

[Versioning] Plateforme Web → v1.14.3. changelog_1.14.3.md généré.
