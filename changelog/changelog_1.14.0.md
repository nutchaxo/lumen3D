# Plateforme Web — v1.14.0

> **Éditeur de page pleine page, façon Elementor.** L'onglet Pages ne montre plus un arbre de blocs
> dans un encart admin : on choisit une page, on clique **« Modifier avec l'éditeur »**, et la **vraie
> page web** s'ouvre en plein écran (barre de navigation, pied de page, thème réels) comme surface
> d'édition. Un **menu latéral gauche** contient tous les éléments (Titre, Texte, Héros, Bouton, Image,
> Galerie, Statistiques, Derniers éléments, Séparateur, Espace, HTML) : on les **glisse directement dans
> la page** ou on clique pour les ajouter. On clique n'importe quel élément *dans la page* pour le
> sélectionner et l'éditer ; la modification s'affiche **en direct** dans la page. C'était la demande
> répétée de l'opérateur : éditer la page elle-même, pleine largeur — pas une maquette étriquée.

## [ADDED]
- **Éditeur visuel pleine page** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js), [js/core/page-edit-frame.js](../js/core/page-edit-frame.js)) — l'onglet Pages a désormais deux vues :
  - **Lanceur** (dans le shell admin) : sélecteur de page (Accueil / À propos / pages personnalisées), aperçu en lecture seule, et un bouton **« Modifier avec l'éditeur »**.
  - **Éditeur plein écran** : la page réelle est chargée dans une `iframe` (`page.html?slug=…&edit=1`) et transformée en surface d'édition WYSIWYG. Chaque **section / colonne / widget** est rendu par le vrai `PageRenderer` puis habillé de contrôles d'édition (contour au survol, sélection au clic, mini-barre d'outils, poignée de déplacement, zones de dépôt). Un **panneau latéral gauche** offre deux onglets : **Éléments** (la palette de widgets) et **Réglages** (les réglages contextuels de la sélection).
- **Glisser-déposer d'un élément depuis la palette dans la page** — implémenté par glisser au pointeur (le drag natif HTML5 ne traverse pas fiablement la frontière d'iframe) : un fantôme suit le curseur, un indicateur d'insertion apparaît dans la page à l'endroit visé, et le lâcher insère le widget à la bonne position. Un simple clic sur un élément l'ajoute à la sélection courante.
- **Sélection dans la page + édition en direct** — cliquer un widget, une colonne ou une section *dans la page* le sélectionne ; le panneau Réglages bascule automatiquement et affiche ses champs. Toute modification (texte, couleur, disposition…) est reflétée immédiatement dans la page via `postMessage` (modèle poussé de l'admin vers l'iframe).
- **Redimensionnement des colonnes + réorganisation** — poignée de redimensionnement entre colonnes (aligné sur la grille 12), poignée de déplacement pour réordonner un widget ou le déplacer entre colonnes, barres d'outils de section (monter / descendre / ajouter une colonne / dupliquer / supprimer).
- **Modèles de départ pour les pages intégrées** — Accueil et À propos affichent leur mise en page statique par défaut (rien à charger comme blocs) ; l'éditeur propose « Partir d'une mise en page par défaut » pour créer une version par blocs éditable qui remplace le défaut à la publication.

## [OPTIMIZED]
- **Flux de données à sens unique** — l'onglet admin reste l'unique source de vérité : il détient le modèle `sections` et le pousse dans l'iframe (`LUMEN_EDIT_DOC`) ; l'iframe rend + émet des *intentions* (sélection / dépôt / action / redimensionnement) que l'admin applique puis re-pousse. Aucune divergence possible entre les deux fenêtres.
- **CSP-safe** — l'éditeur d'iframe n'injecte aucun `<style>`, colore via `var()` avec repli, et attache tous ses gestionnaires en JS : compatible avec la CSP stricte à nonce.

Notes techniques :
- `page.html` charge `js/core/page-edit-frame.js` ; `js/pages/page-view.js` délègue à `PageEditFrame.init()` quand l'URL porte `?edit=1` (après l'init des singletons cœur), sinon rend la page publiée comme avant.
- Traductions FR/EN/ES ajoutées (`pages.editWith`, `pages.editorTitle`, `pages.elements`, `pages.settings`, `pages.dragOrClick`, `pages.launcherSub`, …), parité complète des clés.

[Versioning] Plateforme Web → v1.14.0. changelog_1.14.0.md généré.
