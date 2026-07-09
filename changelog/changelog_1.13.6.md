# Plateforme Web — v1.13.6

> **Couleur de thème enfin appliquée + édition des pages intégrées + éditeur plein écran.** La couleur
> dominante choisie à l'installation restait verte (cache navigateur sur `config/theme.css`). L'onglet Pages
> refusait d'éditer home/about (« Empty page »). L'éditeur ressemblait à un encart.

## [FIXED]
- **Couleur de thème non respectée (restait verte)** ([dev_server.py](../dev_server.py), [api/_html_server.php](../api/_html_server.php)) — `config/theme.css` (régénéré à chaque changement de thème) était servi sans anti-cache et, depuis les en-têtes de cache v1.13.3, mis en cache 7 jours → le navigateur servait la version verte par défaut. Les serveurs injectent désormais `config/theme.css?v=<mtime>` dans le HTML servi : l'URL change dès que le thème est régénéré → cache busté, couleur appliquée immédiatement (tout en gardant le cache efficace le reste du temps). Vérifié : `--color-primary` passe bien à la couleur choisie.

## [ADDED]
- **Pages intégrées (Accueil / À propos) éditables** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — leur contenu par défaut est du HTML statique (rien à charger comme blocs), d'où l'ancien « Empty page ». L'éditeur propose maintenant, sur une page intégrée vide, un bouton **« Partir d'une mise en page par défaut »** qui charge une trame éditable (Accueil : héros + derniers datasets ; À propos : titre + texte), à modifier puis publier pour remplacer la mise en page par défaut.
- **Mode plein écran de l'éditeur** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — bouton **« Plein écran »** : l'éditeur occupe tout l'écran (position:fixed, pleine largeur) pour une vraie surface d'édition type Elementor (palette de widgets à gauche, canvas WYSIWYG large, réglages à droite) au lieu d'un panneau étriqué dans le shell admin.

[Versioning] Plateforme Web → v1.13.6. changelog_1.13.6.md généré.
