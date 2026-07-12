# Plateforme Web — v1.16.2

> **Un seul sélecteur pour la couleur du texte** — l'onglet Couleur / Dégradé vit maintenant dans le
> champ « Couleur du texte » lui-même (le champ séparé « Dégradé du texte » disparaît). Et le widget
> Héros gagne des couleurs **indépendantes** pour le titre et le sous-titre, chacune acceptant couleur
> unie ou dégradé.

## [ADDED]
- **Héros : couleurs indépendantes titre / sous-titre** ([js/core/page-renderer.js](../js/core/page-renderer.js), [js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — deux nouveaux champs « Couleur du titre » et « Couleur du sous-titre » (chacun avec les onglets Couleur / Dégradé) placés à côté de leurs tailles respectives. Le groupe Texte du panneau Style reste la base commune ; les champs dédiés la surchargent partie par partie.

## [OPTIMIZED]
- **Champ couleur du texte unifié** — `style.color` accepte désormais une couleur **ou** un dégradé (le picker montre les deux onglets) ; un dégradé est peint dans les glyphes (`background-clip:text`), une couleur reste un simple `color:`. Le champ séparé `style.textGradient` (v1.16.1) est retiré de l'éditeur ; les documents existants sont **migrés à l'ouverture** (`textGradient` → `color`, en conservant sa priorité d'origine) et le renderer continue d'honorer l'ancien champ pour les pages publiées non re-sauvées.

## [FIXED]
- Rien.
