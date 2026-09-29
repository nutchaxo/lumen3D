/* ============================================================
   IRIBHM Microscopy Platform — Slice Compositor
   ============================================================
   Colours the RAW channel values of a slice (VolumeSlicer's
   renderRawWithMaterial: RGBA = channels 0..3 as sampled from the
   atlas, rows top-down) with a channel state, so the Studio can
   re-colour a native slice without re-sampling the volume — the
   atlas that produced it is a throwaway one, gone after the pass.

   The colour math is VolumeSlicer's FRAG (channelValue / colorAt),
   term for term, per channel i < numChannels that is enabled:
     v_i = clamp((raw_i/255 − min_i) / max(max_i − min_i, 1e-4), 0, 1)
     v_i = v_i^gamma_i                       (when gamma_i ≠ 1)
     rgb = Σ v_i · opacity_i · colour_i
   output = clamp(rgb, 0, 1)·255 with alpha 255 where |rgb| ≥ 0.005,
   (0, 0, 0, 0) below — for one plane the shader discards those
   fragments and the render target stays transparent there.
   A projected slab (raw.projected: MIP / average, the raw holding the
   per-channel projection) is written the way the slicer's colour path
   writes a slab, vec4(rgb, 1) with no cut-off: every pixel opaque,
   black where no channel shows. With raw.coverage its channel 3 is not
   a channel but the volume's footprint (255 inside, 0 outside), and
   the outside stays (0, 0, 0, 0) as the colour path leaves it.

   GPU path: its own small WebGL2 canvas and program (compare.html
   does not load three.js), the raw uploaded once as an RGBA8 texture
   cached per raw buffer, one draw per compose, drawImage into the 2D
   canvas the caller keeps — no readback. CPU path (no WebGL2, a slice
   larger than MAX_TEXTURE_SIZE, a lost context): 256-entry lookup
   tables per channel and colour component. The CPU path runs the
   formula in double precision; the GPU's float32 (and its pow) can
   land one unit away on a byte at a rounding boundary.
   ============================================================ */

const SliceCompositor = (() => {
  const MAX_CHANNELS = 4;
  // Below this length the slice shader discards the fragment (length(rgb) < 0.005).
  const VISIBLE_MIN = 0.005;
  // The textures kept for recent raw buffers. A Studio document holds one slice (or
  // one per Compare panel); the budget keeps a handful of large ones at most.
  const TEXTURE_BUDGET_BYTES = 256 * 1024 * 1024;
  // A histogram of a few megapixels is exact enough for display and Auto; a native
  // slice can be 30+ Mpx.
  const HISTOGRAM_MAX_SAMPLES = 1 << 22;

  let _glCanvas = null;
  let _gl = null;
  let _program = null;
  let _vao = null;
  let _loc = null;
  let _glFailed = false;
  let _maxTextureSize = 0;
  // raw.data → { texture, bytes, w, h }, in use order (Map keeps insertion order).
  const _textures = new Map();
  let _textureBytes = 0;
  // Histograms computed for a raw object (computed once: a native slice is large).
  const _histograms = new WeakMap();

  // ── Raw slices ───────────────────────────────────────────

  /** true for { data: RGBA bytes, width, height } large enough for its size. */
  function isRaw(raw) {
    if (!raw || typeof raw !== 'object') return false;
    const w = Number(raw.width);
    const h = Number(raw.height);
    // ArrayBuffer.isView rather than instanceof: a Compare panel's raw comes from
    // its iframe, another realm with its own Uint8Array.
    return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0
      && ArrayBuffer.isView(raw.data) && raw.data.BYTES_PER_ELEMENT === 1
      && raw.data.length >= w * h * 4;
  }

  // How a pixel's alpha is decided (see the header): below the visibility threshold
  // transparent (one plane), always opaque (a projected slab), or from the coverage
  // byte in channel 3 (a projected slab of fewer than four channels).
  const ALPHA_THRESHOLD = 0;
  const ALPHA_OPAQUE = 1;
  const ALPHA_COVERAGE = 2;

  function _alphaMode(raw, options) {
    if ((options?.projected ?? raw?.projected) !== true) return ALPHA_THRESHOLD;
    return (options?.coverage ?? raw?.coverage) === true ? ALPHA_COVERAGE : ALPHA_OPAQUE;
  }

  /** The channels to colour: channel 3 of a coverage raw is the footprint, not data. */
  function _numChannels(raw, options) {
    const n = Number(options?.numChannels ?? raw?.channels);
    const count = Number.isFinite(n) && n > 0 ? Math.min(MAX_CHANNELS, Math.floor(n)) : MAX_CHANNELS;
    return _alphaMode(raw, options) === ALPHA_COVERAGE ? Math.min(MAX_CHANNELS - 1, count) : count;
  }

  // ── Channel state → the slicer's uniforms ────────────────

  function _finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * [r, g, b] in 0..1, as renderHighRes's channel overrides read a colour: a string
   * through THREE.Color (three r147, ColorManagement.legacyMode: no colour-space
   * conversion, so '#rrggbb' is component/255), an {r, g, b} object in 0..255.
   * Hex and rgb() are parsed here (compare.html has no three.js); any other CSS
   * colour goes through THREE.Color when present, else through a 2D context.
   */
  function parseColor(color) {
    if (color && typeof color === 'object') {
      return [_finite(color.r, 255) / 255, _finite(color.g, 255) / 255, _finite(color.b, 255) / 255];
    }
    const text = typeof color === 'string' ? color.trim() : '';
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
    if (m) {
      const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
      const n = parseInt(hex, 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(text);
    if (m) return [Math.min(255, +m[1]) / 255, Math.min(255, +m[2]) / 255, Math.min(255, +m[3]) / 255];
    if (!text) return [1, 1, 1];
    if (typeof THREE !== 'undefined' && THREE.Color) {
      try {
        const c = new THREE.Color(text);
        return [c.r, c.g, c.b];
      } catch (_) { /* not a colour three.js knows */ }
    }
    if (typeof document !== 'undefined' && document.createElement) {
      try {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.fillStyle = '#000000';
        ctx.fillStyle = text;
        if (/^#[0-9a-f]{6}$/i.test(ctx.fillStyle)) return parseColor(ctx.fillStyle);
      } catch (_) { /* no canvas */ }
    }
    return [1, 1, 1];
  }

  /**
   * The uniform values the slicer's colour math would use for `channelState`: one
   * entry per channel slot 0..3. A channel with no state object is off (there is
   * nothing to colour it with); a state without `enabled` counts as on, like
   * ChannelPanel (`(enabled ?? active) !== false`).
   */
  function channelParams(channelState, numChannels = MAX_CHANNELS) {
    const n = Math.max(0, Math.min(MAX_CHANNELS, Math.floor(Number(numChannels) || 0)));
    const out = [];
    for (let i = 0; i < MAX_CHANNELS; i++) {
      const s = Array.isArray(channelState) ? channelState[i] : null;
      const on = Boolean(s) && i < n && ((s.enabled !== undefined ? s.enabled : s.active) !== false);
      out.push({
        enabled: on,
        color: s ? parseColor(s.color) : [1, 1, 1],
        min: _finite(s?.min, 0),
        max: _finite(s?.max, 1),
        gamma: _finite(s?.gamma, 1),
        opacity: _finite(s?.opacity, 1)
      });
    }
    return out;
  }

  /** The slicer's channelValue(): windowed, gamma-shaped, scaled by opacity. */
  function _channelValue(raw01, p) {
    let v = (raw01 - p.min) / Math.max(p.max - p.min, 0.0001);
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    if (p.gamma !== 1) v = Math.pow(v, p.gamma);
    return v * p.opacity;
  }

  // ── CPU path ─────────────────────────────────────────────

  function _toByte(x) {
    return Math.round((x < 0 ? 0 : x > 1 ? 1 : x) * 255);
  }

  /**
   * The composed RGBA bytes of `raw` (rows top-down, like raw). `options.lut` (default
   * true) reads each channel's contribution from a 256-entry table per colour
   * component; false evaluates the formula per pixel. Both sum the channels in the
   * same order with the same operands, so they agree to the bit.
   */
  function composePixels(raw, channelState, options = {}) {
    if (!isRaw(raw)) return null;
    const alphaMode = _alphaMode(raw, options);
    const params = channelParams(channelState, _numChannels(raw, options));
    const active = params.map((p, i) => (p.enabled ? i : -1)).filter((i) => i >= 0);
    const n = raw.width * raw.height;
    const src = raw.data;
    const out = options.out && options.out.length >= n * 4 ? options.out : new Uint8ClampedArray(n * 4);
    const useLut = options.lut !== false;
    let luts = null;
    if (useLut) {
      luts = active.map((c) => {
        const p = params[c];
        const r = new Float64Array(256);
        const g = new Float64Array(256);
        const b = new Float64Array(256);
        for (let v = 0; v < 256; v++) {
          const k = _channelValue(v / 255, p);
          r[v] = k * p.color[0];
          g[v] = k * p.color[1];
          b[v] = k * p.color[2];
        }
        return { c, r, g, b };
      });
    }
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      let r = 0;
      let g = 0;
      let b = 0;
      if (useLut) {
        for (let k = 0; k < luts.length; k++) {
          const t = luts[k];
          const v = src[o + t.c];
          r += t.r[v];
          g += t.g[v];
          b += t.b[v];
        }
      } else {
        for (let k = 0; k < active.length; k++) {
          const c = active[k];
          const p = params[c];
          const v = _channelValue(src[o + c] / 255, p);
          r += v * p.color[0];
          g += v * p.color[1];
          b += v * p.color[2];
        }
      }
      const hidden = alphaMode === ALPHA_OPAQUE ? false
        : alphaMode === ALPHA_COVERAGE ? src[o + 3] === 0
          : Math.sqrt(r * r + g * g + b * b) < VISIBLE_MIN;
      if (hidden) {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      } else {
        out[o] = _toByte(r); out[o + 1] = _toByte(g); out[o + 2] = _toByte(b); out[o + 3] = 255;
      }
    }
    return out;
  }

  function _prepareTarget(target, w, h) {
    const canvas = target || document.createElement('canvas');
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return canvas;
  }

  function _composeCpu(raw, channelState, options, target) {
    const canvas = _prepareTarget(target, raw.width, raw.height);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(raw.width, raw.height);
    composePixels(raw, channelState, { ...options, out: img.data });
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // ── GPU path ─────────────────────────────────────────────

  // A triangle covering the viewport, from gl_VertexID alone (no buffer).
  const VERT = `#version 300 es
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;

  const FRAG = `#version 300 es
    precision highp float;
    precision highp int;
    precision highp sampler2D;
    uniform sampler2D uRaw;
    uniform int uHeight;
    uniform int uNumChannels;
    uniform vec3 uColor[4];
    uniform vec4 uMin;
    uniform vec4 uMax;
    uniform vec4 uGamma;
    uniform vec4 uOpacity;
    uniform vec4 uEnabled;
    uniform int uAlphaMode; // 0 threshold (one plane), 1 opaque, 2 coverage in channel 3 (projected slabs)
    out vec4 outColor;

    float channelValue(float raw, float lo, float hi, float gamma, float opacity) {
      float v = clamp((raw - lo) / max(hi - lo, 0.0001), 0.0, 1.0);
      if (gamma != 1.0) v = pow(v, gamma);
      return v * opacity;
    }

    void main() {
      // The raw rows are stored top row first; the framebuffer counts rows from the
      // bottom, and drawImage puts its bottom row at the bottom of the 2D canvas.
      ivec2 p = ivec2(gl_FragCoord.xy);
      vec4 v = texelFetch(uRaw, ivec2(p.x, uHeight - 1 - p.y), 0);
      if (uAlphaMode == 2 && v.a == 0.0) { outColor = vec4(0.0); return; }
      vec3 c = vec3(0.0);
      if (uEnabled.x > 0.5 && uNumChannels > 0) c += channelValue(v.r, uMin.x, uMax.x, uGamma.x, uOpacity.x) * uColor[0];
      if (uEnabled.y > 0.5 && uNumChannels > 1) c += channelValue(v.g, uMin.y, uMax.y, uGamma.y, uOpacity.y) * uColor[1];
      if (uEnabled.z > 0.5 && uNumChannels > 2) c += channelValue(v.b, uMin.z, uMax.z, uGamma.z, uOpacity.z) * uColor[2];
      if (uEnabled.w > 0.5 && uNumChannels > 3) c += channelValue(v.a, uMin.w, uMax.w, uGamma.w, uOpacity.w) * uColor[3];
      if (uAlphaMode == 0 && length(c) < ${VISIBLE_MIN.toFixed(3)}) { outColor = vec4(0.0); return; }
      outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`;

  function _compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`SliceCompositor shader: ${log}`);
    }
    return shader;
  }

  function _buildProgram(gl) {
    const vs = _compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = _compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`SliceCompositor program: ${log}`);
    }
    _program = program;
    _vao = gl.createVertexArray();
    const u = (name) => gl.getUniformLocation(program, name);
    _loc = {
      raw: u('uRaw'), height: u('uHeight'), numChannels: u('uNumChannels'), color: u('uColor'),
      min: u('uMin'), max: u('uMax'), gamma: u('uGamma'), opacity: u('uOpacity'), enabled: u('uEnabled'),
      alphaMode: u('uAlphaMode')
    };
  }

  /** The compositor's context with its program, or null (the CPU path is then used). */
  function _context() {
    if (_glFailed) return null;
    if (_gl) {
      if (_gl.isContextLost()) return null;
      if (!_program) {
        try { _buildProgram(_gl); } catch (err) {
          console.warn('[SliceCompositor] Program rebuild failed; colouring on the CPU.', err);
          _glFailed = true;
          return null;
        }
      }
      return _gl;
    }
    if (typeof document === 'undefined' || !document.createElement) { _glFailed = true; return null; }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const gl = canvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false
      });
      if (!gl) { _glFailed = true; return null; }
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        // Everything the context held is gone; nothing to delete.
        _program = null;
        _vao = null;
        _textures.clear();
        _textureBytes = 0;
      });
      canvas.addEventListener('webglcontextrestored', () => {
        _program = null;
        _vao = null;
        _textures.clear();
        _textureBytes = 0;
      });
      _glCanvas = canvas;
      _gl = gl;
      _maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
      _buildProgram(gl);
      return gl;
    } catch (err) {
      console.warn('[SliceCompositor] WebGL2 unavailable; colouring on the CPU.', err);
      _glFailed = true;
      _gl = null;
      return null;
    }
  }

  function _deleteTexture(key) {
    const entry = _textures.get(key);
    if (!entry) return;
    _textures.delete(key);
    _textureBytes -= entry.bytes;
    if (_gl && !_gl.isContextLost()) _gl.deleteTexture(entry.texture);
  }

  function _textureFor(gl, raw) {
    const key = raw.data;
    const hit = _textures.get(key);
    if (hit && hit.w === raw.width && hit.h === raw.height) {
      // Most recently used last.
      _textures.delete(key);
      _textures.set(key, hit);
      return hit.texture;
    }
    if (hit) _deleteTexture(key);
    const bytes = raw.width * raw.height * 4;
    for (const k of _textures.keys()) {
      if (_textureBytes + bytes <= TEXTURE_BUDGET_BYTES) break;
      _deleteTexture(k);
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const data = raw.data.length === bytes ? raw.data : raw.data.subarray(0, bytes);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, raw.width, raw.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      return null;
    }
    _textures.set(key, { texture, bytes, w: raw.width, h: raw.height });
    _textureBytes += bytes;
    return texture;
  }

  function _composeGpu(raw, channelState, options, target) {
    const gl = _context();
    if (!gl) return null;
    const w = raw.width;
    const h = raw.height;
    if (_maxTextureSize && (w > _maxTextureSize || h > _maxTextureSize)) return null;
    if (_glCanvas.width !== w) _glCanvas.width = w;
    if (_glCanvas.height !== h) _glCanvas.height = h;
    // The browser may give a smaller drawing buffer than asked (memory, viewport cap).
    if (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h) return null;
    const texture = _textureFor(gl, raw);
    if (!texture) return null;

    const params = channelParams(channelState, _numChannels(raw, options));
    const pick = (key) => params.map((p) => p[key]);
    const colors = new Float32Array(12);
    params.forEach((p, i) => colors.set(p.color, i * 3));

    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(_program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(_loc.raw, 0);
    gl.uniform1i(_loc.height, h);
    gl.uniform1i(_loc.numChannels, _numChannels(raw, options));
    gl.uniform3fv(_loc.color, colors);
    gl.uniform4fv(_loc.min, pick('min'));
    gl.uniform4fv(_loc.max, pick('max'));
    gl.uniform4fv(_loc.gamma, pick('gamma'));
    gl.uniform4fv(_loc.opacity, pick('opacity'));
    gl.uniform4fv(_loc.enabled, params.map((p) => (p.enabled ? 1 : 0)));
    gl.uniform1i(_loc.alphaMode, _alphaMode(raw, options));
    gl.bindVertexArray(_vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    if (gl.getError() !== gl.NO_ERROR) return null;

    // Read in the same task as the draw: the drawing buffer is still the frame just
    // drawn (no preserveDrawingBuffer needed). Every pixel is opaque or fully
    // transparent black, so drawing over a cleared canvas copies it exactly.
    const canvas = _prepareTarget(target, w, h);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(_glCanvas, 0, 0);
    return canvas;
  }

  /**
   * `raw` coloured with `channelState` into a 2D canvas of raw.width × raw.height:
   * `options.target` when given (resized if needed — keep one per picture to avoid
   * a new canvas per drag frame), a new canvas otherwise. `options.numChannels`
   * defaults to raw.channels (the volume's channel count, as the slicer's
   * numChannels uniform). `options.projected` / `options.coverage` default to the
   * raw's own flags (VolumeSlicer.renderRawWithMaterial sets them for a slab).
   * `options.cpu` forces the CPU path. null for a malformed raw.
   */
  function compose(raw, channelState, options = {}) {
    if (!isRaw(raw) || typeof document === 'undefined') return null;
    const target = options.target || null;
    if (!options.cpu) {
      try {
        const canvas = _composeGpu(raw, channelState, options, target);
        if (canvas) return canvas;
      } catch (err) {
        console.warn('[SliceCompositor] GPU compose failed; colouring on the CPU.', err);
      }
    }
    try {
      return _composeCpu(raw, channelState, options, target);
    } catch (err) {
      console.warn('[SliceCompositor] CPU compose failed.', err);
      return null;
    }
  }

  // ── Histograms ───────────────────────────────────────────

  /**
   * Per-channel histograms of the slice itself, in the shape VolumeViewer.
   * getChannelHistograms() hands the channel panel: [{ bins, counts, max, total }].
   * Pixels whose channels are all 0 are left out — the frame around the specimen
   * and the space outside the volume, which would otherwise swamp the first bin.
   * A slice larger than HISTOGRAM_MAX_SAMPLES is read on a regular grid of rows
   * and columns (no aliasing onto a single column).
   */
  function histograms(raw, bins = 256, options = {}) {
    if (!isRaw(raw)) return [];
    const nBins = Math.max(2, Math.min(4096, Math.floor(Number(bins) || 256)));
    const numChannels = _numChannels(raw, options);
    const cached = _histograms.get(raw);
    if (cached && cached.bins === nBins && cached.numChannels === numChannels) return _copyHistograms(cached.result);

    const w = raw.width;
    const h = raw.height;
    const d = raw.data;
    const stride = Math.max(1, Math.ceil(Math.sqrt((w * h) / HISTOGRAM_MAX_SAMPLES)));
    const counts = Array.from({ length: numChannels }, () => new Float64Array(nBins));
    for (let y = 0; y < h; y += stride) {
      for (let x = 0, o = y * w * 4; x < w; x += stride, o += stride * 4) {
        let any = 0;
        for (let c = 0; c < numChannels; c++) any |= d[o + c];
        if (!any) continue;
        for (let c = 0; c < numChannels; c++) {
          counts[c][Math.min(nBins - 1, Math.floor((d[o + c] / 256) * nBins))]++;
        }
      }
    }
    const result = counts.map((c) => {
      const list = Array.from(c);
      let max = 1;
      let total = 0;
      for (const v of list) { if (v > max) max = v; total += v; }
      return { bins: nBins, counts: list, max, total };
    });
    _histograms.set(raw, { bins: nBins, numChannels, result });
    return _copyHistograms(result);
  }

  function _copyHistograms(list) {
    return list.map((hist) => ({ ...hist, counts: [...hist.counts] }));
  }

  // ── Memory ───────────────────────────────────────────────

  /**
   * Frees the GPU texture of `raw` (its buffer stays the caller's), or — with no
   * argument — every texture and the drawing buffer of the compositor's canvas.
   */
  function release(raw = null) {
    if (raw) {
      if (raw.data) _deleteTexture(raw.data);
      return;
    }
    for (const key of [..._textures.keys()]) _deleteTexture(key);
    _textureBytes = 0;
    if (_glCanvas) {
      _glCanvas.width = 1;
      _glCanvas.height = 1;
    }
  }

  return {
    isRaw,
    parseColor,
    channelParams,
    composePixels,
    compose,
    histograms,
    release,
    /** Bytes of GPU textures currently held (diagnostics). */
    textureBytes: () => _textureBytes
  };
})();

if (typeof window !== 'undefined') window.SliceCompositor = SliceCompositor;
