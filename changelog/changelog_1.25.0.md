# Plateforme Web — v1.25.0

> **La page « À propos » est refaite, et elle n'est plus du HTML figé.** Elle était bâtie sur une
> succession de « gros titre centré + rangée de cartes », avec des intitulés administratifs
> (« Crédits, contexte scientifique, accès et citation ») et — depuis la neutralisation white-label des
> dictionnaires — un contenu devenu incohérent : un nom de créateur codé en dur au-dessus d'un texte
> générique. Elle est remplacée par une mise en page éditoriale (libellé de chapitre à gauche, contenu
> à droite, filets fins plutôt que boîtes) **écrite dans le format de l'éditeur de pages**. Le défaut
> livré est intégralement white-label : il se lit à travers les jetons de l'instance
> (`{brandShort}`, `{tagline}`, `{SpecimenPlural}`, `{org}`, `{year}`).

## [ADDED]

### La page À propos par défaut EST un document de l'éditeur ([js/core/page-templates.js](../js/core/page-templates.js))
- Nouveau module `PageTemplates` (IIFE classique) : **une seule source** pour la page À propos par
  défaut, consommée par [about.html](../about.html) / [js/pages/about.js](../js/pages/about.js) — ce
  que voient les visiteurs — *et* par l'onglet Pages du panneau — ce que l'opérateur ouvre dans
  l'éditeur. Les deux ne peuvent plus diverger : auparavant l'éditeur affichait une *reproduction* du
  HTML statique, à resynchroniser à la main après chaque retouche.
- [about.html](../about.html) n'a plus **aucun** balisage de repli : le `<main>` est rempli par
  `PageRenderer`. `css/about.css` (468 lignes, exclusivement au service de ce balisage) est supprimé,
  de même que le code de statistiques et de copie de citation de `about.js` — ces rôles sont tenus par
  les widgets `counter` et `cite-block`.
- Le texte du gabarit est **localisé dans le document** (`{en, fr, es}`), pas dans `lang/*.json` :
  c'est du contenu de page, l'opérateur le modifie par langue dans l'éditeur. Un changement de langue
  re-rend la page au lieu de la recharger.
- **Contrainte de rédaction** : chaque phrase doit rester correcte lorsqu'un jeton facultatif
  (`{org}`) vaut la chaîne vide — les jetons sont donc placés dans des lignes étiquetées et des
  sur-titres, jamais au milieu d'une phrase.
- Structure : bandeau-titre → chiffres animés en direct → *Le projet* → *Explorer* → *Les données* →
  *Références* → *Contact*. Chaque chapitre est une section 4/8 — sur-titre et titre à gauche, contenu
  à droite — et les fonds alternent transparent / surface.

### Trois widgets éditoriaux ([js/core/page-renderer.js](../js/core/page-renderer.js) — 27 types)
- **`link-list` (Liste de liens)** — des lignes pleine largeur séparées par des filets, avec icône,
  titre, description et flèche : le remplacement d'une grille de cartes pour un menu de navigation.
  L'affordance de survol est typographique (le titre prend l'accent, la flèche glisse), donc sans
  décalage de mise en page. Réglages : filets, flèche, hauteur de ligne, taille du titre, couleurs.
- **`spec-list` (Fiche d'informations)** — des lignes intitulé / valeur réglées par des filets, pour
  une affiliation, un contact, une licence. La valeur peut être un lien ; sur une colonne étroite elle
  passe sous son intitulé au lieu d'être comprimée.
- **`logo-strip` (Bandeau de logos)** — une rangée de logos partenaires jamais recadrés (`contain`),
  avec plaque claire optionnelle pour les logos sombres sur thème sombre, désaturation et retour à la
  couleur au survol, monogramme ou icône en l'absence d'image.
- Les règles `:hover` correspondantes vivent dans [css/pages.css](../css/pages.css) — statique et
  `'self'`, comme l'impose la CSP stricte (aucun `<style>` injecté).

### Le compteur animé sait afficher un chiffre du catalogue
- `counter` accepte `props.source` (`datasetCount` / `specimenCount` / `cellCount` / `regionCount`) —
  la même liste que `stat-grid`, désormais partagée par la constante `LIVE_STATS` du moteur de rendu
  et `LIVE_SOURCES` côté éditeur. Sans `source`, le comportement est strictement inchangé.
- Dans l'éditeur, le champ « Valeur cible » disparaît quand une source en direct est choisie.

### Éditeur : les nouveaux widgets sont pleinement paramétrables
- Palette, valeurs par défaut, onglets *Contenu* et *Style* des trois widgets, plus le sélecteur de
  source du compteur ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)).
- Traductions FR / EN / ES ajoutées pour les nouveaux widgets **et** pour `tabs` / `counter` / `video`,
  laissés sans clés en v1.22.0 (parité vérifiée : 186 clés `pages` dans les trois fichiers).

## [FIXED]

- **La couleur de texte d'un widget *Texte* n'avait aucun effet.** `base.css` fixe `p { color }`, et
  une règle explicite l'emporte sur une valeur héritée : le style compilé n'atteignait donc jamais les
  paragraphes. Le groupe *Texte* est maintenant appliqué **sur les paragraphes eux-mêmes** (même
  famille de bug que le titre de héros documenté en v1.16). Le remède vaut aussi pour un dégradé de
  texte, masqué de la même façon. L'échappatoire CSS brute (`style.css`) est retirée de la copie
  appliquée aux paragraphes, pour ne pas être posée une fois par paragraphe.
- **Un grand titre de héros débordait sur téléphone.** `titleSize` est compilé en
  `min(<taille>px, 11vw)` : au-dessus d'environ 9 × la taille en largeur de fenêtre — donc sur tout
  écran de bureau — la valeur en pixels l'emporte et le rendu est identique à avant.
- Les filets de `link-list` et `spec-list` utilisent `--border-default` (10 % dans les deux thèmes) et
  non `--border-subtle` (5 %, quasi invisible sur fond blanc) : ici, les filets *sont* la structure.
- Une case à cocher peut enfin déclarer `refresh:true` pour révéler ses champs dépendants
  ([js/pages/admin/pages-controls.js](../js/pages/admin/pages-controls.js)) — `seg` et `select` le
  faisaient déjà.

### Vérifié
- Rendu de la page dans les deux thèmes et à trois largeurs (1440 / 790 / 375) : aucun débordement
  horizontal, colonnes 4/8 empilées sur téléphone, filets visibles en clair comme en sombre.
- Jetons interpolés de bout en bout, BibTeX inclus : `year = {{year}}` produit bien `year = {2026}`.
- Bascule FR → ES → EN sur la page en direct : re-rendu complet dans la langue choisie.
- Compteurs en direct : 15 / 13 / 0 / 0 conformes à `Catalog.getStats()`, animation déclenchée au
  défilement pour les compteurs sous la ligne de flottaison.
- Les trois nouveaux widgets rendus dans le cadre d'édition (`page.html?slug=…&edit=1`) via un
  `LUMEN_EDIT_DOC` : aucune erreur de console, chrome d'édition intacte.
- `PageTemplates` (script classique) bien lisible depuis le panneau d'administration en ESM — vérifié
  par un import dynamique réel, pas seulement par raisonnement sur la portée lexicale globale.
- Aucune référence pendante à `about.css`, `#about-default` ou aux anciens identifiants de citation.
