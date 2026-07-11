# Plateforme Web — v1.15.0

> **L'éditeur de pages devient un vrai outil de design.** Chaque widget, colonne et section reçoit un
> panneau **Style** complet (typographie, fond & bordure, espacement, taille) — de quoi recréer
> fidèlement un design comme la page d'accueil ou À propos, sans toucher au code. Au passage, deux bugs
> gênants de l'éditeur sont corrigés : les colonnes qui s'empilaient au lieu de se partager la largeur, et
> le glisser-déposer qui se figeait dès que la souris quittait le menu de gauche.

## [ADDED]
- **Moteur de style générique par widget / colonne / section** ([js/core/page-renderer.js](../js/core/page-renderer.js), [js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — nouveau `PageRenderer.styleCss(style, groups)` qui compile un objet `props.style` en CSS inline **assaini** (aucun `<style>` injecté — compatible avec la CSP stricte). Le panneau Réglages expose quatre groupes repliables :
  - **Texte** : couleur, taille (px), graisse (300→800), interligne, espacement des lettres, italique, majuscules, alignement.
  - **Fond & bordure** : fond (couleur / dégradé), image de fond (URL), voile de couleur par-dessus (`overlay`), arrondi, largeur/couleur/style de bordure, ombre (légère/moyenne/forte), opacité.
  - **Espacement** : padding (4 côtés) et marges (haut/bas), en px.
  - **Taille** : largeur max (centrée) et hauteur min.
  Ces réglages s'appliquent **à l'identique** dans l'éditeur (l'iframe réutilise le même moteur) et sur la page publiée.
- **Sélecteurs de couleur** dans le panneau — chaque champ couleur combine désormais une pastille native (`<input type="color">`) et un champ texte qui accepte aussi `var(--…)` et `linear-gradient(…)`, les deux restant synchronisés.
- **Preset « Transformer en colonne en carte »** — un clic applique fond de surface + arrondi + bordure + ombre + padding, pour composer instantanément des mises en page en cartes (comme les colonnes de types de la page d'accueil).
- **Nouveau widget « Icône »** — n'importe quelle icône Lucide par son nom (ex. `microscope`, `atom`, `video`), avec taille, couleur et alignement.
- **Widgets existants nettement plus paramétrables** :
  - **Héros** : taille du titre et du sous-titre, alignement (gauche/centre/droite), **second bouton** (CTA secondaire), voile de couleur et hauteur mini pour un vrai hero plein écran.
  - **Bouton** : option pleine largeur + tous les styles de texte/fond.
  - **Image** : hauteur fixe + mode de cadrage (remplir / contenir).
  - **Galerie** : nombre de colonnes, hauteur et espacement réglables.
  - **Statistiques** : nombre de colonnes, fond des cartes, couleur et taille des valeurs, couleur des libellés.
  - **Séparateur** : couleur, épaisseur, largeur (%) et style de trait (plein / tirets / points).
  - **Derniers éléments** : nombre de colonnes.

## [OPTIMIZED]
- **Rendu éditeur ↔ page publiée unifié** ([js/core/page-edit-frame.js](../js/core/page-edit-frame.js)) — l'éditeur ne recalcule plus sa propre géométrie de sections/colonnes : il appelle `PageRenderer.sectionCss` / `columnCss` / `overlayNode`. Une seule source de vérité → la surface d'édition affiche exactement ce que verra le visiteur (largeurs, gaps, styles), et le code dupliqué a été supprimé.

## [FIXED]
- **Colonnes qui s'empilaient sur toute la largeur** ([js/core/page-renderer.js](../js/core/page-renderer.js), [js/core/page-edit-frame.js](../js/core/page-edit-frame.js)) — avec deux colonnes ou plus, chaque colonne prenait 100 % et se plaçait sous la précédente au lieu du 50/50 attendu. Cause : dans l'éditeur, les poignées de redimensionnement (12 px, dans le flux) **s'ajoutaient** au `gap` de la ligne flex, et les bases de colonnes (`calc(% - gap)`) étaient trop larges — la somme dépassait la ligne, qui débordait donc en empilant les colonnes. Correctif : la ligne ne déclare plus que `row-gap` ; les poignées **occupent exactement** la largeur du gap ; et la base de chaque colonne soustrait la part **exacte** du gap (`gap·(n-1)/n`) plus un demi-pixel de marge flottante que `flex-grow` réabsorbe → *n* colonnes + leurs gaps tiennent toujours sur une seule ligne. Vérifié : deux colonnes 6/12 rendues côte à côte (504 px chacune sur 1080).
- **Glisser-déposer figé au bord du menu** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js), [js/core/page-edit-frame.js](../js/core/page-edit-frame.js)) — en tirant un élément depuis la palette de gauche, le fantôme se bloquait contre la bordure du menu dès que la souris entrait sur la page (iframe) : le document de l'iframe captait les `pointermove` et le parent ne les recevait plus. Correctif : `setPointerCapture` sur le bouton de palette (et sur les poignées de déplacement / redimensionnement de l'iframe), un seuil de 5 px pour distinguer clic et glisser, et la gestion de `pointercancel`. Le fantôme suit maintenant la souris jusque dans la page et dépose l'élément à l'endroit visé.

[Versioning] Plateforme Web → v1.15.0. changelog_1.15.0.md généré.
