# Plateforme Web — v1.0.41

## [FIXED]
- **BUG-014** — `js/workers/gaussian-blur-worker.js` : le flou gaussien par 3 passes de box blur (moyenne glissante O(n)) supposait `w > 2r` (resp. `h > 2r`). Le rayon `r` issu de `_boxesForGauss(σ)` n'était jamais borné contre les dimensions de la slice : pour un grand σ sur une slice étroite (σ ≈ 40 sur un canal 64 px → `r ≈ 20 ≥ w/2`), les trois sous-plages de la moyenne glissante (`[0,r]` / `[r+1,w-r-1]` / `[w-r,w-1]`) se chevauchaient/s'inversaient et lisaient/écrivaient **au-delà de la ligne** (jusque dans la ligne suivante pour les lignes internes, hors buffer sur la dernière ligne) → moyennes fausses et débordement. Correctif : bornage du rayon effectif par axe (`r = min(r, (w-1)>>1)` dans `_boxBlurH`, `(h-1)>>1` dans `_boxBlurV`) avant les passes. Le chemin normal (`r < w/2`) est strictement inchangé ; pour un axe ≤ 2 px, `r` retombe à 0 → copie directe (pas de flou possible sur cet axe).

## [TESTS]
- `tests/js/test_gaussian_blur_bounds.mjs` (nouveau) — pilote `self.onmessage` du worker dans un contexte `vm` (sans navigateur) : σ=30 sur 4×1 et σ=40 sur 64×1 ne lèvent pas et produisent des octets finis dans `[0,255]` ; non-régression d'un flou normal (8×8, σ=1.5) qui diffuse bien un voxel brillant ; assertions structurelles du bornage par axe.
