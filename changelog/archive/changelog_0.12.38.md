# Changelog — Plateforme Web v0.12.38

**Date :** 2026-06-15

---

## [FIXED]

### Bug critique : volume 3D masqué après actualisation de la page (`#state=`)

**Fichier :** `js/pages/viewer.js` — fonction `_applyWorkspaceStateNow`

**Symptôme :** Lors d'un refresh de la page, le volume 3D se chargeait normalement
puis disparaissait dès la fin du chargement complet, ne laissant visible que la
première tranche du z-stack (slice 0). Pour retrouver le volume 3D, l'utilisateur
devait ouvrir manuellement le z-stack browser puis le refermer.

**Cause racine :** La restauration de l'état URL (`#state=`) appelait
`_zstackGoToSlice(0)` via un `setTimeout(80ms)` **même quand `zstackActive === false`**
dans l'état sauvegardé. La condition `viewerState.zstackSlice >= 0` était vraie
pour la valeur `0` (valeur par défaut), ce qui déclenchait
`VolumeViewer.setClipRange('z', lo, hi)` avec une plage très étroite (± 2 slices),
écrasant le clipping complet du volume et n'affichant qu'une mince tranche.

De plus, `_zstackShow(false)` était appelé systématiquement, même quand le z-stack
était fermé, entraînant un `resetClipping()` suivi immédiatement d'un
`setClipRange()` conflictuel via le `setTimeout`.

**Correction :** La logique de restauration du z-stack est désormais séparée en
deux branches distinctes :
- **`zstackActive === true`** : `_zstackShow(true)` est appelé normalement, puis
  la slice sauvegardée est restaurée si elle est `> 0`.
- **`zstackActive === false`** : Le panneau z-stack est simplement masqué (`zstack-hidden`),
  la rotation est déverrouillée et le clipping est réinitialisé à plein volume
  **sans** appeler `_zstackGoToSlice()`, évitant toute restriction de la plage d'affichage.
