# Changelog — Plateforme Web v1.36.0

## [ADDED]

### Le néerlandais, quatrième langue de la plateforme

`lang/nl.json` complète `en` / `fr` / `es` : **1420 clés**, la totalité de l'interface publique et du panneau d'administration. Le fichier est construit sur la structure exacte de `lang/en.json` (mêmes clés, même ordre, même imbrication) et vérifié automatiquement — parité 1420/1420, aucune clé manquante ni surnuméraire, et **tous les jetons d'interpolation préservés** (`{brand}`, `{specimen}`, `{count}`, `{n}/{total}`…), y compris ceux qui sont des exemples littéraux et non des substitutions, comme le `{name}` de `pages.vr.hint`.

Les **17 dictionnaires de plugins** reçoivent leur `lang/nl.json`, et chaque `plugin.json` déclare `nl` dans `i18nLanguages` — sans quoi `I18n.registerPluginLang` ne va jamais chercher le fichier et le plugin retomberait silencieusement sur l'anglais. Le néerlandais utilise les mêmes lettres que l'anglais pour les repères anatomiques (A/P, V/D, R/L : *rechts* / *links*), donc le gizmo d'orientation ne change pas.

`lang/manifest.json` liste `nl` ; `LANG_META` dans `js/core/i18n.js` fournissait déjà le nom natif et le drapeau, donc le sélecteur de langue le propose sans autre modification.

Vérifié dans un navigateur, panneau basculé en `nl` : le sélecteur annonce « Nederlands », l'écran de connexion, les onze rubriques et le titre de chaque onglet s'affichent en néerlandais, aucune clé non résolue ne subsiste à l'écran et aucune requête n'échoue.

> Note d'exploitation : ajouter `nl` à `i18nLanguages` modifie le contenu de chaque `plugin.json`, donc leur empreinte. Sur un hôte où ces plugins étaient approuvés, l'approbation devient caduque à la prochaine mise à jour du plugin — c'est le comportement voulu du contrôle d'intégrité (`_classify_plugin`), et l'installation depuis le catalogue ré-approuve automatiquement.
