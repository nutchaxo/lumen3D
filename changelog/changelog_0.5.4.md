# Plateforme Web v0.5.4 — 2026-06-04

## [ADDED] Micro barre de chargement pour le filtre gaussien

### Description
Un toast discret apparaît en bas à droite du canvas quand un filtre gaussien est en cours de calcul.
Il se masque automatiquement quand tous les Workers ont terminé.

### Composants
- **HTML** (`viewer.html`) : Ajout du `<div class="blur-progress-toast hidden" id="blur-progress-toast">`
  avec icône Lucide `sparkles` et barre de progression.
- **CSS** (`viewer.css`) : Nouveau bloc `.blur-progress-toast` — glassmorphism, position bottom-right,
  animation shimmer sur la barre et pulsation sur l'icône.
- **JS** (`volume-viewer.js`) :
  - `_blurActiveCount` : compteur du nombre de tâches blur actives (supporte multi-canal simultané).
  - `_showBlurToast()` / `_hideBlurToast()` : affiche/masque le toast.
  - `_dispatchParallelBlur()` : incrémente le compteur au début, appelle `_hideBlurToast()`
    dans `wrappedOnDone` quand le compteur revient à 0.

### Design
- Même style glassmorphism que la progress bar de qualité (bottom-left).
- Animation shimmer sur la barre (indeterminate).
- Pulsation de l'icône ✨ pendant le calcul.
- Disparition propre à la fin (classe `hidden`).
