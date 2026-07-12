# Plateforme Web — v1.16.0

> **Personnaliser une page devient une affaire de clics, plus de valeurs à taper.** Les réglages des
> widgets sont entièrement repensés : un vrai sélecteur de couleurs (nuancier, couleurs du thème,
> opacité), un **studio de dégradés** avec préréglages intégrés et préréglages personnels enregistrables
> en un clic, des curseurs pour toutes les valeurs numériques, des boutons segmentés pour tous les choix,
> et un sélecteur d'icônes Lucide avec recherche. Au passage, **5 nouveaux widgets** font leur entrée :
> Carte icône, Citation, Accordéon / FAQ, Frise chronologique et Bandeau d'action.

## [ADDED]
- **5 nouveaux widgets de page** ([js/core/page-renderer.js](../js/core/page-renderer.js)) — complets, stylables via le panneau Style, injection-safe et compatibles CSP stricte (styles inline uniquement) :
  - **Carte icône** (`feature-card`) — pastille d'icône Lucide (taille, couleur, fond couleur *ou dégradé*, forme ronde/carrée), titre, texte et lien « En savoir plus » ; idéale en colonnes de 3 pour présenter des fonctionnalités.
  - **Citation** (`quote`) — trois styles au choix (barre latérale / carte avec grand guillemet / grande centrée), auteur, rôle, photo optionnelle et couleur d'accent.
  - **Accordéon / FAQ** (`accordion`) — questions/réponses repliables en `<details>` natif (zéro JS requis sur la page publiée), mode « une seule ouverte à la fois » (attribut `name`, dégradation gracieuse), première ouverte par défaut, chevron animé.
  - **Frise chronologique** (`timeline`) — étapes datées sur une ligne verticale avec points colorés (halo `color-mix`), parfaite pour l'historique d'un projet ou d'un labo.
  - **Bandeau d'action** (`cta-banner`) — bandeau compact titre + sous-titre + bouton sur fond dégradé (par défaut : dégradé des couleurs du thème), disposition horizontale ou centrée.
- **Studio de dégradés** ([js/pages/admin/pages-controls.js](../js/pages/admin/pages-controls.js)) — tout champ « Fond » (sections, héros, bandeau, cartes, style générique, voiles) s'ouvre sur un panneau à deux onglets **Couleur / Dégradé** :
  - **12 dégradés prédéfinis** (dont un aux couleurs du thème du site) applicables d'un clic, avec aperçu en direct.
  - **Préréglages personnels** : « Enregistrer comme préréglage » ajoute le dégradé courant à la bibliothèque — persistée dans `config/instance.json` (`editor.gradientPresets`), donc partagée entre navigateurs et opérateurs ; suppression au survol.
  - **Construction 100 % au clic** : 2 ou 3 couleurs (pipette native), pavé de 8 directions + curseur d'angle fin, type linéaire / radial.
  - Ré-analyse fidèle des valeurs existantes (`45deg`, `to right`, stops `var(--…)`) pour reprendre l'édition d'un dégradé déjà posé.
- **Sélecteur de couleurs riche** — chaque champ couleur devient un bouton-pastille qui déplie : les **7 couleurs du thème** (primaire, accent, fond, surface, texte…, qui suivent le thème du site), un nuancier de 24 couleurs, une pipette personnalisée, un curseur d'**opacité** (composé en `color-mix`, plus besoin d'écrire du `rgba(…)`), « Aucune (auto) », et un champ CSS avancé replié pour les experts.
- **Sélecteur d'icônes Lucide** — fini le nom d'icône à taper : aperçu, favoris (48 icônes courantes dont microscope, atom, dna…) et **recherche dans tout le catalogue** ; utilisé par les widgets Icône et Carte icône.
- **Éditeur de listes générique** (accordéon, frise, galerie, statistiques) — chaque élément devient une carte repliable avec réordonnancement ▲▼, suppression, et résumé lisible ; les statistiques gardent leurs sources dynamiques (le champ « valeur fixe » se désactive automatiquement sur une source live).
- **Palette d'éléments par catégories** — Bases / Contenu / Listes & données / Structure, pour s'y retrouver parmi les 17 widgets.

## [OPTIMIZED]
- **Plus aucune valeur brute à saisir dans les réglages** ([js/pages/admin/tab-pages.js](../js/pages/admin/tab-pages.js)) — toutes les valeurs numériques (tailles, espacements, arrondi, opacité, graisse, interligne…) passent sur des **curseurs** doublés d'un petit champ fin ; les énumérations (alignement, niveau de titre, style de trait, ombre, cadrage…) passent en **boutons segmentés** ; les cases à cocher deviennent des **interrupteurs**. Les champs « auto » se réinitialisent d'un clic (×).
- **Librairie de contrôles factorisée** — le rendu et le câblage des champs quittent `tab-pages.js` pour le nouveau module réutilisable [js/pages/admin/pages-controls.js](../js/pages/admin/pages-controls.js) (`renderFields` + descripteurs) ; réglages de section et de colonne convertis au même moteur.
- **i18n** — ~70 nouvelles clés `pages.*` en parité complète en/fr/es ; libellés existants harmonisés (les unités sont portées par les curseurs).

## [FIXED]
- **Dégradés hérités « to right » mal ré-analysés** — l'ouverture du studio de dégradés sur un ancien `linear-gradient(to right, …)` mappait la direction comme une couleur ; les mots-clés `to <côté>` sont désormais convertis vers l'angle équivalent.
- **`var(--…)` avec fallback dans les aperçus** — l'aperçu des pastilles n'ajoute un fallback représentatif qu'aux `var()` qui n'en ont pas (l'ancien remplacement naïf pouvait produire un `var()` invalide).
