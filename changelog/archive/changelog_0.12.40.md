# Changelog — Plateforme Web v0.12.40

**Date :** 2026-06-15

---

## [ADDED]

### Bouton de masquage / réouverture du panneau latéral gauche

**Fichiers :** `viewer.html`, `css/viewer.css`, `js/pages/viewer.js`

**Fonctionnalité :**
Deux nouveaux boutons permettent à l'utilisateur de masquer et de restaurer le panneau latéral
gauche (histogrammes, canaux, qualité, display) pour maximiser l'espace de visualisation 3D.

#### Bouton de fermeture (flèche gauche)
- **Élément HTML :** `<button id="btn-collapse-sidebar">` avec icône Lucide `panel-left-close`
- **Emplacement :** Barre de titre `sidebar-topbar` ajoutée en haut du panneau gauche
  (avant le premier `panel-section`)
- **Comportement :** Ajoute la classe `.sidebar-hidden` sur `<aside id="viewer-sidebar">`,
  déclenchant une animation CSS `width → 0` + `opacity → 0` via une transition cubique-bezier
  (0.25s). Affiche simultanément le bouton flottant de réouverture.

#### Bouton de réouverture (flottant, bord gauche du canvas)
- **Élément HTML :** `<button id="btn-reopen-sidebar">` avec icône Lucide `panel-left-open`
- **Emplacement :** Positionné en `position: absolute` sur le bord gauche du `.viewer-canvas-container`,
  centré verticalement. Largeur 28px, bordures arrondies uniquement à droite pour un effet
  "tab" collé au bord du canvas.
- **Comportement :** Retire la classe `.sidebar-hidden`, restaurant l'animation inverse.
  Le bouton se rétracte automatiquement.
- **Micro-animation hover :** La largeur passe de 28px à 34px sur hover, avec changement de couleur.

#### CSS `.sidebar-topbar`
- Nouvelle barre de titre minimale en haut de la sidebar, avec un label "CONTROLS" en petit
  texte uppercase et le bouton flèche aligné à droite.
- Fond légèrement assombri via `color-mix` pour différencier visuellement la topbar des panels.

#### Compatibilité iframe
- La logique `_bindSidebarCollapse()` coexiste sans conflit avec le mécanisme iframe existant
  (qui toggle aussi `.sidebar-hidden`). Les deux chemins modifient la même classe CSS.
