# Changelog v1.53.2 (Plateforme Web)

## [ADDED]

* **La galerie d'images d'un dataset passe de la barre latérale à l'angle inférieur droit du viewer.** Les captures annotées, figures et schémas que l'opérateur attache à un dataset (`metadata.json` → `gallery`) étaient rendus dans une section de la barre latérale, sous *Qualité de rendu* : dès qu'on travaillait sur les canaux, elles sortaient de l'écran. Elles sont désormais dans un **dock flottant épinglé au coin inférieur droit de la zone de rendu**, à côté du spécimen qu'elles annotent — sur le viewer 3D (`viewer.html`) comme sur la page photographie 2D (`2d.html`), qui partagent le même composant [`js/components/dataset-gallery.js`](../js/components/dataset-gallery.js) et le même conteneur `.viewer-canvas-container`.
* **Trois états, deux boutons.** L'en-tête du dock porte le nom de la galerie, le nombre d'images et deux commandes :
  * **Agrandir / Réduire** — le panneau passe de 236 px (vignettes de 56 px) à `min(560px, 72vw)` avec des vignettes de 104 px et une hauteur maximale de 72 % de la zone de rendu, pour comparer une figure au volume sans ouvrir la visionneuse.
  * **Masquer** — le panneau se replie sur une simple **puce** ronde dans le coin (icône + compteur d'images) ; un clic dessus le rouvre **à la taille qu'il avait**, agrandi compris.
* **Le clic sur une vignette ouvre toujours l'image en grand.** La visionneuse plein écran est inchangée (fond assombri, légende, compteur `n / total`, flèches ‹ ›, `Échap` / ← / → au clavier, piège de focus) et reste accessible quel que soit l'état du dock.
* **L'état est mémorisé** (`localStorage`, clé `iribhm-gallery-dock`) : il suit l'opérateur d'un dataset à l'autre et d'une session à la suivante. Un navigateur qui refuse le stockage (navigation privée, profil kiosque) perd la préférence, jamais la galerie — chaque accès est gardé.

## [OPTIMIZED]

* **Le dock ne mange ni la bande d'échelle ni les pastilles d'état.** Il s'empile *au-dessus* de la bande des 54 px inférieurs, qui appartient à la barre d'échelle du viewer 3D (`#viewer-scale-bar`) et à la pastille de chargement de la page 2D (`.p2d-load-state`) : une capture de figure ne perd donc jamais son échelle. Mesuré en navigateur : dock `bottom: 714 px`, barre d'échelle `top: 724 px`, pastille 2D `top: 732 px`.
* **Un panneau étroit reste utilisable** — un panneau de la page *Comparer* est sa propre iframe, donc sa largeur *est* la largeur de fenêtre : sous 560 px le dock se resserre (168 px, et `min(92vw, 420px)` agrandi) au lieu de recouvrir le rendu.
* **Aucune icône n'est reconstruite à l'usage** : le bouton de taille porte ses deux icônes (`maximize-2` / `minimize-2`) et c'est l'attribut `data-state` du dock qui décide en CSS laquelle est visible. Les libellés portent leur clé i18n (`data-i18n-title` / `data-i18n-aria`), donc le changement de langue retraduit un dock construit en JS comme il retraduit le balisage statique.
* La molette au-dessus des vignettes ne se propage plus au zoom du volume (`overscroll-behavior: contain`), et un dock dont toutes les vignettes ont échoué au chargement se retire au lieu d'afficher un panneau vide.

## [FIXED]

* Les vignettes et la puce utilisent `--border-default`, un jeton qui existe réellement : l'ancien `--border-light` de `.gallery-thumb` n'est défini nulle part dans `css/themes.css`, si bien que la bordure retombait sur `currentColor`.

## Notes techniques

* Nouvelles clés dans les quatre langues : `viewer.galleryHide`, `viewer.galleryShow`, `viewer.galleryExpand`, `viewer.galleryReduce`.
* `DatasetGallery.init()` ne prend plus `sectionId` / `containerId` (le dock construit son propre DOM et se monte dans la zone de rendu) ; il accepte une option `mount` pour un sélecteur de conteneur différent. Les sections `#gallery-section` de `viewer.html` et `2d.html` ont été retirées.
* Test : `tests/js/test_gallery_dock.mjs` (montage dans la zone de rendu, machine à états et persistance, stockage hostile, visionneuse, dataset sans image).
