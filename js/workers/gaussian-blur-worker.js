/* ============================================================
   Gaussian Blur Web Worker — 2D in-plane Gaussian, applied slice by slice
   ============================================================

   What this filter is (and is not)
   - Each Z slice is blurred independently in X and Y. There is NO smoothing along Z:
     the volume is split into Z chunks across the worker pool, and the voxel spacing along
     Z is usually several times the in-plane spacing, so one isotropic sigma in voxels would
     not be isotropic in micrometres anyway. The result is an in-plane denoise.
   - sigma is expressed in voxels of the level of detail being displayed.

   Kernel
   A Gaussian of standard deviation sigma is separable: G(x,y) = g(x) g(y). The variance of a
   convolution of kernels is the sum of their variances, which is what the plan below uses.
   - sigma < SMALL_SIGMA: the exact sampled kernel  g(i) = exp(-i^2 / (2 sigma^2)) / Z,
     i = -R..R, R = ceil(3 sigma), normalised to sum 1 (a box approximation cannot represent
     such a small variance: the odd box widths 1, 3, 5 give variances 0, 2/3, 2).
   - sigma >= SMALL_SIGMA: three box passes of odd width w (variance (w^2 - 1) / 12 each,
     computed in O(1) per pixel by a running sum, the central-limit approximation of a
     Gaussian), then ONE short exact Gaussian pass that supplies the variance the quantised
     box widths cannot reach:
         sigma^2 = sum_i (w_i^2 - 1) / 12  +  sigma_residual^2
     The box widths are the largest whose variance does not exceed sigma^2, so
     sigma_residual^2 >= 0 and the total variance equals sigma^2 for every sigma (a plain
     3-box scheme is up to 9 % short at sigma = 2).
   Image borders replicate the edge pixel.
   ============================================================ */

'use strict';

// Below this the 3-box scheme cannot reach the requested variance (3 boxes of width 3 already
// carry variance 3, i.e. sigma = 1.732), so the exact kernel is used on its own.
const SMALL_SIGMA = 1.8;
const MAX_GAUSS_RADIUS = 64;

self.onmessage = function(e) {
  const { type, width, height, depth, sigma, taskId } = e.data;
  if (type !== 'blur') return;
  const chunkIndex = e.data.chunkIndex ?? 0;

  try {
    // Le Transferable convertit le Uint8Array en ArrayBuffer côté Worker.
    // Il faut le ré-envelopper en Uint8Array pour l'indexation.
    const rawData = new Uint8Array(e.data.rawData);

    const sliceSize = width * height;
    const result = new Uint8Array(rawData.length);

    if (!(sigma > 0.05)) {
      // σ ≈ 0 (or not a number): no blur, direct copy
      result.set(rawData);
      self.postMessage({ type: 'result', blurredData: result, taskId, chunkIndex, effectiveSigma: 0 }, [result.buffer]);
      return;
    }

    const plan = _planKernel(sigma);

    // Working buffers reused between slices (Float32 for the running sums)
    let src = new Float32Array(sliceSize);
    let dst = new Float32Array(sliceSize);

    for (let zi = 0; zi < depth; zi++) {
      const offset = zi * sliceSize;

      for (let i = 0; i < sliceSize; i++) src[i] = rawData[offset + i];

      for (const r of plan.boxRadii) {
        _boxBlurH(src, dst, width, height, r);
        _boxBlurV(dst, src, width, height, r);
      }
      if (plan.gauss) {
        _gaussBlurH(src, dst, width, height, plan.gauss);
        _gaussBlurV(dst, src, width, height, plan.gauss);
      }

      // Re-quantisation to uint8 with clamp [0, 255]
      for (let i = 0; i < sliceSize; i++) {
        result[offset + i] = src[i] < 0 ? 0 : (src[i] > 255 ? 255 : (src[i] + 0.5) | 0);
      }

      if (zi % 20 === 0) {
        self.postMessage({ type: 'progress', taskId, progress: zi / depth });
      }
    }

    self.postMessage({ type: 'result', blurredData: result, taskId, chunkIndex, effectiveSigma: plan.effectiveSigma }, [result.buffer]);
  } catch (err) {
    // chunkIndex lets the host fail exactly the task this chunk belongs to
    self.postMessage({ type: 'error', taskId, chunkIndex, message: err.message });
  }
};

/**
 * Normalised sampled Gaussian kernel of standard deviation `sigma`.
 * @returns {{radius:number, weights:Float32Array}}  weights[i + radius] for i = -radius..radius
 */
function _gaussianKernel(sigma) {
  const radius = Math.min(MAX_GAUSS_RADIUS, Math.max(1, Math.ceil(3 * sigma)));
  const weights = new Float32Array(2 * radius + 1);
  const k = -1 / (2 * sigma * sigma);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(i * i * k);
    weights[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return { radius, weights };
}

/**
 * Decide the passes that realise a Gaussian of standard deviation `sigma`.
 * @returns {{boxRadii:number[], gauss:({radius,weights}|null), effectiveSigma:number}}
 */
function _planKernel(sigma) {
  if (sigma < SMALL_SIGMA) {
    return { boxRadii: [], gauss: _gaussianKernel(sigma), effectiveSigma: sigma };
  }
  const n = 3;
  const target = sigma * sigma;
  const boxVar = w => (w * w - 1) / 12;
  // Largest odd width with n * variance <= sigma^2   <=>   w^2 <= 12 sigma^2 / n + 1
  let wl = Math.floor(Math.sqrt(12 * target / n + 1));
  if (wl % 2 === 0) wl--;
  if (wl < 3) wl = 3;
  const wu = wl + 2;
  // How many of the n passes can use the wider box without exceeding the target variance
  let k = 0;
  while (k < n && (n - (k + 1)) * boxVar(wl) + (k + 1) * boxVar(wu) <= target) k++;
  const widths = [];
  for (let i = 0; i < n; i++) widths.push(i < k ? wu : wl);
  const boxTotal = widths.reduce((s, w) => s + boxVar(w), 0);
  const residual = Math.max(0, target - boxTotal);
  const residualSigma = Math.sqrt(residual);
  return {
    boxRadii: widths.map(w => (w - 1) >> 1),
    gauss: residualSigma > 0.05 ? _gaussianKernel(residualSigma) : null,
    effectiveSigma: Math.sqrt(boxTotal + (residualSigma > 0.05 ? residualSigma * residualSigma : 0))
  };
}

/**
 * Box blur horizontal — running sum, O(width) per row, edge pixels replicated.
 * Any radius is valid: indices are clamped, so a radius wider than the row cannot read
 * outside it.
 */
function _boxBlurH(src, dst, w, h, r) {
  if (r <= 0) { dst.set(src); return; }
  const inv = 1.0 / (r + r + 1);
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += src[row + (j < 0 ? 0 : (j > last ? last : j))];
    dst[row] = sum * inv;
    for (let x = 1; x < w; x++) {
      const add = x + r, sub = x - r - 1;
      sum += src[row + (add > last ? last : add)] - src[row + (sub < 0 ? 0 : sub)];
      dst[row + x] = sum * inv;
    }
  }
}

/**
 * Box blur vertical — running column sums, walked row by row so memory is read
 * contiguously (a column-by-column walk strides by the row width and misses the cache).
 */
function _boxBlurV(src, dst, w, h, r) {
  if (r <= 0) { dst.set(src); return; }
  const inv = 1.0 / (r + r + 1);
  const last = h - 1;
  const acc = new Float32Array(w);
  for (let j = -r; j <= r; j++) {
    const o = (j < 0 ? 0 : (j > last ? last : j)) * w;
    for (let x = 0; x < w; x++) acc[x] += src[o + x];
  }
  for (let x = 0; x < w; x++) dst[x] = acc[x] * inv;
  for (let y = 1; y < h; y++) {
    const addRow = (y + r > last ? last : y + r) * w;
    const subRow = (y - r - 1 < 0 ? 0 : y - r - 1) * w;
    const out = y * w;
    for (let x = 0; x < w; x++) {
      acc[x] += src[addRow + x] - src[subRow + x];
      dst[out + x] = acc[x] * inv;
    }
  }
}

/** Exact horizontal convolution with `kernel`, edge pixels replicated. */
function _gaussBlurH(src, dst, w, h, kernel) {
  const { radius, weights } = kernel;
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -radius; j <= radius; j++) {
        const xi = x + j;
        s += weights[j + radius] * src[row + (xi < 0 ? 0 : (xi > last ? last : xi))];
      }
      dst[row + x] = s;
    }
  }
}

/** Exact vertical convolution with `kernel`: one weighted row accumulation per tap. */
function _gaussBlurV(src, dst, w, h, kernel) {
  const { radius, weights } = kernel;
  const last = h - 1;
  for (let y = 0; y < h; y++) {
    const out = y * w;
    for (let x = 0; x < w; x++) dst[out + x] = 0;
    for (let j = -radius; j <= radius; j++) {
      const yi = y + j;
      const o = (yi < 0 ? 0 : (yi > last ? last : yi)) * w;
      const wt = weights[j + radius];
      for (let x = 0; x < w; x++) dst[out + x] += wt * src[o + x];
    }
  }
}
