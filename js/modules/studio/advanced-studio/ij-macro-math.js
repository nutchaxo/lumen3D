/* ij-macro-math.js — package `macro`: Process › Math › Macro… (ImageJ 1.54p ij.plugin.filter.ImageMath, arg "macro").
 *
 * Worker only: loaded by ij-worker.js as a `pre` file of package `macro` (ij-app.js PACKAGE_PRE), after ij-macro-lang.js and before
 * ij-proc-macro.js. It registers the pixel op `macroMath` (journal-replayable, param `code`) and reads IJMacro / IJMacroProto only
 * when a step runs, so its load order against them does not matter. Contract: DOCS/studio-advanced/macros/EXTRAS.md §9.
 *
 * ImageMath.applyMacro, per plane (a slice of ImageJ's stack):
 *   code  = "var v,x,y,z,w,h,d,a;\nfunction dummy() {}\n" + macro + ";\n"   run once (its side effects happen once per plane), then
 *   for every pixel of the selection's bounding rectangle, rows y from r.y, columns x from r.x:
 *     v = the pixel value (8-bit &255, 16-bit &65535, 32-bit float); x only when the code names it;
 *     a = atan2((h−y−1)−h/2, x−w/2) (+2π when negative) and d = sqrt((x−w/2)² + (y−h/2)²) only when named (integer w/2, h/2);
 *     the statements from program counter 23 run; v is read back: 8 / 16-bit (int)v clamped to the type, 32-bit (float)v.
 *   RGB: three runs per pixel (v = red, green, blue, each (int) clamped 0..255) — or, when the code calls getPixel, one run with v = the
 *   packed Java int 0xff000000|r<<16|g<<8|b and the (int) result unpacked.
 *   getPixel reads the plane as it was before the step (ImageJ writes into a copy when the code names getPixel).
 *   A selection with a code that names getPixel (roi mode 'ignore': this op applies the selection itself, ctx.selection):
 *     - the first run called getPixel → ImagePlus.getProcessor reset the processor's roi: the WHOLE plane is processed, unmasked;
 *     - else the rows of the bounding rectangle run into a zeroed copy copied back whole (every pixel outside the rectangle becomes 0)
 *       and PlugInFilterRunner's reset(mask) puts the source back inside the rectangle outside the mask.
 *   A code without getPixel keeps the engine's selection handling (bounding rectangle, mask).
 * The interpreter is IJMacro.pixelProgram: the synchronous twin, or the driver when the code holds a loop (sliced, so a cancel or a
 * newer preview stops an endless loop; the op's ctx.check is its signal). Nothing here evaluates text other than macro code, and a
 * macro run by this op reaches no file, no network and no dataset: every Studio built-in other than getPixel, getWidth, getHeight,
 * bitDepth, nSlices and getSliceNumber stops it with err.macMathHost.
 */
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  const LANG = () => (typeof IJMacro !== 'undefined' ? IJMacro : null);
  const MAX_CODE = 65536;
  const PC_START = 23;
  const TWO_PI = 2 * Math.PI;

  // The page sends its translated texts with every macro run (ij-proc-macro.js passes them on); a step outside any run uses the last ones.
  let TEXTS = {};
  // Where print() of the per-pixel code goes: the Log of the macro run in progress in this worker (set by ij-proc-macro.js).
  let logSink = null;

  function fail(code, message, details) {
    const e = new Error(message || code);
    e.code = code;
    if (details) e.details = details;
    return e;
  }
  function tr(key, params) {
    let s = typeof TEXTS[key] === 'string' ? TEXTS[key] : key;
    if (params) s = s.replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
    return s;
  }
  /* (int) of a double: NaN → 0, saturating at the int range, truncating toward zero. */
  function d2i(x) {
    if (x !== x) return 0;
    if (x >= 2147483647) return 2147483647;
    if (x <= -2147483648) return -2147483648;
    return x < 0 ? Math.ceil(x) : Math.floor(x);
  }
  /* A Studio built-in the per-pixel code may not reach: the step fails as IJ_MACRO_MATH, the built-in's name in details.hostName so the page
   * words it in its own language (the worker's texts arrive only with a macro run). */
  function hostRefusal(name) {
    const text = tr('err.macMathHost', { name });
    return fail('IJ_MACRO_MATH', text, { hostName: String(name), error: { message: text, line: 0, lineText: null, excerpt: null, calledFrom: [], silent: false, dialogText: text } });
  }
  /** ImageMath.applyMacro: "if (!macro.contains("=")) macro = "v="+macro;" */
  function finalCode(code) { return String(code).indexOf('=') >= 0 ? String(code) : 'v=' + code; }

  /* The source plane a pixel program reads through getPixel: ImageJ's temp current image new ImagePlus("", ip), one slice. */
  function pixelHost(view, c) {
    const rgb = !!view.rgb;
    const P = rgb
      ? { W: view.width, H: view.height, bd: 8, rgb: true, r: view.channels[0].data, g: view.channels[1].data, b: view.channels[2].data, alpha: null }
      : { W: view.width, H: view.height, bd: view.bitDepth, rgb: false, data: view.channels[c].data };
    return {
      pixel: { P, bitDepth: rgb ? 24 : view.bitDepth, nSlices: 1, slice: 1, M: { rgbWeights: null } },
      texts: { 'err.macMathHost': TEXTS['err.macMathHost'] },
      call(name) { throw hostRefusal(name); },
      showMessage() { throw hostRefusal('showMessage'); },
      showError() { return undefined; },
      printToWindow() { throw hostRefusal('print'); },
      runMacroFile() { throw hostRefusal('runMacro'); },
      getVersion() { return '1.54p'; },
      syncFunctions: new Set(['getPixel', 'getWidth', 'getHeight', 'bitDepth', 'nSlices', 'getSliceNumber'])
    };
  }

  /** The ImageJ stack index − 1 of the plane a step processes (n = t·nZ·nC + z·nC + c + 1). */
  function sliceIndex(view, c) {
    const nC = view.rgb ? 1 : view.nC;
    return view.t * view.nZ * nC + view.z * nC + (view.rgb ? 0 : c);
  }

  /* The op's ctx.check as the AbortSignal the language's driver reads (aborted is polled at each slice; nothing is dispatched). */
  function checkSignal(check) {
    return {
      get aborted() { try { check(); return false; } catch (_) { return true; } },
      addEventListener() {}, removeEventListener() {}
    };
  }

  async function makeProgram(code, view, c, check) {
    const L = LANG();
    if (!L || typeof L.pixelProgram !== 'function') throw fail('IJ_MODULE_MISSING', 'the macro language did not load');
    const P = root.IJMacroProto;
    // the Studio built-ins the per-pixel code may call (getPixel …) are those of the runtime, which knows the pixel host
    if (P && typeof P.ensureBuiltins === 'function') P.ensureBuiltins();
    const sink = logSink;
    const host = pixelHost(view, c);
    const prog = await L.pixelProgram(code, { host, onLog: (s) => { if (sink) sink(s); }, signal: checkSignal(check) });
    check();   // a cancel during the first run is the op's cancel, not a macro error
    if (!prog || !prog.ok) throw fail('IJ_MACRO_MATH', (prog && prog.error && prog.error.message) || 'macro', { error: prog ? prog.error : null });
    prog.pixelState = host.pixel;
    prog.calledGetPixel = !!host.pixel.getPixelCalled;
    prog.set('w', view.width);
    prog.set('h', view.height);
    prog.set('z', sliceIndex(view, c));
    return prog;
  }

  function pixelFailure(prog, err, check) {
    prog.dispose();
    if (err.aborted) check();
    return fail('IJ_MACRO_MATH', err.message || 'macro', { error: err });
  }

  function roiModeFor(p) {
    const L = LANG();
    if (!L || !p || typeof p.code !== 'string' || typeof L.hasWord !== 'function') return 'mask';
    return L.hasWord(L.tokenize(finalCode(p.code)), 'getPixel') ? 'ignore' : 'mask';
  }
  const outsideMask = (clip, x, y) => clip.data[(y - clip.y) * clip.w + (x - clip.x)] === 0;
  const planeArray = (bd, n) => (bd === 8 ? new Uint8Array(n) : bd === 16 ? new Uint16Array(n) : new Float32Array(n));

  /* The code over the rectangle rr of a grey plane, row by row (ImageJ's order): each result goes to out[(y − oy)·ow + (x − ox)]. */
  async function grayRun(prog, view, c, rr, check, out, ow, ox, oy) {
    const W = view.width, H = view.height, w2 = (W / 2) | 0, h2 = (H / 2) | 0;
    const bd = view.bitDepth, src = view.channels[c].data;
    const top = bd === 8 ? 255 : 65535;
    const hasX = prog.hasX, hasA = prog.hasA, hasD = prog.hasD, drive = prog.needsDrive;
    for (let y = rr.y; y < rr.y + rr.h; y++) {
      check();
      prog.set('y', y);
      const dy = y - h2, ay = (H - y - 1) - h2;
      let o = (y - oy) * ow + (rr.x - ox);
      for (let x = rr.x; x < rr.x + rr.w; x++) {
        prog.set('v', src[y * W + x]);
        if (hasX) prog.set('x', x);
        if (hasA) { let ang = Math.atan2(ay, x - w2); if (ang < 0) ang += TWO_PI; prog.set('a', ang); }
        if (hasD) { const dx = x - w2; prog.set('d', Math.sqrt(dx * dx + dy * dy)); }
        const err = drive ? await prog.runAsync() : prog.runSync();
        if (err) throw pixelFailure(prog, err, check);
        const v = prog.get('v');
        if (bd === 32) out[o++] = v;
        else { let v2 = d2i(v); if (v2 < 0) v2 = 0; if (v2 > top) v2 = top; out[o++] = v2; }
      }
    }
  }

  /* The code over the rectangle rr of an RGB plane, the three colours at once (ImageJ processes a ColorProcessor pixel by pixel):
   * results go into res[0..2] (full planes). */
  async function rgbRun(prog, view, rr, res, check) {
    const W = view.width, H = view.height, w2 = (W / 2) | 0, h2 = (H / 2) | 0;
    const r = view.channels[0].data, g = view.channels[1].data, b = view.channels[2].data;
    const hasX = prog.hasX, hasA = prog.hasA, hasD = prog.hasD, packed = prog.hasGetPixel, drive = prog.needsDrive;
    const clamp = (v) => { let v2 = d2i(v); if (v2 < 0) v2 = 0; if (v2 > 255) v2 = 255; return v2; };
    const run = async () => {
      const err = drive ? await prog.runAsync() : prog.runSync();
      if (err) throw pixelFailure(prog, err, check);
      return prog.get('v');
    };
    for (let y = rr.y; y < rr.y + rr.h; y++) {
      check();
      prog.set('y', y);
      const dy = y - h2, ay = (H - y - 1) - h2;
      for (let x = rr.x; x < rr.x + rr.w; x++) {
        if (hasX) prog.set('x', x);
        if (hasA) { let ang = Math.atan2(ay, x - w2); if (ang < 0) ang += TWO_PI; prog.set('a', ang); }
        if (hasD) { const dx = x - w2; prog.set('d', Math.sqrt(dx * dx + dy * dy)); }
        const i = y * W + x;
        if (packed) {
          prog.set('v', (0xff000000 | (r[i] << 16) | (g[i] << 8) | b[i]) | 0);
          const rgb = d2i(await run());
          res[0][i] = (rgb >> 16) & 0xff; res[1][i] = (rgb >> 8) & 0xff; res[2][i] = rgb & 0xff;
        } else {
          prog.set('v', r[i]); res[0][i] = clamp(await run());
          prog.set('v', g[i]); res[1][i] = clamp(await run());
          prog.set('v', b[i]); res[2][i] = clamp(await run());
        }
      }
    }
  }

  /* What a plane's code runs on once its first run is done: null = the region the engine hands (no selection, a code without getPixel,
   * or a first run that called getPixel: the whole plane), else the selection (ImageMath's zeroed copy). */
  function clipOf(prog, selection) { return selection && prog.hasGetPixel && !prog.calledGetPixel ? selection : null; }

  /* ImageMath's zeroed copy: the code over the selection's bounding rectangle, every other pixel 0. Then PlugInFilterRunner's
   * reset(mask) puts the source back inside the rectangle where the mask is 0 — unless a pixel called getPixel, whose
   * ImagePlus.getProcessor dropped the mask first. Whole plane at once (the decision needs every pixel's run). */
  async function grayClipped(prog, view, c, check, clip) {
    const W = view.width, src = view.channels[c].data;
    const out = planeArray(view.bitDepth, W * view.height);
    prog.pixelState.getPixelCalled = false;
    await grayRun(prog, view, c, clip, check, out, W, 0, 0);
    if (!prog.pixelState.getPixelCalled) {
      for (let y = clip.y; y < clip.y + clip.h; y++) for (let x = clip.x; x < clip.x + clip.w; x++) if (outsideMask(clip, x, y)) out[y * W + x] = src[y * W + x];
    }
    return out;
  }
  async function rgbClipped(prog, view, res, check, clip) {
    const W = view.width, ch = view.channels;
    prog.pixelState.getPixelCalled = false;
    await rgbRun(prog, view, clip, res, check);
    if (!prog.pixelState.getPixelCalled) {
      for (let y = clip.y; y < clip.y + clip.h; y++) {
        for (let x = clip.x; x < clip.x + clip.w; x++) {
          if (!outsideMask(clip, x, y)) continue;
          const i = y * W + x;
          res[0][i] = ch[0].data[i]; res[1][i] = ch[1].data[i]; res[2][i] = ch[2].data[i];
        }
      }
    }
  }
  function cut(plane, W, rect) {
    const out = new plane.constructor(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) out.set(plane.subarray((rect.y + y) * W + rect.x, (rect.y + y) * W + rect.x + rect.w), y * rect.w);
    return out;
  }

  // One state per plane of an RGB step: the engine prepares the three colour planes of a view in turn and runs them one after the other.
  const RGB_STATES = new WeakMap();

  /* The engine ticks progress after each band it asks for; a band only checks for a cancel, once per row (ImageJ: per row too). */
  if (R && typeof R.define === 'function' && !R.get('macroMath')) {
    R.define('macroMath', {
      kind: 'pixel', version: 1, bitDepths: [8, 16, 32], channels: 'each', roi: 'mask', stack: 'ask', rgb: 'whole', preview: 'region',
      validate(p) {
        if (!p || typeof p.code !== 'string' || p.code.length > MAX_CODE) throw fail('IJ_BAD_ARGS', 'code');
      },
      // a code that names getPixel takes the selection itself (whole plane, or the zeroed copy): see the header
      roiFor: roiModeFor,
      // RGB: the green and blue results of the plane wait in two full planes while the red one is written; a grey code that names
      // getPixel may build its whole plane first (the zeroed copy of a selection)
      scratchBytes(info, p) {
        if (!info) return 0;
        if (info.rgb) return 2 * info.width * info.height;
        return roiModeFor(p) === 'ignore' ? info.width * info.height * ((info.bitDepth | 0) / 8 || 4) : 0;
      },
      /* The apron is the whole plane, so the engine hands region() rectangles in plane coordinates (a preview's work window is then
       * the whole plane, which is what x, y, a and d are relative to); the source pixels are read from the view. */
      prepare(view, c, p, ctx) {
        const code = finalCode(p.code);
        const apron = { x: view.width, y: view.height };
        const check = ctx && typeof ctx.check === 'function' ? () => ctx.check() : () => {};
        const selection = ctx && ctx.selection ? ctx.selection : null;
        if (view.rgb) {
          let st = RGB_STATES.get(view);
          if (!st) { st = { prog: null, res: null, clipped: false }; RGB_STATES.set(view, st); }
          return {
            apron,
            async region(full, rect) {
              if (c === 0) {
                if (!st.prog) {
                  st.prog = await makeProgram(code, view, 0, check);
                  const n = view.width * view.height;
                  st.res = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
                }
                const clip = clipOf(st.prog, selection);
                if (!clip) await rgbRun(st.prog, view, rect, st.res, check);
                else if (!st.clipped) { await rgbClipped(st.prog, view, st.res, check, clip); st.clipped = true; }
              }
              if (!st.res) throw fail('IJ_INTERNAL', 'macroMath colour order');
              return cut(st.res[c], view.width, rect);
            }
          };
        }
        let prog = null, plane = null;
        return {
          apron,
          async region(full, rect) {
            if (!prog) prog = await makeProgram(code, view, c, check);
            const clip = clipOf(prog, selection);
            if (clip) {
              if (!plane) plane = await grayClipped(prog, view, c, check, clip);
              return cut(plane, view.width, rect);
            }
            const out = planeArray(view.bitDepth, rect.w * rect.h);
            await grayRun(prog, view, c, rect, check, out, rect.w, rect.x, rect.y);
            return out;
          }
        };
      }
    });
  }

  root.IJMacroMath = Object.freeze({
    PC_START, MAX_CODE, finalCode, d2i,
    setTexts(t) { if (t && typeof t === 'object') TEXTS = Object.assign({}, TEXTS, t); },
    /** fn(line) receives the print() output of the per-pixel code; null = nowhere (no macro run in progress). → the previous sink. */
    setLogSink(fn) { const old = logSink; logSink = typeof fn === 'function' ? fn : null; return old; }
  });
})(typeof self !== 'undefined' ? self : globalThis);
