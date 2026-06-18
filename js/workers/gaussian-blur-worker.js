/* ============================================================
   Gaussian Blur Web Worker — Flou gaussien 2D par slice Z
   ============================================================
   
   Algorithme : approximation O(n) du noyau gaussien par 3 passes
   de box blur (horizontal + vertical), méthode d'Ivan Googolplex.
   Référence : http://blog.ivank.net/fastest-gaussian-blur.html
   
   Précision mathématique :
   - σ gaussien → 3 rayons de box via _boxesForGauss(σ, 3)
   - Chaque passe de box blur est une convolution avec un noyau 
     rectangulaire de largeur (2r+1), implémentée comme moyenne 
     glissante en O(largeur) par ligne/colonne.
   - 3 passes de box blur → convergence vers le noyau gaussien 
     (théorème de la limite centrale).
   ============================================================ */

'use strict';

self.onmessage = function(e) {
  const { type, width, height, depth, sigma, taskId } = e.data;
  if (type !== 'blur') return;

  try {
    // Le Transferable convertit le Uint8Array en ArrayBuffer côté Worker.
    // Il faut le ré-envelopper en Uint8Array pour l'indexation.
    const rawData = new Uint8Array(e.data.rawData);

    const sliceSize = width * height;
    const result = new Uint8Array(rawData.length);

    if (sigma <= 0.1) {
      // σ ≈ 0 : pas de blur, copie directe
      result.set(rawData);
      self.postMessage({ type: 'result', blurredData: result, taskId }, [result.buffer]);
      return;
    }

    // Pré-calcul des 3 rayons de box blur pour ce σ
    const boxes = _boxesForGauss(sigma, 3);

    // Buffers de travail réutilisés entre les slices (Float32 pour la précision)
    const src = new Float32Array(sliceSize);
    const dst = new Float32Array(sliceSize);

    for (let zi = 0; zi < depth; zi++) {
      const offset = zi * sliceSize;

      // Copie de la slice en float pour la précision des moyennes glissantes
      for (let i = 0; i < sliceSize; i++) {
        src[i] = rawData[offset + i];
      }

      // 3 passes : box blur H → V (alternance src ↔ dst)
      for (let pass = 0; pass < 3; pass++) {
        const radius = boxes[pass];
        _boxBlurH(src, dst, width, height, radius);
        _boxBlurV(dst, src, width, height, radius);
      }

      // Re-quantification en uint8 avec clamp [0, 255]
      for (let i = 0; i < sliceSize; i++) {
        result[offset + i] = src[i] < 0 ? 0 : (src[i] > 255 ? 255 : (src[i] + 0.5) | 0);
      }

      // Notification de progression toutes les 20 slices
      if (zi % 20 === 0) {
        self.postMessage({ type: 'progress', taskId, progress: zi / depth });
      }
    }

    // Transfert du résultat (zero-copy via Transferable)
    self.postMessage({ type: 'result', blurredData: result, taskId, chunkIndex: e.data.chunkIndex ?? 0 }, [result.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', taskId, message: err.message });
  }
};

/**
 * Calcule les 3 rayons de box blur qui approximent un noyau gaussien de σ donné.
 * Formule :  w_ideal = √(12σ²/n + 1)
 *            wl = floor(w_ideal) arrondi impair inférieur
 *            wu = wl + 2
 *            m = nombre de passes utilisant wl (les autres utilisent wu)
 * @param {number} sigma  Écart-type du noyau gaussien (en pixels)
 * @param {number} n      Nombre de passes (3 pour une bonne approximation)
 * @returns {number[]}    Tableau de n rayons de box blur
 */
function _boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round(
    (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4)
  );
  return Array.from({ length: n }, (_, i) => Math.floor((i < m ? wl : wu) / 2));
}

/**
 * Box blur horizontal — moyenne glissante en O(width) par ligne.
 * Opère sur un buffer mono-canal (Float32Array).
 */
function _boxBlurH(src, dst, w, h, r) {
  // BUG-014 : un grand σ donne r ≥ w/2 ; sans bornage, les trois sous-plages de la
  // moyenne glissante se chevauchent/s'inversent et lisent au-delà de la ligne
  // (jusque dans la ligne suivante, ou hors buffer sur la dernière ligne). On borne
  // le rayon effectif à la demi-largeur de ligne ; le chemin normal (r < w/2) est
  // inchangé. Pour w ≤ 2, r retombe à 0 → copie (pas de flou horizontal possible).
  if (r > ((w - 1) >> 1)) r = (w - 1) >> 1;
  if (r <= 0) { dst.set(src); return; }
  const iarr = 1.0 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    let ti = y * w, li = ti, ri = ti + r;
    const fv = src[ti], lv = src[ti + w - 1];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + j];
    for (let j = 0; j <= r; j++)     { val += src[ri] - fv;       dst[ti] = val * iarr; ri++; ti++; }
    for (let j = r + 1; j < w - r; j++) { val += src[ri] - src[li]; dst[ti] = val * iarr; ri++; li++; ti++; }
    for (let j = w - r; j < w; j++)  { val += lv - src[li];       dst[ti] = val * iarr; li++; ti++; }
  }
}

/**
 * Box blur vertical — moyenne glissante en O(height) par colonne.
 * Opère sur un buffer mono-canal (Float32Array).
 */
function _boxBlurV(src, dst, w, h, r) {
  // BUG-014 : même bornage que _boxBlurH, sur la hauteur de colonne (r ≥ h/2 ferait
  // lire/écrire au-delà de la dernière ligne). Chemin normal (r < h/2) inchangé.
  if (r > ((h - 1) >> 1)) r = (h - 1) >> 1;
  if (r <= 0) { dst.set(src); return; }
  const iarr = 1.0 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let ti = x, li = ti, ri = ti + r * w;
    const fv = src[ti], lv = src[ti + w * (h - 1)];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + j * w];
    for (let j = 0; j <= r; j++)     { val += src[ri] - fv;       dst[ti] = val * iarr; ri += w; ti += w; }
    for (let j = r + 1; j < h - r; j++) { val += src[ri] - src[li]; dst[ti] = val * iarr; ri += w; li += w; ti += w; }
    for (let j = h - r; j < h; j++) { val += lv - src[li];       dst[ti] = val * iarr; li += w; ti += w; }
  }
}
