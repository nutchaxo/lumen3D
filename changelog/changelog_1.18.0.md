# Plateforme Web — v1.18.0

> **L'éditeur de pages devient un vrai outil de design.** Le panneau de réglages est entièrement
> réorganisé à la façon d'Elementor : un en-tête qui nomme l'élément sélectionné, un fil d'Ariane
> cliquable (Section › Colonne › Widget), et trois onglets — **Contenu · Style · Avancé** — dont les
> réglages sont rangés en groupes repliables au lieu d'une longue liste. Chaque widget gagne en
> personnalisation (couleurs, formes, mises en page, médias), quatre nouveaux widgets arrivent
> (Badges, Liste à icônes, Profil, Citation copiable), et trois pouvoirs transversaux s'ajoutent à
> **tous** les éléments : effets au survol, visibilité par taille d'écran, et CSS personnalisé.
> Test de validation : la page **À propos** est désormais reproductible à l'identique — mise en page,
> cartes, citations, institutions, contacts — uniquement avec l'éditeur.

## [ADDED]

### Panneau de réglages réorganisé (Contenu · Style · Avancé)
- **En-tête d'élément** — pastille d'icône du type, nom du widget, et actions Dupliquer / Supprimer en icônes.
- **Fil d'Ariane cliquable** — `Section 2 › Colonne 1 › Héros` : remonter à la colonne ou à la section en un clic, sans chercher la bonne zone dans la page.
- **Trois onglets** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) :
  - **Contenu** — les textes, liens, listes et données.
  - **Style** — couleurs, tailles, formes, alignements ; les réglages propres au widget viennent avant les groupes génériques (Texte, Fond & bordure).
  - **Avancé** — Espacement, Taille, Effets, Visibilité, CSS personnalisé.
  - L'onglet actif est conservé d'une sélection à l'autre, et l'état ouvert/fermé de chaque groupe est mémorisé.
- **Barre latérale élargie** (300 → 340 px) pour que les contrôles respirent.

### Nouveaux contrôles ([js/pages/admin/pages-controls.js](../js/pages/admin/pages-controls.js))
- **Espacement 4 côtés lié** — les quatre valeurs (haut/droite/bas/gauche) dans une grille compacte avec un bouton **lier/délier** : lié, une saisie règle les quatre ; délié, chaque côté est indépendant. Un « × » remet tout en auto. Padding et marges y passent tous les deux.
- **Ombre** — segments Aucune · S · M · L · **Halo**, avec une **couleur d'ombre** qui apparaît dès qu'une ombre est choisie (recolorer une ombre garde ses décalages et son flou).
- **Couleurs récentes** — les dernières couleurs choisies sont proposées en haut du sélecteur.
- **Icône « Aucune »** — le sélecteur d'icônes permet enfin de n'en mettre aucune.
- **Groupes repliables** (`renderGroups`) et champs conditionnels (`showIf`) : les réglages non pertinents disparaissent au lieu d'être grisés (ex. les options d'image d'une carte quand le média est un monogramme).

### Quatre nouveaux widgets ([js/core/page-renderer.js](../js/core/page-renderer.js) — 17 → 21 types)
- **Badges** — rangée de pastilles (texte + icône ou point dégradé), police mono optionnelle, couleurs de fond/texte/bordure, taille et espacement.
- **Liste à icônes** — icône + texte (+ lien), disposition verticale ou horizontale, couleur et taille des icônes. `mailto:` accepté.
- **Profil** — monogramme / photo / icône + nom + rôle + description, disposition horizontale ou verticale, ombre lumineuse, couleurs et tailles réglables.
- **Citation copiable** — carte avec bouton **Copier** et bloc repliable (BibTeX…), police monospace optionnelle.

### Widgets existants plus personnalisables
- **Héros** — **badge** au-dessus du titre (texte + icône ou pastille) et **halo décoratif** (deux voiles radiaux, couleurs réglables) qui reproduit l'ambiance de la vraie page d'accueil.
- **Bouton** — **icône** (à gauche ou à droite), **taille** (S/M/L) et nouveau style **Contour**.
- **Carte icône** — le média devient **Icône · Image · Monogramme · Aucun** (avec plaque de fond pour les logos), **disposition horizontale**, couleurs de titre/texte/lien, flèche optionnelle, et **carte entièrement cliquable**.
- **Texte riche** — mise en forme `**gras**`, `*italique*`, `[lien](url)` — **à activer par case à cocher** (voir Compatibilité).
- **Citation** — étiquette (eyebrow) au-dessus et lien source (DOI…) en dessous.
- **Image** — légende sous l'image.
- **Galerie** — zoom au survol et légendes.
- **Statistiques** — bordure, arrondi et padding des cartes.
- **Derniers éléments** — fond, bordure, arrondi, couleur des titres, lévitation au survol.
- **Accordéon** — fond et bordure des éléments.
- **Bandeau d'action** — bouton secondaire.
- **Séparateur** — accepte un dégradé (rendu en barre pleine plutôt qu'en filet).

### Trois pouvoirs sur tous les éléments (widget, colonne, section)
- **Effets au survol** — Lévitation · Halo · Zoom.
- **Visibilité** — masquer sur mobile et/ou sur ordinateur (neutralisé pendant l'édition, pour que l'élément reste sélectionnable).
- **CSS personnalisé** — déclarations CSS appliquées directement à l'élément, pour les cas que l'interface ne couvre pas.
- **Marges gauche/droite** et **couleur d'ombre** rejoignent les réglages de style.

### Modèle de la page « À propos » fidèle à la vraie page
Ouvrir l'éditeur sur À propos propose désormais une reproduction complète de la page réelle — héros avec badge et halo, cartes créateur et contexte scientifique (profil, badges IA, citation de thèse avec DOI), institutions avec logos, statistiques en dégradé, cartes d'accès rapide, blocs de citation avec BibTeX, contacts en liste à icônes — chacune de ces sections étant éditable et republiables telle quelle.

## [OPTIMIZED]
- **Survol et responsive sans `<style>` injecté** — `:hover` et `@media` sont impossibles en style inline, et la CSP stricte interdit d'injecter une feuille : les effets passent par des classes servies depuis un nouveau fichier statique [css/pages.css](../css/pages.css) (`'self'`), la couleur du halo étant transmise par la propriété personnalisée `--pr-glow`.
- **i18n** — ~170 nouvelles clés en parité stricte en/fr/es (434 clés `pages.*` par langue, vérifiées identiques).

## [FIXED]
- **Icône `id-card` inexistante** dans le Lucide embarqué (0.344) — le widget Profil affichait un avertissement console et aucune icône dans la palette ; remplacée par `contact`.

### Compatibilité (vérifiée par comparaison A/B avant/après)
- **Rendu des pages existantes strictement identique** — le HTML produit par le nouveau moteur pour un document v1.17 (18 widgets, tous les types, plus le format historique `{blocks}` à plat) est **identique octet pour octet** à celui de l'ancien. Tous les nouveaux réglages sont optionnels et leurs valeurs par défaut reproduisent le rendu antérieur ; le style de bouton historique (`variant:'lg'`, `style` en chaîne) reste honoré.
- **Mise en forme du texte riche non rétroactive** — le balisage `**…**` / `*…*` est **désactivé par défaut** et ne s'active que sur les nouveaux blocs (ou par la case à cocher). Sans cela, une légende scientifique existante du type `* p<0.05, ** p<0.01` aurait silencieusement perdu ses astérisques.
- **CSS personnalisé cloisonné** — un sanitizer dédié retire `<>{}`, `expression(` et `javascript:` et plafonne à 600 caractères : impossible de sortir de la déclaration pour viser d'autres sélecteurs.
- **Liens des widgets filtrés** — `javascript:`, `vbscript:` et `data:` sont refusés (le libellé se dégrade en texte simple) sur les liens de texte riche, de liste à icônes, de carte et de citation ; `mailto:` reste accepté.
- **Effets au survol en liste blanche** — une valeur inconnue n'ajoute aucune classe.
