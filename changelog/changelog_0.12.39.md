# Changelog — Plateforme Web v0.12.39

**Date :** 2026-06-15

---

## [FIXED]

### Hamburger menu : détection du wrap basée sur ResizeObserver (suppression du breakpoint fixe)

**Fichiers :** `css/viewer.css`, `js/pages/viewer.js`

**Symptôme :** Le bouton hamburger apparaissait trop tôt ou trop tard selon la résolution écran,
car la logique reposait sur un breakpoint CSS fixe (`max-width: 1024px`) indépendant du contenu
réel. Cela laissait subsister une plage dans laquelle la toolbar s'étalait sur deux lignes sans
qu'aucun hamburger ne soit affiché.

**Cause racine :** La règle `@media (max-width: 1024px)` est un seuil de largeur de viewport
aveugle : elle ne détecte pas si la toolbar a réellement wrappé sur deux lignes (ce qui dépend
de la longueur du titre, de la taille de la police, du zoom navigateur, etc.).

**Correction :**
- **CSS (`viewer.css`)** : Le bloc `@media (max-width: 1024px)` est remplacé par des sélecteurs
  de classe `.viewer-header.toolbar-collapsed { … }`. Le CSS ne prend plus aucune décision de
  breakpoint ; il se contente d'appliquer les styles quand la classe est présente.
- **JS (`viewer.js`) — `_bindHamburgerMenu`** : Un `ResizeObserver` surveille l'élément
  `.viewer-header`. À chaque redimensionnement, la classe `.toolbar-collapsed` est
  temporairement retirée pour mesurer la hauteur naturelle du header (toolbar inline).
  Si `naturalH > 60px` (56px min-height + 4px de tolérance), la toolbar a wrappé
  et la classe est appliquée. Sinon, elle est retirée. Un flag RAF (`_rafPending`)
  évite les appels multiples dans le même frame.

**Résultat :** Le basculement en mode hamburger est instantané et précis, indépendamment
de la largeur du viewport — le seul critère est la hauteur réelle du header.
