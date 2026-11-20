/* ij-proc-enh.js — package P-enh (enhancement and noise): Add Noise / Add Specified Noise / Salt and Pepper,
 * Enhance Local Contrast (CLAHE), Tubeness, Frangi Vesselness.
 *
 * Classic script, page AND worker (ij-worker.js loads it in its own try/catch: a failure here disables the
 * package's commands, it never takes the Advanced view down). Pure: no DOM, no engine globals besides the registry
 * and IJShared. Every operation is a spec of IJOpRegistry (ij-core.js).
 *
 *   addNoise       pixel   ij.process.{Byte,Short,Float}Processor.noise (whole, seeded: one JavaRandom per run, the
 *                          channels of a run take values from ONE stream in index order)
 *   saltAndPepper  pixel   ij.plugin.filter.SaltAndPepper.add (8-bit)
 *   clahe          pixel   Zuiderveld 1994 contrast limited adaptive histogram equalisation (the Fiji command
 *                          "Enhance Local Contrast (CLAHE)"; written from the paper, calibrated on the Fiji reference
 *                          outputs of tests/fixtures/ij-wave3/fiji/clahe)
 *   claheMask      compute reads the 8-bit mask image of the CLAHE dialog (the clipboard of a pixel op is its params)
 *   enhDataRange   compute the exact data range of a channel (what resetMinAndMax() makes the display range)
 *   tubeness       newdoc  Sato et al. 1998 line filter as the Fiji command Tubeness (VIB) returns it in 2D
 *   frangi         newdoc  net.imagej.ops.filter.vesselness.DefaultFrangi (imagej-ops 2.2.0, BSD-2) + the command
 *                          net.imagej.ops.commands.filter.FrangiVesselness (one plane per scale)
 *
 * IJHessian is the shared engine of Tubeness and Frangi: separable Gaussian smoothing of a BAND of rows (mirror
 * boundary, the kernel radius is the apron), so the working memory is a few bands, never a plane of doubles.
 *
 * Java semantics: the references accumulate in float where the Java does (Gauss3's FloatConvolverRealType); every such
 * product and sum is rounded with Math.fround in the order of the Java code. Where a result is computed in double
 * and stored as float the port rounds once at the store. Each port states its tolerance in tests/js/test_ij_enh*.mjs.
 */
(function (root) {
  'use strict';

  const REG = root.IJOpRegistry;
  if (!REG) return;
  const fround = Math.fround;
  const sqrt = Math.sqrt, exp = Math.exp, abs = Math.abs;

  function ijError(code, message) { const e = new Error(message || code); e.code = code; return e; }
  const bad = (msg) => ijError('IJ_BAD_ARGS', msg);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

  /* Java's (int) of a double: NaN -> 0, saturating, truncating toward zero. */
  function jint(d) {
    if (d !== d) return 0;
    if (d >= 2147483647) return 2147483647;
    if (d <= -2147483648) return -2147483648;
    return d < 0 ? Math.ceil(d) : Math.floor(d);
  }
  /* Java's Math.round(double): floor(x + 1/2) computed without the rounding of the addition. */
  function jround(x) {
    if (x !== x) return 0;
    const f = Math.floor(x);
    return x - f >= 0.5 ? f + 1 : f;
  }
  const typedFor = (bd, n) => (bd === 8 ? new Uint8Array(n) : (bd === 16 ? new Uint16Array(n) : new Float32Array(n)));
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const bytesOf = (bd) => (bd === 8 ? 1 : bd === 16 ? 2 : 4);

  /* Cooperative progress for a pixel op: tick(f) at most every ~40 ms, check() (cancel) otherwise. Never changes a result. */
  function ticker(ctx) {
    let last = nowMs();
    return async function (frac) {
      if (!ctx) return;
      const t = nowMs();
      if (t - last >= 40) { last = t; if (ctx.tick) await ctx.tick(Math.min(1, Math.max(0, frac))); } else if (ctx.check) ctx.check();
    };
  }
  /* The same for a newdoc / compute op (io). */
  function ioTicker(io, stepKey) {
    let last = nowMs();
    return async function (frac) {
      if (!io) return;
      const t = nowMs();
      if (t - last >= 40) { last = t; if (io.tick) await io.tick(Math.min(1, Math.max(0, frac)), stepKey); } else if (io.check) io.check();
    };
  }

  // ------------------------------------------------------------------------------------------------------------
  // Add Noise, Add Specified Noise
  // ------------------------------------------------------------------------------------------------------------
  /* ij.plugin.filter.Filters: "add" → ip.noise(25.0); "noise" → ip.noise(sd) with the dialog's Standard Deviation.
   * ImageProcessor keeps ONE static generator:
   *     protected static double seed = Double.NaN;  protected static Random rnd;
   * and every noise() starts with (ByteProcessor.java:872-880, ShortProcessor.java:1178-1185, FloatProcessor.java:741-747)
   *     if (rnd==null) rnd = new Random();
   *     if (!Double.isNaN(seed)) rnd.setSeed((int)seed);
   *     seed = Double.NaN;
   * so a seed is applied by the first call only and the following calls (the next channel of a run) go on with the same
   * stream. Filters has no PARALLELIZE_STACKS, the channels of one run are processed one after the other: ONE
   * JavaRandom per run, seeded with (int)seed, shared by the channels in index order (the stream cannot be split, so
   * the op is `whole` and does not preview).
   *   Byte:   do { ran = (int)Math.round(rnd.nextGaussian()*standardDeviation); v = (pixels[i] & 0xff) + ran;
   *               inRange = v>=0 && v<=255; if (inRange) pixels[i] = (byte)v; } while (!inRange);
   *   Short:  the same with 0xffff / 65535 (then resetMinAndMax(), done by the command as a display change)
   *   Float:  float RandomBrightness = (float)(rnd.nextGaussian()*standardDeviation);
   *           pixels[i] = pixels[i] + RandomBrightness;   (float addition; then resetMinAndMax())
   * The rows of the selection's bounding box are visited row-major (for y in roiY.., for x in roiX..), then the
   * runner puts back the pixels outside the mask (SUPPORTS_MASKING: the engine's mask pass). */
  const streams = new WeakMap();   // params object (one per run) -> { rng }
  function streamOf(p) {
    let s = streams.get(p);
    if (!s) {
      if (!root.IJShared || !root.IJShared.JavaRandom) throw ijError('IJ_MODULE_MISSING', 'IJShared.JavaRandom');
      const rng = new root.IJShared.JavaRandom(0);
      rng.setSeed(jint(p.seed));   // rnd.setSeed((int)seed)
      s = { rng };
      streams.set(p, s);
    }
    return s;
  }

  const NOISE_MAX_SD = 100000;
  const NOISE_CHECK_DRAWS = 4096;   // a power of two
  REG.define('addNoise', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', preview: false, display: '16/32',
    validate(p) {
      if (!isNum(p.seed) || !Number.isInteger(p.seed)) throw bad('seed');
      if (!isNum(p.sd) || p.sd < 0 || p.sd > NOISE_MAX_SD) throw bad('sd');
    },
    scratchBytes: (info) => (info.region ? info.region.w * info.region.h : info.width * info.height) * bytesOf(info.bitDepth) * 2,
    prepare(view, c, p, ctx) {
      const bd = view.bitDepth, sd = p.sd, max = bd === 8 ? 255 : 65535;
      const stream = streamOf(p);
      const tk = ticker(ctx);
      return {
        whole: true, apron: { x: 0, y: 0 },
        async fn(src) {
          const d = src.data, w = src.width, h = src.height;
          const o = d.slice();
          const rng = stream.rng;
          let draws = 0;
          for (let y = 0; y < h; y++) {
            let i = y * w;
            if (bd === 32) {
              for (let x = 0; x < w; x++, i++) o[i] = fround(d[i] + fround(rng.nextGaussian() * sd));
            } else {
              for (let x = 0; x < w; x++, i++) {
                let v;
                // the redraw loop has no bound in ImageJ: at a large sd one pixel takes ~sd * 2.5 / range draws, so cancel and progress are
                // served every NOISE_CHECK_DRAWS draws (a counter, not a clock: the stream and the result are not touched)
                do {
                  v = d[i] + jint(jround(rng.nextGaussian() * sd));
                  if ((++draws & (NOISE_CHECK_DRAWS - 1)) === 0) await tk((y + x / w) / h);
                } while (v < 0 || v > max);
                o[i] = v;
              }
            }
            await tk((y + 1) / h);
          }
          return o;
        }
      };
    }
  });

  /* ij.plugin.filter.SaltAndPepper (SaltAndPepper.java:12-14 setup = DOES_8G+DOES_8C+SUPPORTS_MASKING; rand and add at :20-42):
   *     public int rand(int min, int max) { return min + r.nextInt(max-min); }
   *     Rectangle roi = ip.getRoi(); int n = (int)(percent*roi.width*roi.height);
   *     for (int i=0; i<n/2; i++) { rx = rand(xmin, xmax); ry = rand(ymin, ymax); pixels[ry*width+rx] = (byte)255;
   *                                 rx = rand(xmin, xmax); ry = rand(ymin, ymax); pixels[ry*width+rx] = (byte)0; }
   * Pixels hit outside the mask are put back by the runner (the engine's mask pass). The command runs add(ip, 0.05). */
  REG.define('saltAndPepper', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: false, bitDepths: [8], preview: false,
    validate(p) {
      if (!isNum(p.seed) || !Number.isInteger(p.seed)) throw bad('seed');
      if (!isNum(p.percent) || !(p.percent > 0) || p.percent > 1) throw bad('percent');
    },
    scratchBytes: (info) => (info.region ? info.region.w * info.region.h : info.width * info.height) * 2,
    prepare(view, c, p, ctx) {
      const stream = streamOf(p);
      const tk = ticker(ctx);
      return {
        whole: true, apron: { x: 0, y: 0 },
        async fn(src) {
          const w = src.width, h = src.height;
          const o = src.data.slice();
          const r = stream.rng;
          const n = jint(p.percent * w * h);
          const half = n >> 1;                       // n/2 (Java int division, n >= 0)
          for (let i = 0; i < half; i++) {
            let rx = r.nextInt(w), ry = r.nextInt(h);   // min + r.nextInt(max-min) in the crop's frame
            o[ry * w + rx] = 255;
            rx = r.nextInt(w); ry = r.nextInt(h);
            o[ry * w + rx] = 0;
            if ((i & 4095) === 4095) await tk(i / half);
          }
          return o;
        }
      };
    }
  });

  /* ImageProcessor.resetMinAndMax() after a 16 / 32-bit noise: the exact data range of the whole image
   * (findMinAndMax: a float ignores NaN and the infinities). A compute helper of the package, not a tool. */
  REG.define('enhDataRange', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'ignore', preview: false,
    validate() {},
    scratchBytes: () => 0,
    async run(view, p, roi, io) {
      const c = Number.isInteger(io && io.channel) ? io.channel : (view.active || 0);
      if (!(c >= 0 && c < view.channels.length)) throw bad('channel');
      const d = view.channels[c].data;
      const isF = d instanceof Float32Array;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (isF && v - v !== 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) { min = 0; max = 0; }
      return { min, max, bitDepth: view.bitDepth };
    }
  });

  // ------------------------------------------------------------------------------------------------------------
  // CLAHE — Enhance Local Contrast
  // ------------------------------------------------------------------------------------------------------------
  /* Zuiderveld, "Contrast limited adaptive histogram equalization", Graphics Gems IV (1994), with the choices the Fiji
   * command makes, recovered from its reference outputs (tests/fixtures/ij-wave3/fiji/clahe; the plugin's code is
   * GPL and was never read):
   *   - 16 / 32-bit images go through the 8-bit view of the channel, ImageProcessor.convertToByte(true):
   *       16-bit  TypeConverter.convertShortToByte: min=(int)ip.getMin(), max=(int)ip.getMax() (the display range,
   *               rounded), scale = 256.0/(max-min+1); value = (v-min)<0 ? 0 : (v-min); (int)(value*scale+0.5), at most 255
   *       32-bit  FloatProcessor.create8BitImage: scale = 255.0/(max-min); (int)((v-min)*scale+0.5), at most 255
   *     and the result is the ORIGINAL value scaled by what the 8-bit equalisation did: out = v * eq8 / in8
   *     (rounded and clamped for 16-bit, a float for 32-bit; in8 = 0 leaves the pixel as it is). The fixtures show
   *     out/v constant over each 8-bit level, which is exactly this rule.
   *   - the window of a pixel is the square of radius r = (blocksize-1)/2 centred on it, clipped to the image;
   *     bin(v) = round(v (bins-1) / 255) (the 8-bit level scaled onto the histogram, fitted on the 64-bin Fiji outputs;
   *     the old (v*bins)>>8 missed them by 2.4 .. 3.5 levels, this one by 0.35 .. 0.6, and 256 / 128 bins are unchanged);  limit = (int)(slope*N/bins + 0.5), N = pixels of the window;
   *   - clipping: repeat { excess = sum(max(h-limit,0)); h = min(h,limit); h += excess/bins (integer division);
   *     m = excess % bins; if (m != 0) { s = bins/m; for (i = s-1; i < bins; i += s) h[i]++ } }
   *     until two successive excesses are equal (the excess is never lost: the total grows by the remainder step);
   *   - transfer: out8 = (int)(255*(cdf[bin]-hmin)/(cdf[bins-1]-hmin) + 0.5), hmin = the first non-empty clipped bin.
   * "fast": the transfer is evaluated at the nodes of a grid with a step of 4 pixels (the last row / column is a node
   * too), each node with the exact window of its own position, and a pixel takes the bilinear interpolation of the
   * transfer values of its four nodes. Fiji's own fast mode is not published; this one stays within the tolerance of
   * PLAN-wave3 §6.3 of the Fiji fast outputs (mean |d| < 1 grey level, > 95 % within 2) at the 256 bins default and
   * costs 1/16 of the exact one.
   * The mask (an 8-bit image of the same size): only pixels with a non-zero mask value enter the histograms and only
   * those pixels are changed. A selection is not used. UNVERIFIED against Fiji: no fixture
   * records the command with a selection (its code was never read), so "ignored, the mask is the way to restrict" is the
   * documented choice, not a measured behaviour; a FijiRefs case with a rectangle and an oval ROI on blobs would settle it. */
  const CLAHE_STRIDE = 4;
  const CLAHE_SLOW_MAX_PIXELS = 16 * 1000 * 1000;

  function claheParams(p, info) {
    if (!isInt(p.blocksize) || p.blocksize < 3 || p.blocksize > 100001) throw bad('blocksize');
    if (!isInt(p.bins) || p.bins < 2 || p.bins > 256) throw bad('bins');
    if (!isNum(p.slope) || p.slope < 1 || p.slope > 100) throw bad('slope');
    if (typeof p.fast !== 'boolean') throw bad('fast');
    if (!p.fast && info && info.width * info.height > CLAHE_SLOW_MAX_PIXELS) throw ijError('IJ_ENH_CLAHE_SLOW_TOO_LARGE', 'slow CLAHE above 16 Mpx');
  }

  /* 8-bit view of a channel (convertToByte(true)); the 8-bit image is its own view. */
  function claheQuantize(data, bd, mn, mx, check) {
    if (bd === 8) return data;
    const n = data.length, q = new Uint8Array(n);
    if (bd === 16) {
      const lo = jround(mn), hi = jround(mx);
      const scale = 256.0 / (hi - lo + 1);
      for (let i = 0; i < n; i++) {
        if (check && (i & 0xfffff) === 0) check();
        let v = data[i] - lo;
        if (v < 0) v = 0;
        v = jint(v * scale + 0.5);
        q[i] = v > 255 ? 255 : v;
      }
    } else {
      const lo = fround(mn), hi = fround(mx);
      const scale = 255.0 / (hi - lo);
      for (let i = 0; i < n; i++) {
        if (check && (i & 0xfffff) === 0) check();
        let v = data[i] - lo;
        if (v < 0.0) v = 0.0;
        v = jint(v * scale + 0.5);
        q[i] = v > 255 ? 255 : v;
      }
    }
    return q;
  }

  /* The histogram work of one CLAHE run: clip + redistribute, and the transfer of one bin or of every bin. */
  function makeEqualizer(bins, slope) {
    const hist = new Int32Array(bins), h2 = new Int32Array(bins);
    const binOf = new Uint16Array(256);
    for (let v = 0; v < 256; v++) binOf[v] = ((v * (bins - 1) * 2 + 255) / 510) | 0;   // round(v (bins-1) / 255)
    function clip(N) {
      const limit = Math.floor(slope * N / bins + 0.5);
      h2.set(hist);
      let prev = -1;
      for (let it = 0; it < 200; it++) {
        let cl = 0;
        for (let i = 0; i < bins; i++) { const d = h2[i] - limit; if (d > 0) { cl += d; h2[i] = limit; } }
        const dd = Math.floor(cl / bins), m = cl % bins;
        if (dd) for (let i = 0; i < bins; i++) h2[i] += dd;
        if (m !== 0) { const s = Math.floor(bins / m); for (let i = s - 1; i < bins; i += s) h2[i]++; }
        if (cl === prev || cl === 0) break;
        prev = cl;
      }
    }
    return {
      hist, binOf,
      /* transfer value (0..255, a double) of the bin `b` of the window now in `hist` (N pixels); null = undefined */
      one(N, b) {
        clip(N);
        let cm = 0, c = 0, cb = 0, total = 0;
        for (let i = 0; i < bins; i++) {
          const v = h2[i];
          if (cm === 0 && v !== 0) cm = v;
          c += v;
          if (i === b) cb = c;
        }
        total = c;
        const den = total - cm;
        return den > 0 ? (cb - cm) / den * 255 : null;
      },
      /* the whole transfer curve into out[0..bins) (a Float64Array: the running sum reaches N); false when it is undefined */
      all(N, out) {
        clip(N);
        let cm = 0, c = 0;
        for (let i = 0; i < bins; i++) { const v = h2[i]; if (cm === 0 && v !== 0) cm = v; c += v; out[i] = c; }
        const den = c - cm;
        if (!(den > 0)) return false;
        for (let i = 0; i < bins; i++) out[i] = (out[i] - cm) / den * 255;
        return true;
      }
    };
  }

  /* hist += sign * (the pixels of column x, rows y0..y1-1, that the mask lets in) */
  function colAdd(q, mask, W, x, y0, y1, hist, binOf, sign) {
    let cnt = 0;
    if (mask) { for (let y = y0; y < y1; y++) { const i = y * W + x; if (mask[i] !== 0) { hist[binOf[q[i]]] += sign; cnt++; } } }
    else { for (let y = y0; y < y1; y++) hist[binOf[q[y * W + x]]] += sign; cnt = y1 - y0; }
    return cnt;
  }

  /* 16 / 32-bit: the original value scaled by what the 8-bit equalisation did; 8-bit: the equalised level itself. */
  function claheFinish(bd, v, in8, out8) {
    if (bd === 8) return out8;
    if (in8 === 0) return v;
    const r = v * out8 / in8;
    if (bd === 16) { const k = Math.floor(r + 0.5); return k < 0 ? 0 : (k > 65535 ? 65535 : k); }
    return fround(r);
  }

  async function claheSlow(q, mask, full, rect, bins, slope, r, tk) {
    const W = full.width, H = full.height, bd = full.bitDepth, src = full.data;
    const eq = makeEqualizer(bins, slope);
    const out = typedFor(bd, rect.w * rect.h);
    const hist = eq.hist, binOf = eq.binOf;
    for (let yy = 0; yy < rect.h; yy++) {
      const y = rect.y + yy;
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      hist.fill(0);
      let N = 0, xa = 0, xb = 0;                    // the window of the previous x is columns xa..xb-1
      for (let xx = 0; xx < rect.w; xx++) {
        const x = rect.x + xx;
        const nx0 = Math.max(0, x - r), nx1 = Math.min(W, x + r + 1);
        if (xx === 0) { for (let c = nx0; c < nx1; c++) N += colAdd(q, mask, W, c, y0, y1, hist, binOf, 1); }
        else {
          for (let c = xa; c < nx0; c++) N -= colAdd(q, mask, W, c, y0, y1, hist, binOf, -1);
          for (let c = xb; c < nx1; c++) N += colAdd(q, mask, W, c, y0, y1, hist, binOf, 1);
        }
        xa = nx0; xb = nx1;
        const i = y * W + x, v = src[i], in8 = q[i];
        if (mask && mask[i] === 0) { out[yy * rect.w + xx] = v; continue; }
        const t = eq.one(N, binOf[in8]);
        out[yy * rect.w + xx] = t === null ? v : claheFinish(bd, v, in8, Math.floor(t + 0.5));
        if ((xx & 255) === 255) await tk((yy + xx / rect.w) / rect.h);
      }
      await tk((yy + 1) / rect.h);
    }
    return out;
  }

  /* The node coordinates of a grid with the given step along an axis of n pixels: 0, step, 2*step ... and n-1. */
  function nodeAxis(n, step) {
    const p = [];
    for (let i = 0; i < n; i += step) p.push(i);
    if (p[p.length - 1] !== n - 1) p.push(n - 1);
    return p;
  }

  async function claheNodeRow(q, mask, W, H, bins, slope, r, xs, cy, eq, tk, spare, base) {
    const nodes = xs.length;
    // a row evicted from the cache lends its arrays (a node row is ~1 MB: allocating one per row of nodes churns the heap)
    const tab = spare ? spare.tab : new Float32Array(nodes * bins);
    const ok = spare ? spare.ok : new Uint8Array(nodes);
    if (spare) { tab.fill(0); ok.fill(0); }
    const hist = eq.hist, binOf = eq.binOf, tmp = new Float64Array(bins);
    const y0 = Math.max(0, cy - r), y1 = Math.min(H, cy + r + 1);
    hist.fill(0);
    let N = 0, xa = 0, xb = 0;
    for (let i = 0; i < nodes; i++) {
      const x = xs[i];
      const nx0 = Math.max(0, x - r), nx1 = Math.min(W, x + r + 1);
      if (i === 0) { for (let c = nx0; c < nx1; c++) N += colAdd(q, mask, W, c, y0, y1, hist, binOf, 1); }
      else {
        for (let c = xa; c < nx0; c++) N -= colAdd(q, mask, W, c, y0, y1, hist, binOf, -1);
        for (let c = xb; c < nx1; c++) N += colAdd(q, mask, W, c, y0, y1, hist, binOf, 1);
      }
      xa = nx0; xb = nx1;
      if (N > 0 && eq.all(N, tmp)) { tab.set(tmp, i * bins); ok[i] = 1; }
      if ((i & 63) === 63) await tk(base);   // the fraction the pass has reached: the bar never steps back
    }
    return { tab, ok };
  }

  async function claheFast(q, mask, full, rect, bins, slope, r, tk, st) {
    const W = full.width, H = full.height, bd = full.bitDepth, src = full.data;
    const eq = st.eq || (st.eq = makeEqualizer(bins, slope));
    const xs = st.xs || (st.xs = nodeAxis(W, CLAHE_STRIDE));
    const ys = st.ys || (st.ys = nodeAxis(H, CLAHE_STRIDE));
    if (!st.rows) st.rows = new Map();
    const getRow = async (j, base) => {
      let row = st.rows.get(j);
      if (!row) {
        let spare = null;
        for (const k of Array.from(st.rows.keys())) if (k < j - 1) { spare = st.rows.get(k); st.rows.delete(k); }
        row = await claheNodeRow(q, mask, W, H, bins, slope, r, xs, ys[j], eq, tk, spare, base);
        st.rows.set(j, row);
      }
      return row;
    };
    // the node interval of every x
    if (!st.xi) {
      st.xi = new Int32Array(W); st.xf = new Float64Array(W);
      let i = 0;
      for (let x = 0; x < W; x++) {
        while (i + 1 < xs.length - 1 && xs[i + 1] <= x) i++;
        if (xs.length === 1) { st.xi[x] = 0; st.xf[x] = 0; } else { st.xi[x] = i; st.xf[x] = (x - xs[i]) / (xs[i + 1] - xs[i]); }
      }
    }
    const out = typedFor(bd, rect.w * rect.h);
    const xi = st.xi, xf = st.xf;
    let j = 0;
    for (let yy = 0; yy < rect.h; yy++) {
      const y = rect.y + yy;
      while (j + 1 < ys.length - 1 && ys[j + 1] <= y) j++;
      const two = ys.length > 1;
      const fy = two ? (y - ys[j]) / (ys[j + 1] - ys[j]) : 0;
      const base = yy / rect.h, ra = await getRow(j, base), rb = two ? await getRow(j + 1, base) : ra;
      for (let xx = 0; xx < rect.w; xx++) {
        const x = rect.x + xx, i = y * W + x, v = src[i], in8 = q[i];
        if (mask && mask[i] === 0) { out[yy * rect.w + xx] = v; continue; }
        const a = xi[x], a1 = xs.length > 1 ? a + 1 : a, fx = xf[x], b = binOf8(eq, in8);
        let t;
        if (ra.ok[a] && ra.ok[a1] && rb.ok[a] && rb.ok[a1]) {
          const t00 = ra.tab[a * bins + b], t01 = ra.tab[a1 * bins + b], t10 = rb.tab[a * bins + b], t11 = rb.tab[a1 * bins + b];
          t = (t00 * (1 - fx) + t01 * fx) * (1 - fy) + (t10 * (1 - fx) + t11 * fx) * fy;
          out[yy * rect.w + xx] = claheFinish(bd, v, in8, Math.floor(t + 0.5));
        } else out[yy * rect.w + xx] = v;
      }
      await tk((yy + 1) / rect.h);
    }
    return out;
  }
  const binOf8 = (eq, v) => eq.binOf[v];

  REG.define('clahe', {
    kind: 'pixel', version: 1, stack: 'ask', rgb: 'each', roi: 'ignore', preview: false,
    validate(p, info) { claheParams(p, info); },
    /* the 8-bit conversion of a 16 / 32-bit channel reads the display range, which is not journaled state */
    resolve(view, params, chans) {
      const p = Object.assign({}, params);
      if (view.bitDepth !== 8) {
        p.ranges = Object.assign({}, p.ranges);
        for (const c of chans) if (!p.ranges[c]) { const d = view.channels[c].display; p.ranges[c] = { min: d.min, max: d.max }; }
      }
      return p;
    },
    scratchBytes(info, p) {
      const n = info.width * info.height;
      const quant = info.bitDepth === 8 ? 0 : n;                  // the 8-bit view
      const nodes = p.fast ? Math.ceil(info.width / CLAHE_STRIDE + 1) * (p.bins || 256) * 4 * 3 : 0;   // up to three node rows
      return quant + nodes + 4 * (p.bins || 256) * 8;
    },
    prepare(view, c, p, ctx) {
      const bd = view.bitDepth, bins = p.bins, slope = p.slope, r = (p.blocksize - 1) >> 1;
      const tk = ticker(ctx);
      let mn = 0, mx = 255;
      if (bd !== 8) {
        const rg = p.ranges && p.ranges[c];
        if (rg && isNum(rg.min) && isNum(rg.max)) { mn = rg.min; mx = rg.max; } else { const d = ctx.range(c); mn = d.min; mx = d.max; }
        if (bd === 16 && jround(mn) === 0 && jround(mx) === 0) { const d = ctx.range(c); mn = d.min; mx = d.max; }   // setMinAndMax(0,0) = reset
        if (!(mx > mn) && bd === 32) { const d = ctx.range(c); mn = d.min; mx = d.max; }
      }
      const mask = p.mask && p.mask.length ? p.mask : null;
      // the caches of this channel's pass (the 8-bit view, the node rows) live as long as the prepared object
      let st = { src: null };
      return {
        apron: { x: 0, y: 0 },
        async region(full, rect) {
          if (mask && mask.length !== full.width * full.height) throw bad('mask size');
          if (st.src !== full.data) st = { src: full.data, q: claheQuantize(full.data, bd, mn, mx, ctx.check) };
          return p.fast ? claheFast(st.q, mask, full, rect, bins, slope, r, tk, st) : claheSlow(st.q, mask, full, rect, bins, slope, r, tk);
        }
      };
    }
  });

  /* The 8-bit mask image of the CLAHE dialog: 1 where the mask image is not zero. params { maskDocId }, docIds = [image, mask]. */
  REG.define('claheMask', {
    kind: 'compute', version: 1, stack: 'plane', rgb: 'gray', channels: 'one', roi: 'ignore', preview: false,
    validate(p) { if (p.maskDocId === undefined || p.maskDocId === null) throw bad('maskDocId'); },
    scratchBytes: (info) => info.width * info.height * 2,
    async run(view, p, roi, io) {
      const m = io.readDoc(p.maskDocId);
      if (m.width !== view.width || m.height !== view.height) throw ijError('IJ_ENH_MASK_SIZE', 'mask size');
      if (m.bitDepth !== 8) throw ijError('IJ_ENH_MASK_TYPE', 'mask must be 8-bit');
      const d = m.channels[0].data, o = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i++) o[i] = d[i] !== 0 ? 1 : 0;
      return { width: m.width, height: m.height, data: o };
    }
  });

  // ------------------------------------------------------------------------------------------------------------
  // IJHessian — Gaussian smoothing of bands of rows, shared by Tubeness and Frangi
  // ------------------------------------------------------------------------------------------------------------
  /* Mirror boundary without repeating the edge pixel (imglib2 OutOfBoundsMirrorFactory.Boundary.SINGLE; scipy
   * mode 'mirror'): -1 -> 1, n -> n-2; the period is 2(n-1). */
  function mirror(i, n) {
    if (n === 1) return 0;
    if (i >= 0 && i < n) return i;
    const p = 2 * (n - 1);
    let m = i % p;
    if (m < 0) m += p;
    return m < n ? m : p - m;
  }

  /* Normalised symmetric kernel (sum 1) of 2R+1 values. */
  function gaussKernel(sigma, R) {
    const k = new Float64Array(2 * R + 1);
    let s = 0;
    const two = 2 * sigma * sigma;
    for (let i = -R; i <= R; i++) { const v = exp(-(i * i) / two); k[R + i] = v; s += v; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  }

  /* imglib2 Gauss3.halfkernel(sigma): size = max(2, (int)(3 sigma + 0.5) + 1); k[i] = exp(-i^2/(2 sigma^2)); smoothEdge;
   * normalised so that the FULL kernel (mirrored) sums to 1. Returns the full symmetric kernel as float32 values (the
   * convolver stores the kernel as float[]) and its radius. */
  function gauss3Kernel(sigma) {
    const size = Math.max(2, jint(3 * sigma + 0.5) + 1);
    const half = new Float64Array(size);
    const two = 2 * sigma * sigma;
    half[0] = 1;
    for (let i = 1; i < size; i++) half[i] = exp(-(i * i) / two);
    // smoothEdge: blend the tail into a parabola
    let minVal = Number.MAX_VALUE, i = size;
    while (i > (size >> 1)) {
      i--;
      const v = half[i] / ((size - i) * (size - i));
      if (v < minVal) minVal = v; else { i++; break; }
    }
    for (let j = i + 1; j < size; j++) half[j] = minVal * ((size - j) * (size - j));
    // normalizeHalfkernel: sum = 2 * (0.5 k0 + sum k[1..]); k *= 1/sum
    let sum = 0.5 * half[0];
    for (let j = 1; j < size; j++) sum += half[j];
    sum *= 2;
    const f = 1 / sum;
    const R = size - 1;
    const k = new Float32Array(2 * R + 1);
    for (let j = 0; j < size; j++) { const v = fround(half[j] * f); k[R + j] = v; k[R - j] = v; }
    return { k, R };
  }

  /* A smoother over one plane: rows(first, last, dst, beat) writes the smoothed rows first..last (indices may lie outside
   * the image: row t is the mirror image of row mirror(t, H), which the smoothed image of a mirror-extended input
   * satisfies exactly) into dst (Float64Array, (last-first+1) * W). kx / ky = { k, R } | null (no smoothing along that
   * axis). beat(f), when given, is awaited about every 8 rows with the progress f of the call (0..1): the caller's cancel check
   * and progress report. float: the arithmetic of imglib2's FloatConvolverRealType (every product and sum rounded to float, taken
   * in the order of increasing input position); else double. */
  function makeSmoother(src, W, H, kx, ky, float, roundOut) {
    const Rx = kx ? kx.R : 0, Ry = ky ? ky.R : 0;
    let hbuf = null, clo = 0, chi = -1;   // hbuf holds the horizontal pass of the rows clo..chi (chi < clo: nothing)
    const pad = new Float64Array(W + 2 * Rx);
    const padIdx = new Int32Array(W + 2 * Rx);
    for (let i = 0; i < padIdx.length; i++) padIdx[i] = mirror(i - Rx, W);
    function hrow(y, out, off) {
      const base = y * W;
      for (let i = 0; i < padIdx.length; i++) pad[i] = src[base + padIdx[i]];
      if (!kx) { for (let x = 0; x < W; x++) out[off + x] = pad[x]; return; }
      const k = kx.k, n = 2 * Rx + 1;
      if (float) {
        for (let x = 0; x < W; x++) {
          let acc = 0;
          for (let j = 0; j < n; j++) acc = fround(acc + fround(pad[x + j] * k[j]));
          out[off + x] = acc;
        }
      } else {
        for (let x = 0; x < W; x++) {
          let acc = 0;
          for (let j = 0; j < n; j++) acc += k[j] * pad[x + j];
          out[off + x] = acc;
        }
      }
    }
    /* roundOut: the store into an integer-typed image, imglib2 AbstractIntegerType.setReal(float) = Util.round(float) =
     * (int)Math.floor(f + 0.5f) with the sum in float. Applied once, at the final store of the separable convolution. */
    const store = roundOut ? (v) => Math.floor(fround(v + 0.5)) : null;
    const stats = { hrows: 0 };   // horizontal-pass rows computed so far (tests: the reuse across bands)
    return {
      Rx, Ry, stats,
      /* rows of the horizontal pass a call needs, for the memory declaration */
      bandBytes(rows) { return ((rows + 2 * Ry) * W + W + 2 * Rx) * 8 + rows * W * 8; },
      async rows(first, last, dst, tk) {
        let lo = Infinity, hi = -Infinity;
        for (let t = first; t <= last; t++) {
          const m = mirror(t, H);
          for (let d = -Ry; d <= Ry; d++) { const q = mirror(m + d, H); if (q < lo) lo = q; if (q > hi) hi = q; }
        }
        const nH = hi - lo + 1, need = nH * W;
        // The horizontal pass of a row does not depend on the band: the rows the previous call already holds are moved, not recomputed
        // (a one-row band of a wide kernel would otherwise redo 2 Ry + 1 rows for every output row). Same values, same bytes.
        const klo = Math.max(lo, clo), khi = Math.min(hi, chi);
        const keep = khi >= klo ? khi - klo + 1 : 0;
        if (!hbuf || hbuf.length < need) {
          const nb = new Float64Array(need);
          if (keep) nb.set(hbuf.subarray((klo - clo) * W, (khi - clo + 1) * W), (klo - lo) * W);
          hbuf = nb;
        } else if (keep && clo !== lo) {
          hbuf.copyWithin((klo - lo) * W, (klo - clo) * W, (khi - clo + 1) * W);
        }
        const todo = nH - keep;
        let done = 0;
        for (let y = lo; y <= hi; y++) {
          if (keep && y >= klo && y <= khi) continue;
          hrow(y, hbuf, (y - lo) * W);
          done++; stats.hrows++;
          if (tk && (done & 7) === 7) await tk(0.5 * done / todo);
        }
        clo = lo; chi = hi;
        for (let t = first; t <= last; t++) {
          const m = mirror(t, H), o = (t - first) * W;
          if (!ky) {
            const b = (m - lo) * W;
            if (store) for (let x = 0; x < W; x++) dst[o + x] = store(hbuf[b + x]); else for (let x = 0; x < W; x++) dst[o + x] = hbuf[b + x];
          } else {
            const k = ky.k, n = 2 * Ry + 1;
            for (let x = 0; x < W; x++) dst[o + x] = 0;
            for (let j = 0; j < n; j++) {
              const b = (mirror(m - Ry + j, H) - lo) * W, kj = k[j];
              if (float) for (let x = 0; x < W; x++) dst[o + x] = fround(dst[o + x] + fround(hbuf[b + x] * kj));
              else for (let x = 0; x < W; x++) dst[o + x] += kj * hbuf[b + x];
            }
            if (store) for (let x = 0; x < W; x++) dst[o + x] = store(dst[o + x]);
          }
          if (tk && ((t - first) & 7) === 7) await tk(0.5 + 0.5 * (t - first + 1) / (last - first + 1));
        }
      }
    };
  }

  /* Rows of an output band that keep a band of the three working buffers (smoothed rows, horizontal pass, the output)
   * within about `budgetPixels` values. */
  let bandBudget = 1 << 21;   // values per working buffer; the tests lower it to prove that the band size changes no byte
  function bandRowsFor(W, apronRows) {
    const rows = Math.floor(bandBudget / Math.max(1, W)) - 2 * apronRows - 4;
    return Math.max(1, rows);
  }
  /* Tests only: a smaller budget makes bands of a few rows (the minimum is one row). Returns the previous budget. */
  function setBandBudget(n) { const old = bandBudget; bandBudget = Math.max(1, Math.floor(n)); return old; }

  const IJHessian = { mirror, gaussKernel, gauss3Kernel, makeSmoother, bandRowsFor, setBandBudget };

  // ------------------------------------------------------------------------------------------------------------
  // Tubeness
  // ------------------------------------------------------------------------------------------------------------
  /* Fiji "Tubeness" (VIB, Plugins > Analyze), 2D, recovered from the reference outputs tests/fixtures/ij-wave3/fiji/tubeness
   * (the plugin's code is GPL and was never read; Sato et al., "Three-dimensional multi-scale line filter for
   * segmentation and visualization of curvilinear structures in medical images", Medical Image Analysis 2(2), 1998):
   *   g   = the image smoothed with a normalised Gaussian of the given sigma, kernel radius ceil(3 sigma), mirror boundary;
   *   Dxx = g(x+1,y) - 2 g + g(x-1,y)   Dyy likewise   Dxy = (g(x+1,y+1) - g(x-1,y+1) - g(x+1,y-1) + g(x-1,y-1)) / 4
   *         (central differences of the smoothed image, mirror boundary);
   *   H   = sigma^2 * the Hessian in calibrated units (Dxx / pw^2, Dyy / ph^2, Dxy / (pw ph));
   *   response = -lambda where lambda is the eigenvalue of H with the larger magnitude, if it is negative, else 0;
   *   the outermost ring of pixels is 0.
   * With "Use calibration information" the sigma is in calibrated units: the pixel sigmas are sigma/pw and sigma/ph;
   * without, sigma is in pixels and pw = ph = 1. The image is not normalised: 16-bit values give 16-bit-sized responses.
   * Output: a new 32-bit image "tubeness of <name>". Reference agreement: see tests/js/test_ij_enh_hessian.mjs. */
  REG.define('tubeness', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: false, channels: 'one', roi: 'ignore', preview: false,
    validate(p) {
      if (!isNum(p.sigma) || !(p.sigma > 0) || p.sigma > 100) throw bad('sigma');
      if (typeof p.useCalibration !== 'boolean') throw bad('useCalibration');
      if (p.pixelWidth !== undefined && !(isNum(p.pixelWidth) && p.pixelWidth > 0)) throw bad('pixelWidth');
      if (p.pixelHeight !== undefined && !(isNum(p.pixelHeight) && p.pixelHeight > 0)) throw bad('pixelHeight');
    },
    /* the calibration is state of the document at that moment: copy it in once, a replay reads the params only */
    resolve(view, params) {
      const p = Object.assign({}, params);
      const cal = view.calibration || {};
      if (p.pixelWidth === undefined) p.pixelWidth = isNum(cal.pixelWidth) && cal.pixelWidth > 0 ? cal.pixelWidth : 1;
      if (p.pixelHeight === undefined) p.pixelHeight = isNum(cal.pixelHeight) && cal.pixelHeight > 0 ? cal.pixelHeight : 1;
      return p;
    },
    scratchBytes(info, p) {
      const W = info.width, H = info.height;
      const pw = p.useCalibration ? p.pixelWidth || 1 : 1, ph = p.useCalibration ? p.pixelHeight || 1 : 1;
      const Ry = Math.ceil(3 * p.sigma / ph);
      const rows = Math.min(H, bandRowsFor(W, Ry));
      void pw;
      return W * H * 4 + ((rows + 2 + 2 * Ry) * W + (rows + 2) * W) * 8 + 4 * W * 8;
    },
    async run(view, p, roi, io) {
      const W = view.width, H = view.height;
      const c = Number.isInteger(io && io.channel) ? io.channel : (view.active || 0);
      if (!(c >= 0 && c < view.channels.length)) throw bad('channel');
      const src = view.channels[c].data;
      const pw = p.useCalibration ? p.pixelWidth : 1, ph = p.useCalibration ? p.pixelHeight : 1;
      const sx = p.sigma / pw, sy = p.sigma / ph;               // pixel sigmas
      const Rx = Math.ceil(3 * sx), Ry = Math.ceil(3 * sy);
      const sm = makeSmoother(src, W, H, { k: gaussKernel(sx, Rx), R: Rx }, { k: gaussKernel(sy, Ry), R: Ry }, false);
      const out = new Float32Array(W * H);
      const tk = ioTicker(io, 'op.tubeness');
      const s2 = p.sigma * p.sigma;
      const cxx = s2 / (pw * pw), cyy = s2 / (ph * ph), cxy = s2 / (pw * ph);
      const band = Math.min(H, bandRowsFor(W, Ry));
      const g = new Float64Array((band + 2) * W);
      const xm = new Int32Array(W), xp = new Int32Array(W);
      for (let x = 0; x < W; x++) { xm[x] = mirror(x - 1, W); xp[x] = mirror(x + 1, W); }
      for (let ya = 0; ya < H; ya += band) {
        const yb = Math.min(H, ya + band);
        await sm.rows(ya - 1, yb, g, (f) => tk((ya + (yb - ya) * f * 0.5) / H));   // smoothed rows ya-1 .. yb (the mirror rows at the image edge)
        for (let y = ya; y < yb; y++) {
          await tk((ya + (yb - ya) * 0.5 + (y - ya + 1) * 0.5) / H);   // a cancel / progress check at least every row
          if (y === 0 || y === H - 1) continue;                 // the outermost ring stays 0
          const rm = (y - 1 - (ya - 1)) * W, r0 = (y - (ya - 1)) * W, rp = (y + 1 - (ya - 1)) * W;
          for (let x = 1; x < W - 1; x++) {
            const a = xm[x], b = xp[x], f = g[r0 + x] * 2;
            const dxx = (g[r0 + b] - f + g[r0 + a]) * cxx;
            const dyy = (g[rp + x] - f + g[rm + x]) * cyy;
            const dxy = ((g[rp + b] - g[rp + a] - g[rm + b] + g[rm + a]) / 4) * cxy;
            const tr = (dxx + dyy) / 2, dd = sqrt(((dxx - dyy) / 2) * ((dxx - dyy) / 2) + dxy * dxy);
            const l1 = tr - dd, l2 = tr + dd;
            const big = abs(l1) > abs(l2) ? l1 : l2;
            out[y * W + x] = big < 0 ? -big : 0;
          }
        }
      }
      const chn = view.channels[c];
      return [{
        name: 'tubeness of ' + view.name, width: W, height: H, bitDepth: 32,
        calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
        channels: [{ name: chn.name, color: chn.color, data: out }]
      }];
    }
  });

  // ------------------------------------------------------------------------------------------------------------
  // Frangi Vesselness
  // ------------------------------------------------------------------------------------------------------------
  /* net.imagej.ops.commands.filter.FrangiVesselness (imagej-ops 2.2.0, Simplified BSD licence; decompiled from the
   * jar of the Fiji install the fixtures were recorded with):
   *     for each scale s in the scale list:  in = doGauss ? ops.filter().gauss(input, (double)s) : input;
   *                                          frangiVesselness(result[..., s-th plane], in, spacing, (int)s)
   *   gauss: Gauss3 (halfkernels(sigma) = DefaultGaussRAI, mirror boundary Boundary.SINGLE), float arithmetic.
   * net.imagej.ops.filter.vesselness.DefaultFrangi.frangi (2D): alpha = 0.5, beta = 0.5, c = 15:
   *     Hessian H[i][j], i,j in {x,y}: with the input read through OutOfBoundsMirrorFactory(Boundary.SINGLE)
   *         ra12 = p - s e_i (- s e_j when i != j);  ra13 = p + s e_i (+ s e_j when i != j);  distances scaled by spacing
   *         v17 = (f(p) - f(ra12)) / dist(ra12, p);  v19 = (f(ra13) - f(p)) / dist(p, ra13);
   *         H[i][j] = (v19 - v17) / dist(ra12, ra13)
   *       (so a diagonal entry is (f+ - 2f + f-) / (2 (s sp)^2) and the off-diagonal entry is the same second
   *        difference along the diagonal direction, not a mixed partial: ported as it is)
   *     S2 = ||H||_F^2;  eigenvalues sorted by magnitude: l1 (smaller |l|), l2 (larger)
   *     if (l2 < 0) { Rb = |l1| / |l2|; v = exp(-Rb^2 / (2 beta^2)) * (1 - exp(-S2 / (2 c^2))) } else v = 0
   * Result: Img<FloatType>, one plane per scale; here ONE new 32-bit image with one channel per scale ("Scale <s>"). */
  /* Jama (NIST, public domain) EigenvalueDecomposition of a symmetric 2 x 2 matrix [[a, b], [b, c]]: tred2 then tql2,
   * ported statement by statement for the eigenvalues only (the eigenvector updates are dropped). DefaultFrangi sorts
   * the eigenvalues by magnitude with a STABLE sort, so when the two magnitudes are equal up to rounding (a Hessian with
   * a zero trace) which one is "the larger" is decided by the last bits Jama leaves: the analytic formula cannot know
   * them, this function reproduces them. Returns [lo, hi] (ascending, as Jama's sort leaves them). */
  function jamaHypot(a, b) {      // Jama.util.Maths.hypot
    let r;
    if (abs(a) > abs(b)) { r = b / a; r = abs(a) * sqrt(1 + r * r); }
    else if (b !== 0) { r = a / b; r = abs(b) * sqrt(1 + r * r); }
    else r = 0.0;
    return r;
  }
  const JD = new Float64Array(2), JE = new Float64Array(2), JV = new Float64Array(4);   // V[i][j] = JV[2 i + j]
  function jamaEig2(a, b, c) {
    const d = JD, e = JE, V = JV;
    V[0] = a; V[1] = b; V[2] = b; V[3] = c;
    // tred2, n = 2
    d[0] = V[2]; d[1] = V[3];
    {
      const i = 1;
      let scale = 0.0, h = 0.0;
      for (let k = 0; k < i; k++) scale += abs(d[k]);
      if (scale === 0.0) {
        e[i] = d[i - 1];
        for (let j = 0; j < i; j++) { d[j] = V[(i - 1) * 2 + j]; V[i * 2 + j] = 0.0; V[j * 2 + i] = 0.0; }
      } else {
        for (let k = 0; k < i; k++) { d[k] /= scale; h += d[k] * d[k]; }
        let f = d[i - 1];
        let g = sqrt(h);
        if (f > 0) g = -g;
        e[i] = scale * g;
        h -= f * g;
        d[i - 1] = f - g;
        for (let j = 0; j < i; j++) e[j] = 0.0;
        for (let j = 0; j < i; j++) {
          f = d[j]; V[j * 2 + i] = f; g = e[j] + V[j * 2 + j] * f;
          for (let k = j + 1; k <= i - 1; k++) { g += V[k * 2 + j] * d[k]; e[k] += V[k * 2 + j] * f; }
          e[j] = g;
        }
        f = 0.0;
        for (let j = 0; j < i; j++) { e[j] /= h; f += e[j] * d[j]; }
        const hh = f / (h + h);
        for (let j = 0; j < i; j++) e[j] -= hh * d[j];
        for (let j = 0; j < i; j++) {
          f = d[j]; g = e[j];
          for (let k = j; k <= i - 1; k++) V[k * 2 + j] -= (f * e[k] + g * d[k]);
          d[j] = V[(i - 1) * 2 + j]; V[i * 2 + j] = 0.0;
        }
      }
      d[i] = h;
    }
    for (let i = 0; i < 1; i++) {
      V[1 * 2 + i] = V[i * 2 + i]; V[i * 2 + i] = 1.0;
      const h = d[i + 1];
      if (h !== 0.0) {
        for (let k = 0; k <= i; k++) d[k] = V[k * 2 + i + 1] / h;
        for (let j = 0; j <= i; j++) {
          let g = 0.0;
          for (let k = 0; k <= i; k++) g += V[k * 2 + i + 1] * V[k * 2 + j];
          for (let k = 0; k <= i; k++) V[k * 2 + j] -= g * d[k];
        }
      }
      for (let k = 0; k <= i; k++) V[k * 2 + i + 1] = 0.0;
    }
    for (let j = 0; j < 2; j++) { d[j] = V[1 * 2 + j]; V[1 * 2 + j] = 0.0; }
    V[3] = 1.0; e[0] = 0.0;
    // tql2, n = 2
    const n = 2, eps = Math.pow(2.0, -52.0);
    for (let i = 1; i < n; i++) e[i - 1] = e[i];
    e[n - 1] = 0.0;
    let f = 0.0, tst1 = 0.0;
    for (let l = 0; l < n; l++) {
      tst1 = Math.max(tst1, abs(d[l]) + abs(e[l]));
      let m = l;
      while (m < n) { if (abs(e[m]) <= eps * tst1) break; m++; }
      if (m > l) {
        let iter = 0;
        do {
          iter++;
          let g = d[l];
          let p = (d[l + 1] - g) / (2.0 * e[l]);
          let r = jamaHypot(p, 1.0);
          if (p < 0) r = -r;
          d[l] = e[l] / (p + r);
          d[l + 1] = e[l] * (p + r);
          const dl1 = d[l + 1];
          let h = g - d[l];
          for (let i = l + 2; i < n; i++) d[i] -= h;
          f += h;
          p = d[m];
          let cc = 1.0, c2 = cc, c3 = cc;
          const el1 = e[l + 1];
          let s = 0.0, s2 = 0.0;
          for (let i = m - 1; i >= l; i--) {
            c3 = c2; c2 = cc; s2 = s;
            g = cc * e[i]; h = cc * p;
            r = jamaHypot(p, e[i]);
            e[i + 1] = s * r;
            s = e[i] / r; cc = p / r;
            p = cc * d[i] - s * g;
            d[i + 1] = h + s * (cc * g + s * d[i]);
          }
          p = -s * s2 * c3 * el1 * e[l] / dl1;
          e[l] = s * p;
          d[l] = cc * p;
        } while (abs(e[l]) > eps * tst1 && iter < 30);
      }
      d[l] += f;
      e[l] = 0.0;
    }
    if (d[1] < d[0]) { const t = d[0]; d[0] = d[1]; d[1] = t; }
    return d;
  }

  const FRANGI_ALPHA = 0.5, FRANGI_BETA = 0.5, FRANGI_C = 15;
  const MAX_SCALES = 32, MAX_SCALE = 64;

  /* the command's string parsing: split on (,|\s)\s* then parse */
  function parseNumberList(text, integer) {
    // String.split drops the trailing empty strings; an empty token inside ("2,, 5") would make Integer.parseInt / Double.parseDouble throw
    const parts = String(text == null ? '' : text).trim().split(/(?:,|\s)\s*/);
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    if (!parts.length) return null;
    const out = [];
    for (const s of parts) {
      if (s === '') return null;
      if (integer ? !/^[+-]?\d+$/.test(s) : !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
      const v = Number(s);
      if (!Number.isFinite(v)) return null;
      out.push(v);
    }
    return out;
  }
  /* FrangiVesselness.checkDimensions: too many values are cut, too few are filled with the last one. */
  function parseSpacing(text, dims) {
    const v = parseNumberList(text, false);
    if (!v) return null;
    const o = v.slice(0, dims);
    while (o.length < dims) o.push(o[o.length - 1]);
    return o;
  }

  REG.define('frangi', {
    kind: 'newdoc', version: 1, stack: 'plane', rgb: false, channels: 'one', roi: 'ignore', preview: false,
    validate(p) {
      if (typeof p.doGauss !== 'boolean') throw bad('doGauss');
      if (!Array.isArray(p.spacing) || p.spacing.length !== 2 || p.spacing.some((s) => !isNum(s) || !(s > 0))) throw bad('spacing');
      if (!Array.isArray(p.scales) || !p.scales.length || p.scales.length > MAX_SCALES || p.scales.some((s) => !isInt(s) || s < 1 || s > MAX_SCALE)) throw bad('scales');
    },
    scratchBytes(info, p) {
      const W = info.width, H = info.height, n = (p.scales || [1]).length;
      const Ry = Math.max.apply(null, (p.scales || [1]).map((s) => s + (p.doGauss ? Math.max(1, jint(3 * s + 0.5)) : 0)));
      const rows = Math.min(H, bandRowsFor(W, Ry));
      return W * H * 4 * n + ((rows + 2 * Ry + 2) * W + (rows + 2 * Ry) * W) * 8 + 4 * W * 8;
    },
    async run(view, p, roi, io) {
      const W = view.width, H = view.height;
      const c = Number.isInteger(io && io.channel) ? io.channel : (view.active || 0);
      if (!(c >= 0 && c < view.channels.length)) throw bad('channel');
      const src = view.channels[c].data;
      const sx = p.spacing[0], sy = p.spacing[1];
      const channels = [];
      const tk = ioTicker(io, 'op.frangi');
      const twoA = 2 * FRANGI_ALPHA * FRANGI_ALPHA, twoB = 2 * FRANGI_BETA * FRANGI_BETA, twoC = 2 * FRANGI_C * FRANGI_C;
      void twoA;
      for (let si = 0; si < p.scales.length; si++) {
        const s = p.scales[si];
        const out = new Float32Array(W * H);
        let sm = null;
        // ops.filter().gauss returns an image of the INPUT's type (DefaultGaussRAI.createOutput = create().img(input)): an 8 / 16-bit
        // document is an UnsignedByte / UnsignedShort image in the Fiji GUI, so the smoothed values are rounded integers (Util.round(float))
        if (p.doGauss) { const g = gauss3Kernel(s); sm = makeSmoother(src, W, H, g, g, true, view.bitDepth !== 32); }
        // DefaultFrangi.getDistance: sqrt(sum_k ((position difference)_k * spacing_k)^2), term by term in double
        const dx = s * sx, dy = s * sy;
        const dd = sqrt((s * sx) * (s * sx) + (s * sy) * (s * sy));
        const dd3 = sqrt((2 * s * sx) * (2 * s * sx) + (2 * s * sy) * (2 * s * sy));   // distance(ra12, ra13) of a diagonal entry
        const apron = s + (sm ? sm.Ry : 0);
        const band = Math.min(H, bandRowsFor(W, apron));
        const g = new Float64Array((band + 2 * s) * W);
        const xm = new Int32Array(W), xp = new Int32Array(W);
        for (let x = 0; x < W; x++) { xm[x] = mirror(x - s, W); xp[x] = mirror(x + s, W); }
        for (let ya = 0; ya < H; ya += band) {
          const yb = Math.min(H, ya + band);
          const first = ya - s, last = yb - 1 + s;
          const frac = (rows) => (si + (ya + rows) / H) / p.scales.length;
          if (sm) await sm.rows(first, last, g, (f) => tk(frac((yb - ya) * f * 0.5)));
          else for (let t = first; t <= last; t++) { const m = mirror(t, H) * W, o = (t - first) * W; for (let x = 0; x < W; x++) g[o + x] = src[m + x]; }
          for (let y = ya; y < yb; y++) {
            await tk(frac((yb - ya) * 0.5 * (sm ? 1 : 0) + (y - ya + 1) * (sm ? 0.5 : 1)));   // a cancel / progress check at least every row
            const rm = (y - s - first) * W, r0 = (y - first) * W, rp = (y + s - first) * W;
            for (let x = 0; x < W; x++) {
              const a = xm[x], b = xp[x], f0 = g[r0 + x];
              // H[i][j] = ((f(p+) - f(p)) / d - (f(p) - f(p-)) / d) / (2 d)
              const hxx = ((g[r0 + b] - f0) / dx - (f0 - g[r0 + a]) / dx) / (2 * dx);
              const hyy = ((g[rp + x] - f0) / dy - (f0 - g[rm + x]) / dy) / (2 * dy);
              const hd = ((g[rp + b] - f0) / dd - (f0 - g[rm + a]) / dd) / dd3;
              const S2 = hxx * hxx + hd * hd + hd * hd + hyy * hyy;     // ||H||_F^2
              const tr = (hxx + hyy) / 2, e = sqrt(((hxx - hyy) / 2) * ((hxx - hyy) / 2) + hd * hd);
              let l1 = tr - e, l2 = tr + e;                              // ascending, as Jama's eig()
              const al1 = abs(l1), al2 = abs(l2), big = al1 > al2 ? al1 : al2;
              if (big > 0 && abs(al1 - al2) <= 1e-9 * big) {
                // the magnitudes tie up to rounding: the order is whatever Jama's last bits say
                const jv = jamaEig2(hxx, hd, hyy);
                l1 = jv[0]; l2 = jv[1];
              }
              if (abs(l2) < abs(l1)) { const t = l1; l1 = l2; l2 = t; }  // stable sort by magnitude
              let v = 0;
              if (l2 < 0) {
                const rb = abs(l1) / abs(l2);
                v = exp(-(rb * rb) / twoB) * (1 - exp(-S2 / twoC));
              }
              out[y * W + x] = v;
            }
          }
        }
        channels.push({ name: 'Scale ' + s, color: '#ffffff', data: out });
      }
      return [{
        name: 'Frangi Vesselness of ' + view.name, width: W, height: H, bitDepth: 32,
        calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
        channels
      }];
    }
  });

  /* Time the dialog announces before a CLAHE run, in seconds: measured on a desktop in Node 20 (per pixel and channel:
   * exact 0.22 + 0.0086 * blocksize microseconds, fast 0.4), doubled for a browser worker and a slower machine. */
  function claheSeconds(width, height, channels, p) {
    const perPx = p.fast ? 0.4 : 0.22 + 0.0086 * p.blocksize;
    return Math.max(0.1, 2 * perPx * width * height * channels * 1e-6);
  }

  /* Time the dialog announces before an Add Specified Noise run, in seconds. An 8 / 16-bit pixel is redrawn until it stays in range:
   * at a large sd the acceptance is ~ (range + 1) / (sd sqrt(2 pi)), so a pixel costs ~ sd * 2.5 / (range + 1) draws (at least one);
   * measured ~1 us per redraw in Node 20 (256-px row at sd 1e5: 265 ms), doubled for a browser worker and a slower machine. A 32-bit
   * image draws once. The whole image is assumed (a selection only makes it faster). */
  function noiseSeconds(width, height, channels, bitDepth, sd) {
    const range = bitDepth === 8 ? 256 : 65536;
    const draws = bitDepth === 32 ? 1 : Math.max(1, sd * 2.5 / range);
    // ~0.1 us for the first draw of a pixel (one nextGaussian), ~1 us for every redraw
    return Math.max(0.01, 2 * (1.0e-7 + 1.0e-6 * (draws - 1)) * width * height * channels);
  }

  // Pure helpers the commands and the tests share.
  root.IJHessian = IJHessian;
  root.IJEnhPkg = { jint, jround, claheSeconds, noiseSeconds, NOISE_CHECK_DRAWS, jamaEig2, parseNumberList, parseSpacing, claheQuantize, makeEqualizer, nodeAxis, CLAHE_STRIDE, CLAHE_SLOW_MAX_PIXELS, MAX_SCALES, MAX_SCALE, NOISE_MAX_SD };
})(typeof self !== 'undefined' ? self : globalThis);
