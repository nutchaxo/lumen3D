# Plateforme Web — v1.16.1

> **Transparence partout et texte en dégradé.** Chaque couleur d'un dégradé reçoit son propre curseur
> de transparence (les fondus « vers transparent » se font au clic), et le panneau Style gagne un champ
> **Dégradé du texte** qui peint le dégradé dans les lettres elles-mêmes. Au passage, correction d'un
> bug du widget Héros : la couleur et la taille du texte du panneau Style restaient sans effet.

## [ADDED]
- **Transparence par couleur dans le studio de dégradés** ([js/pages/admin/pages-controls.js](../js/pages/admin/pages-controls.js)) — chaque stop du builder a désormais son curseur α (0→100 %) ; la valeur est composée en `color-mix(in srgb, C α%, transparent)` (aucun `rgba(…)` à écrire) et fidèlement ré-analysée à la réouverture. Le curseur d'opacité des couleurs unies descend aussi jusqu'à 0 %.
- **Dégradé du texte** ([js/core/page-renderer.js](../js/core/page-renderer.js), panneau Style → groupe Texte) — nouveau champ `style.textGradient` : le dégradé est peint **dans les glyphes** (`background-clip:text` + couleur transparente), avec garde-fou (une valeur non-dégradé retombe sur une couleur simple au lieu de rendre le texte invisible). Le sélecteur s'ouvre directement sur l'onglet Dégradé pour ce champ. Sur le Héros, le dégradé s'applique au titre (le sous-titre garde sa taille et sa couleur propres).

## [FIXED]
- **Héros : couleur et taille du texte sans effet** — le groupe Texte du panneau Style s'appliquait à la racine du bloc, où `base.css` (qui épingle `color`/`font-size` sur `h1…h6`) l'écrasait systématiquement. Le style texte est désormais posé sur le `h1` et le sous-titre eux-mêmes (le sous-titre suit tout sauf la taille et le dégradé, réservés au titre).
- **Titres internes des widgets Carte icône et Frise** — passés en `color:inherit` pour que la « Couleur du texte » du panneau Style les recolore aussi (même cause : règles `h3`/`h4` de la feuille de style).
- **Valeurs CSS longues tronquées** — le plafond du sanitizer de valeurs passe de 200 à 400 caractères : un dégradé à 3 couleurs dont les stops sont des `var(--…)` enveloppés de `color-mix(…)` dépassait l'ancienne limite et sortait tronqué (CSS invalide).
