/* ============================================================
   Lumen3D — PageBackground (animated page-background engine)
   ============================================================
   Ambient canvas animations rendered BEHIND page content for the
   white-label page builder: 10 presets (5 passive, 5 mouse-reactive)
   on a single position:fixed canvas at z-index:-1 (pointer-events:none).

   Design constraints (the WHY):
     • body carries an opaque background (var(--bg-body)) that would
       hide a z-index:-1 canvas — so while active, the background is
       moved to <html> (root backgrounds paint beneath negative-z
       children of body) and body is made transparent. clear() restores
       the original inline values.
     • apply() is called on EVERY editor slider tick — scene layout is
       therefore seeded deterministically (mulberry32 per preset key)
       and motion is a pure function of an accumulated phase carried
       across rebuilds, so live param changes are seamless and cheap.
     • Colors may be theme tokens ('var(--color-primary)') or
       'color-mix(…)': they are resolved to concrete rgba through a
       hidden probe element + getComputedStyle, and re-resolved when
       [data-theme] flips (MutationObserver on <html>).
     • Strict CSP: no injected <style>, only inline style="" on the
       elements this module owns.
     • prefers-reduced-motion: reduce ⇒ one static representative
       frame, no animation loop (mouse presets included).
     • Budget < 4 ms/frame: sprite-stamped glows, alpha-bucketed line
       batching (constellation), squared-distance rejects, DPR ≤ 2.
   ============================================================ */

const PageBackground = (() => {
  'use strict';

  const TAU = Math.PI * 2;
  const DPR_CAP = 2;
  const RESIZE_DEBOUNCE_MS = 150;

  // ── Module state (one background per page) ──────────────────────
  const S = {
    active: false,
    canvas: null, g: null,
    probe: null,
    raf: 0, lastT: 0,
    presetKey: '', preset: null, p: null, scene: null,
    w: 1, h: 1, dpr: 1,
    mouse: { x: 0, y: 0, tx: 0, ty: 0, seen: false },
    reduced: false,
    resizeTimer: 0,
    observer: null, mql: null,
    prevHtmlBg: '', prevBodyBg: '',
    domReadyBound: false,
  };
  let _pendingCfg = null;

  // ── Deterministic PRNG — stable layouts across re-applies ───────
  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Math helpers ─────────────────────────────────────────────────
  function wrap(v, m) { v %= m; return v < 0 ? v + m : v; }
  function mod1(v) { v %= 1; return v < 0 ? v + 1 : v; }
  function angleDelta(from, to) { return Math.atan2(Math.sin(to - from), Math.cos(to - from)); }
  function lerpAngle(a, b, f) { return a + angleDelta(a, b) * f; }

  // ── Color resolution (var()/color-mix() → concrete rgba) ────────
  function parseAlphaToken(v) {
    if (v == null || v === '') return 1;
    const n = String(v).endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  }

  function resolveColor(css) {
    const fallback = { r: 128, g: 128, b: 128, a: 1 };
    if (!S.probe || !S.probe.isConnected) return fallback;
    S.probe.style.color = '';
    S.probe.style.color = String(css || '');
    let s = '';
    try { s = getComputedStyle(S.probe).color || ''; } catch (_) { return fallback; }
    // Legacy + modern serializations: rgb(r, g, b) / rgba(…) / rgb(r g b / a)
    let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(s);
    if (m) {
      return {
        r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]),
        a: parseAlphaToken(m[4]),
      };
    }
    // color(srgb r g b / a) — some engines serialize color-mix() this way
    m = /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/.exec(s);
    if (m) {
      return {
        r: Math.round(+m[1] * 255), g: Math.round(+m[2] * 255), b: Math.round(+m[3] * 255),
        a: parseAlphaToken(m[4]),
      };
    }
    return fallback;
  }

  function colStr(c, alphaFactor) {
    const a = Math.max(0, Math.min(1, c.a * alphaFactor));
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a.toFixed(3) + ')';
  }

  function mixColor(a, b, f) {
    if (!b) return a;
    return {
      r: Math.round(a.r + (b.r - a.r) * f),
      g: Math.round(a.g + (b.g - a.g) * f),
      b: Math.round(a.b + (b.b - a.b) * f),
      a: a.a + (b.a - a.a) * f,
    };
  }

  // Pre-rendered soft glow: one drawImage per particle beats per-frame
  // radial gradients or shadowBlur by an order of magnitude.
  function makeGlowSprite(c) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const sg = cv.getContext('2d');
    if (!sg) return cv;
    const gr = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, colStr(c, 1));
    gr.addColorStop(0.35, colStr(c, 0.5));
    gr.addColorStop(1, colStr(c, 0));
    sg.fillStyle = gr;
    sg.fillRect(0, 0, 64, 64);
    return cv;
  }

  // ── Preset descriptors (public, admin field-control compatible) ──
  const PRESETS = [
    {
      key: 'drift', name: 'Particules flottantes', mode: 'passive',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--color-primary)' },
        { k: 'count', lk: 'count', t: 'slider', min: 10, max: 160, step: 1, dv: 60 },
        { k: 'size', lk: 'size', t: 'slider', min: 1, max: 8, step: 0.5, dv: 2.5, unit: 'px' },
        { k: 'speed', lk: 'speed', t: 'slider', min: 0.1, max: 3, step: 0.1, dv: 0.6 },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 5, max: 60, step: 1, dv: 22, unit: '%' },
      ],
    },
    {
      key: 'waves', name: 'Vagues', mode: 'passive',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--color-primary)' },
        { k: 'color2', lk: 'color2', t: 'color', dv: 'var(--color-accent)' },
        { k: 'amplitude', lk: 'amplitude', t: 'slider', min: 10, max: 160, step: 2, dv: 48, unit: 'px' },
        { k: 'speed', lk: 'speed', t: 'slider', min: 0.1, max: 3, step: 0.1, dv: 0.5 },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 4, max: 40, step: 1, dv: 10, unit: '%' },
      ],
    },
    {
      key: 'aurora', name: 'Aurore', mode: 'passive',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--color-primary)' },
        { k: 'color2', lk: 'color2', t: 'color', dv: 'var(--color-accent)' },
        { k: 'count', lk: 'count', t: 'slider', min: 2, max: 6, step: 1, dv: 3 },
        { k: 'size', lk: 'size', t: 'slider', min: 200, max: 900, step: 10, dv: 460, unit: 'px' },
        { k: 'speed', lk: 'speed', t: 'slider', min: 0.05, max: 1.5, step: 0.05, dv: 0.25 },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 4, max: 30, step: 1, dv: 10, unit: '%' },
      ],
    },
    {
      key: 'stars', name: 'Ciel étoilé', mode: 'passive',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--text-primary)' },
        { k: 'count', lk: 'count', t: 'slider', min: 30, max: 400, step: 5, dv: 140 },
        { k: 'size', lk: 'size', t: 'slider', min: 0.5, max: 3, step: 0.1, dv: 1.2, unit: 'px' },
        { k: 'frequency', lk: 'frequency', t: 'slider', min: 0.2, max: 3, step: 0.1, dv: 0.8 },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 10, max: 80, step: 1, dv: 40, unit: '%' },
      ],
    },
    {
      key: 'grid', name: 'Grille pulsante', mode: 'passive',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--color-primary)' },
        { k: 'spacing', lk: 'spacing', t: 'slider', min: 24, max: 120, step: 2, dv: 56, unit: 'px' },
        { k: 'size', lk: 'size', t: 'slider', min: 1, max: 4, step: 0.5, dv: 1.5, unit: 'px' },
        { k: 'speed', lk: 'speed', t: 'slider', min: 0.1, max: 2, step: 0.1, dv: 0.4 },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 4, max: 30, step: 1, dv: 10, unit: '%' },
      ],
    },
    {
      key: 'constellation', name: 'Constellation', mode: 'mouse',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--color-primary)' },
        { k: 'count', lk: 'count', t: 'slider', min: 20, max: 160, step: 1, dv: 70 },
        { k: 'linkDist', lk: 'linkDist', t: 'slider', min: 60, max: 260, step: 5, dv: 140, unit: 'px' },
        { k: 'speed', lk: 'speed', t: 'slider', min: 0.1, max: 2, step: 0.1, dv: 0.5 },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 6, max: 50, step: 1, dv: 18, unit: '%' },
      ],
    },
    {
      key: 'orbs', name: 'Orbes parallaxe', mode: 'mouse',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--color-primary)' },
        { k: 'color2', lk: 'color2', t: 'color', dv: 'var(--color-accent)' },
        { k: 'count', lk: 'count', t: 'slider', min: 2, max: 6, step: 1, dv: 4 },
        { k: 'size', lk: 'size', t: 'slider', min: 120, max: 600, step: 10, dv: 300, unit: 'px' },
        { k: 'depth', lk: 'depth', t: 'slider', min: 5, max: 60, step: 1, dv: 24, unit: 'px' },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 5, max: 30, step: 1, dv: 10, unit: '%' },
      ],
    },
    {
      key: 'ripples', name: 'Ondes du curseur', mode: 'mouse',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--color-primary)' },
        { k: 'radius', lk: 'radius', t: 'slider', min: 80, max: 500, step: 10, dv: 220, unit: 'px' },
        { k: 'speed', lk: 'speed', t: 'slider', min: 0.5, max: 4, step: 0.1, dv: 1.4 },
        { k: 'thickness', lk: 'thickness', t: 'slider', min: 1, max: 6, step: 0.5, dv: 2, unit: 'px' },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 6, max: 50, step: 1, dv: 20, unit: '%' },
      ],
    },
    {
      key: 'flow', name: 'Champ de force', mode: 'mouse',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--color-primary)' },
        { k: 'spacing', lk: 'spacing', t: 'slider', min: 30, max: 110, step: 2, dv: 64, unit: 'px' },
        { k: 'length', lk: 'length', t: 'slider', min: 6, max: 30, step: 1, dv: 13, unit: 'px' },
        { k: 'radius', lk: 'radius', t: 'slider', min: 80, max: 400, step: 10, dv: 180, unit: 'px' },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 5, max: 40, step: 1, dv: 14, unit: '%' },
      ],
    },
    {
      key: 'spotlight', name: 'Halo lumineux', mode: 'mouse',
      params: [
        { k: 'color', lk: 'color', t: 'color', dv: 'var(--color-primary)' },
        { k: 'radius', lk: 'radius', t: 'slider', min: 120, max: 700, step: 10, dv: 340, unit: 'px' },
        { k: 'intensity', lk: 'intensity', t: 'slider', min: 5, max: 45, step: 1, dv: 16, unit: '%' },
        { k: 'speed', lk: 'speed', t: 'slider', min: 0.02, max: 0.3, step: 0.01, dv: 0.08 },
        { k: 'opacity', lk: 'opacity', t: 'slider', min: 3, max: 20, step: 1, dv: 7, unit: '%' },
      ],
    },
  ];

  // ── Preset implementations ───────────────────────────────────────
  // init(sc, rng, prev): build scene arrays (deterministic via rng;
  // prev = previous scene of the SAME preset, for continuity state).
  // draw(sc, g, dt): dt in seconds; dt === 0 means "static frame"
  // (reduced motion) — integrations snap instead of easing.
  const IMPL = {

    drift: {
      init(sc, rng) {
        const n = Math.round(sc.p.count);
        sc.parts = [];
        for (let i = 0; i < n; i++) {
          sc.parts.push({
            x: rng(), y: rng(),
            v: 0.6 + 0.8 * rng(), j: 0.6 + 0.8 * rng(),
            amp: 8 + 26 * rng(), sw: rng() * TAU, tw: rng() * TAU,
          });
        }
        sc.sprite = makeGlowSprite(sc.c1);
      },
      draw(sc, g, dt) {
        const p = sc.p, W = S.w, H = S.h, op = p.opacity / 100;
        sc.ph += dt * p.speed;
        const ph = sc.ph, sp = sc.sprite;
        for (const pt of sc.parts) {
          const yy = mod1(pt.y - ph * 0.022 * pt.v);
          const x = pt.x * W + Math.sin(ph * 0.6 + pt.sw) * pt.amp;
          const y = yy * H;
          const r = p.size * pt.j * 2.6;
          const edge = Math.min(1, yy * 5, (1 - yy) * 5);
          g.globalAlpha = op * (0.55 + 0.45 * Math.sin(ph * 1.7 + pt.tw)) * edge;
          g.drawImage(sp, x - r, y - r, r * 2, r * 2);
        }
        g.globalAlpha = 1;
      },
    },

    waves: {
      init(sc, rng) {
        sc.layers = [];
        for (let i = 0; i < 3; i++) {
          sc.layers.push({
            yb: 0.66 + i * 0.09 + rng() * 0.03,
            f1: 0.8 + rng() * 0.6, f2: 1.7 + rng() * 1.0,
            s1: 0.45 + rng() * 0.3, s2: 0.25 + rng() * 0.2,
            p1: rng() * TAU, p2: rng() * TAU,
            aF: 0.45 + 0.55 * ((i + 1) / 3),
          });
        }
      },
      draw(sc, g, dt) {
        const p = sc.p, W = S.w, H = S.h, op = p.opacity / 100;
        sc.ph += dt * p.speed;
        const step = Math.max(6, W / 160);
        for (let i = 0; i < sc.layers.length; i++) {
          const L = sc.layers[i];
          const col = mixColor(sc.c1, sc.c2, i / (sc.layers.length - 1));
          const A = p.amplitude * (0.7 + i * 0.15);
          g.fillStyle = colStr(col, op * L.aF);
          g.beginPath();
          g.moveTo(-4, H + 4);
          for (let x = -4; x <= W + step; x += step) {
            const u = x / W;
            const y = L.yb * H
              + Math.sin(u * TAU * L.f1 + sc.ph * L.s1 + L.p1) * A * 0.72
              + Math.sin(u * TAU * L.f2 - sc.ph * L.s2 + L.p2) * A * 0.28;
            g.lineTo(x, y);
          }
          g.lineTo(W + 4, H + 4);
          g.closePath();
          g.fill();
        }
      },
    },

    aurora: {
      init(sc, rng) {
        const n = Math.round(sc.p.count);
        sc.blobs = [];
        for (let i = 0; i < n; i++) {
          sc.blobs.push({
            ax: 0.12 + rng() * 0.76, ay: 0.1 + rng() * 0.7,
            rx: 0.08 + rng() * 0.16, ry: 0.06 + rng() * 0.12,
            fa: 0.22 + rng() * 0.3, fb: 0.18 + rng() * 0.26,
            pa: rng() * TAU, pb: rng() * TAU,
            j: 0.7 + rng() * 0.6, m: n > 1 ? i / (n - 1) : 0.5,
            rot: rng() * Math.PI, sq: 0.42 + rng() * 0.26,
          });
        }
      },
      draw(sc, g, dt) {
        const p = sc.p, W = S.w, H = S.h, op = p.opacity / 100;
        sc.ph += dt * p.speed;
        for (const b of sc.blobs) {
          const x = (b.ax + Math.sin(sc.ph * b.fa + b.pa) * b.rx) * W;
          const y = (b.ay + Math.cos(sc.ph * b.fb + b.pb) * b.ry) * H;
          const r = Math.max(20, p.size * b.j * 0.5);
          const col = mixColor(sc.c1, sc.c2, b.m);
          g.save();
          g.translate(x, y);
          g.rotate(b.rot + Math.sin(sc.ph * 0.2 + b.pa) * 0.3);
          g.scale(1, b.sq);
          const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
          gr.addColorStop(0, colStr(col, op));
          gr.addColorStop(0.55, colStr(col, op * 0.45));
          gr.addColorStop(1, colStr(col, 0));
          g.fillStyle = gr;
          g.fillRect(-r, -r, r * 2, r * 2);
          g.restore();
        }
      },
    },

    stars: {
      init(sc, rng) {
        const n = Math.round(sc.p.count);
        sc.stars = [];
        for (let i = 0; i < n; i++) {
          const big = rng() < 0.07;
          sc.stars.push({
            x: rng(), y: rng(),
            f: 0.5 + 1.1 * rng(), ph: rng() * TAU,
            j: 0.6 + 0.8 * rng(), big, b: big ? 1 : 0.75,
          });
        }
      },
      draw(sc, g, dt) {
        const p = sc.p, W = S.w, H = S.h, op = p.opacity / 100;
        sc.ph += dt * p.frequency;
        g.fillStyle = colStr(sc.c1, 1);
        for (const st of sc.stars) {
          const tw = 0.5 + 0.5 * Math.sin(sc.ph * st.f * 3 + st.ph);
          g.globalAlpha = op * (0.25 + 0.75 * tw) * st.b;
          const r = p.size * st.j * (st.big ? 1.7 : 1) * 0.5;
          const x = st.x * W, y = st.y * H;
          if (r < 0.6) g.fillRect(x, y, 1, 1);
          else { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
        }
        g.globalAlpha = 1;
      },
    },

    grid: {
      init() { /* pure function of spacing + phase */ },
      draw(sc, g, dt) {
        const p = sc.p, W = S.w, H = S.h, op = p.opacity / 100;
        sc.ph += dt * p.speed;
        // Floor the spacing so the dot count stays bounded (~6k) regardless of
        // viewport — the min slider value (24px) on a 4K screen would otherwise
        // draw ~15k dots/frame and blow the frame budget.
        const sp = Math.max(8, p.spacing, Math.sqrt((W * H) / 6000));
        const r = p.size / 2;
        const diag = W + H;
        const cols = Math.ceil(W / sp) + 1, rows = Math.ceil(H / sp) + 1;
        // arcs read better for big dots, but rects keep dense grids in budget
        const useArc = r > 1.1 && cols * rows <= 2600;
        const ox = (W % sp) / 2, oy = (H % sp) / 2;
        g.fillStyle = colStr(sc.c1, 1);
        for (let y = oy; y <= H; y += sp) {
          for (let x = ox; x <= W; x += sp) {
            const wv = 0.5 + 0.5 * Math.sin(((x + y) / diag) * TAU * 1.6 - sc.ph * 2.4);
            g.globalAlpha = op * (0.2 + 0.8 * wv);
            if (useArc) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
            else g.fillRect(x - r, y - r, r * 2, r * 2);
          }
        }
        g.globalAlpha = 1;
      },
    },

    constellation: {
      init(sc, rng) {
        const n = Math.round(sc.p.count);
        sc.parts = [];
        for (let i = 0; i < n; i++) {
          const ang = rng() * TAU;
          const v = 0.5 + rng();
          sc.parts.push({ x0: rng(), y0: rng(), dx: Math.cos(ang) * v, dy: Math.sin(ang) * v });
        }
        sc.xs = new Array(n); sc.ys = new Array(n);
        sc.buckets = [];
        for (let i = 0; i < 8; i++) sc.buckets.push([]);
      },
      draw(sc, g, dt) {
        const p = sc.p, W = S.w, H = S.h, op = p.opacity / 100;
        sc.ph += dt * p.speed;
        const ph = sc.ph, n = sc.parts.length;
        // wrap in a margin band so particles fade in offscreen, not at the edge
        const xr = W + 120, yr = H + 120;
        for (let i = 0; i < n; i++) {
          const pt = sc.parts[i];
          sc.xs[i] = wrap(pt.x0 * xr + pt.dx * ph * 30, xr) - 60;
          sc.ys[i] = wrap(pt.y0 * yr + pt.dy * ph * 30, yr) - 60;
        }
        const L = p.linkDist, L2 = L * L;
        const bks = sc.buckets;
        for (const b of bks) b.length = 0;
        // quantize line alpha into 8 buckets → 8 stroke calls instead of hundreds
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const dx = sc.xs[i] - sc.xs[j]; if (dx > L || dx < -L) continue;
            const dy = sc.ys[i] - sc.ys[j]; if (dy > L || dy < -L) continue;
            const d2 = dx * dx + dy * dy;
            if (d2 > L2) continue;
            const f = 1 - Math.sqrt(d2) / L;
            bks[Math.min(7, (f * 8) | 0)].push(sc.xs[i], sc.ys[i], sc.xs[j], sc.ys[j]);
          }
        }
        const mx = S.mouse.x, my = S.mouse.y, ML = L * 1.25, ML2 = ML * ML;
        for (let i = 0; i < n; i++) {
          const dx = sc.xs[i] - mx; if (dx > ML || dx < -ML) continue;
          const dy = sc.ys[i] - my; if (dy > ML || dy < -ML) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 > ML2) continue;
          const f = Math.min(1, (1 - Math.sqrt(d2) / ML) * 1.4);
          bks[Math.min(7, (f * 8) | 0)].push(sc.xs[i], sc.ys[i], mx, my);
        }
        g.strokeStyle = colStr(sc.c1, 1);
        g.lineWidth = 1;
        for (let bi = 0; bi < 8; bi++) {
          const b = bks[bi];
          if (!b.length) continue;
          g.globalAlpha = op * ((bi + 0.5) / 8);
          g.beginPath();
          for (let k = 0; k < b.length; k += 4) { g.moveTo(b[k], b[k + 1]); g.lineTo(b[k + 2], b[k + 3]); }
          g.stroke();
        }
        g.fillStyle = colStr(sc.c1, 1);
        g.globalAlpha = Math.min(1, op * 2.2);
        for (let i = 0; i < n; i++) { g.beginPath(); g.arc(sc.xs[i], sc.ys[i], 1.6, 0, TAU); g.fill(); }
        g.globalAlpha = 1;
      },
    },

    orbs: {
      init(sc, rng, prev) {
        const n = Math.round(sc.p.count);
        sc.orbs = [];
        for (let i = 0; i < n; i++) {
          sc.orbs.push({
            ax: 0.15 + rng() * 0.7, ay: 0.15 + rng() * 0.6,
            fa: 0.3 + rng() * 0.4, fb: 0.25 + rng() * 0.35,
            pa: rng() * TAU, pb: rng() * TAU,
            j: 0.7 + rng() * 0.6, m: n > 1 ? i / (n - 1) : 0.5,
            dF: 0.35 + 0.65 * (n > 1 ? i / (n - 1) : 1),
            ox: 0, oy: 0,
          });
        }
        if (prev && prev.orbs && prev.orbs.length === n) {
          for (let i = 0; i < n; i++) { sc.orbs[i].ox = prev.orbs[i].ox; sc.orbs[i].oy = prev.orbs[i].oy; }
        }
      },
      draw(sc, g, dt) {
        const p = sc.p, W = S.w, H = S.h, op = p.opacity / 100;
        sc.ph += dt * 0.18;
        const cx = W / 2, cy = H / 2;
        const nx = (S.mouse.x - cx) / Math.max(1, cx);
        const ny = (S.mouse.y - cy) / Math.max(1, cy);
        for (const o of sc.orbs) {
          // deeper layers ease slower → layered parallax lag
          const k = dt === 0 ? 1 : 1 - Math.exp(-dt * (1.2 + 2.8 * o.dF));
          o.ox += (nx * p.depth * o.dF - o.ox) * k;
          o.oy += (ny * p.depth * o.dF - o.oy) * k;
          const x = o.ax * W + Math.sin(sc.ph * o.fa + o.pa) * W * 0.03 + o.ox;
          const y = o.ay * H + Math.cos(sc.ph * o.fb + o.pb) * H * 0.03 + o.oy;
          const r = Math.max(8, p.size * o.j * 0.5);
          const col = mixColor(sc.c1, sc.c2, o.m);
          const gr = g.createRadialGradient(x, y, 0, x, y, r);
          gr.addColorStop(0, colStr(col, op));
          gr.addColorStop(0.6, colStr(col, op * 0.38));
          gr.addColorStop(1, colStr(col, 0));
          g.fillStyle = gr;
          g.fillRect(x - r, y - r, r * 2, r * 2);
        }
      },
    },

    ripples: {
      init(sc, rng, prev) {
        sc.rings = prev && prev.rings ? prev.rings : [];
        sc.lx = prev ? prev.lx : -1e4;
        sc.ly = prev ? prev.ly : -1e4;
        sc.lt = prev ? prev.lt : 0;
        sc.idleT = prev ? prev.idleT : 2.0;
        if (S.reduced && !sc.rings.length) {
          for (let i = 1; i <= 3; i++) {
            sc.rings.push({ x: S.w / 2, y: S.h / 2, r: sc.p.radius * i * 0.22 });
          }
        }
      },
      draw(sc, g, dt) {
        const p = sc.p, op = p.opacity / 100;
        if (!S.mouse.seen && !S.reduced) {
          sc.idleT += dt;
          if (sc.idleT > 2.6) {
            sc.idleT = 0;
            sc.rings.push({
              x: S.w / 2 + (Math.random() - 0.5) * S.w * 0.2,
              y: S.h / 2 + (Math.random() - 0.5) * S.h * 0.2,
              r: 2,
            });
          }
        }
        const maxR = p.radius, grow = p.speed * 110;
        g.strokeStyle = colStr(sc.c1, 1);
        let keep = 0;
        for (let i = 0; i < sc.rings.length; i++) {
          const ring = sc.rings[i];
          ring.r += dt * grow;
          const prog = ring.r / maxR;
          if (prog >= 1) continue;
          sc.rings[keep++] = ring;
          g.globalAlpha = op * Math.pow(1 - prog, 1.6);
          g.lineWidth = Math.max(0.5, p.thickness * (1 - prog * 0.55));
          g.beginPath();
          g.arc(ring.x, ring.y, ring.r, 0, TAU);
          g.stroke();
        }
        sc.rings.length = keep;
        g.globalAlpha = 1;
      },
    },

    flow: {
      init(sc, rng, prev) {
        const sp = sc.p.spacing;
        const jx = rng() * 1000, jy = rng() * 1000;
        sc.cells = [];
        for (let y = sp * 0.5; y < S.h + sp * 0.5; y += sp) {
          for (let x = sp * 0.5; x < S.w + sp * 0.5; x += sp) {
            const base = (Math.sin((x + jx) * 0.0038) + Math.cos((y + jy) * 0.0043)) * 1.15;
            sc.cells.push({ x, y, base, a: base });
          }
        }
        if (prev && prev.cells && prev.cells.length === sc.cells.length) {
          for (let i = 0; i < sc.cells.length; i++) sc.cells[i].a = prev.cells[i].a;
        }
        sc.bright = [];
      },
      draw(sc, g, dt) {
        const p = sc.p, op = p.opacity / 100;
        sc.ph += dt * 0.35;
        const R = p.radius, R2 = R * R, half = p.length / 2;
        const mx = S.mouse.x, my = S.mouse.y;
        const ease = 1 - Math.exp(-dt * 5);
        const bright = sc.bright;
        bright.length = 0;
        g.strokeStyle = colStr(sc.c1, 1);
        g.lineWidth = 1.2;
        g.lineCap = 'round';
        g.beginPath();
        for (const c of sc.cells) {
          let target = c.base + Math.sin(sc.ph + (c.x + c.y) * 0.002) * 0.45;
          const dx = c.x - mx, dy = c.y - my;
          const d2 = dx * dx + dy * dy;
          let w = 0;
          if (d2 < R2) {
            const d = Math.sqrt(d2);
            w = 1 - d / R; w *= w;
            target = lerpAngle(target, Math.atan2(dy, dx), Math.min(0.92, w * 1.2));
          }
          if (dt === 0) c.a = target;
          else c.a += angleDelta(c.a, target) * ease;
          const ca = Math.cos(c.a) * half, sa = Math.sin(c.a) * half;
          const x1 = c.x - ca, y1 = c.y - sa, x2 = c.x + ca, y2 = c.y + sa;
          g.moveTo(x1, y1); g.lineTo(x2, y2);
          if (w > 0.1) bright.push(x1, y1, x2, y2);
        }
        g.globalAlpha = op;
        g.stroke();
        if (bright.length) {
          // second pass overdraws cursor-bent strokes slightly brighter
          g.globalAlpha = Math.min(1, op * 1.4);
          g.beginPath();
          for (let k = 0; k < bright.length; k += 4) { g.moveTo(bright[k], bright[k + 1]); g.lineTo(bright[k + 2], bright[k + 3]); }
          g.stroke();
        }
        g.globalAlpha = 1;
      },
    },

    spotlight: {
      init(sc, rng, prev) {
        const sp = 46;
        sc.dots = [];
        for (let y = sp / 2; y < S.h + sp; y += sp) {
          for (let x = sp / 2; x < S.w + sp; x += sp) {
            sc.dots.push({
              x: x + (rng() - 0.5) * sp * 0.7,
              y: y + (rng() - 0.5) * sp * 0.7,
              a: 0.35 + rng() * 0.65,
            });
          }
        }
        sc.sx = prev ? prev.sx : S.mouse.x;
        sc.sy = prev ? prev.sy : S.mouse.y;
      },
      draw(sc, g, dt) {
        const p = sc.p, op = p.opacity / 100;
        // p.speed is the lag factor: ≈ per-frame lerp amount at 60 fps
        const k = dt === 0 ? 1 : 1 - Math.exp(-dt * p.speed * 60);
        sc.sx += (S.mouse.x - sc.sx) * k;
        sc.sy += (S.mouse.y - sc.sy) * k;
        g.fillStyle = colStr(sc.c1, 1);
        for (const d of sc.dots) {
          g.globalAlpha = op * d.a;
          g.fillRect(d.x, d.y, 1.4, 1.4);
        }
        const R = p.radius, ia = p.intensity / 100;
        const gr = g.createRadialGradient(sc.sx, sc.sy, 0, sc.sx, sc.sy, R);
        gr.addColorStop(0, colStr(sc.c1, ia));
        gr.addColorStop(0.55, colStr(sc.c1, ia * 0.35));
        gr.addColorStop(1, colStr(sc.c1, 0));
        g.globalAlpha = 1;
        g.fillStyle = gr;
        g.fillRect(sc.sx - R, sc.sy - R, R * 2, R * 2);
      },
    },
  };

  // ── Engine ───────────────────────────────────────────────────────
  function sizeCanvas() {
    const dpr = Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1));
    S.dpr = dpr;
    // Match the canvas CSS box (position:fixed;inset:0), which is the layout
    // viewport EXCLUDING a classic scrollbar. window.innerWidth/Height INCLUDE
    // it (~15px on Windows), which would stretch the drawing and offset the
    // cursor for mouse presets. documentElement.clientWidth/Height excludes it
    // and matches the client-space pointer coords.
    const de = document.documentElement;
    S.w = Math.max(1, de.clientWidth || window.innerWidth);
    S.h = Math.max(1, de.clientHeight || window.innerHeight);
    S.canvas.width = Math.round(S.w * dpr);
    S.canvas.height = Math.round(S.h * dpr);
    S.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!S.mouse.seen) {
      S.mouse.x = S.mouse.tx = S.w / 2;
      S.mouse.y = S.mouse.ty = S.h / 2;
    }
  }

  function rebuildScene(preservePhase) {
    const impl = IMPL[S.presetKey];
    if (!impl) return;
    const rng = mulberry32(hashSeed(S.presetKey));
    const prev = preservePhase ? S.scene : null;
    const sc = {
      p: S.p,
      ph: prev ? prev.ph : 20 + rng() * 40,
      c1: resolveColor(S.p.color),
      c2: ('color2' in S.p) ? resolveColor(S.p.color2) : null,
    };
    impl.init(sc, rng, prev);
    S.scene = sc;
  }

  function tick(ts) {
    S.raf = requestAnimationFrame(tick);
    if (!S.scene || !S.g) return;
    const t = ts / 1000;
    let dt = S.lastT ? t - S.lastT : 1 / 60;
    S.lastT = t;
    if (dt > 0.1) dt = 0.1;           // clamp jank spikes (tab jank, breakpoints)
    if (dt <= 0) dt = 0.001;          // dt === 0 is reserved for static frames
    const m = S.mouse;
    if (!m.seen) {
      // no pointer yet → gentle orbit around viewport center
      m.tx = S.w * 0.5 + Math.cos(t * 0.31) * S.w * 0.08;
      m.ty = S.h * 0.5 + Math.sin(t * 0.23) * S.h * 0.08;
    }
    const mk = 1 - Math.exp(-dt * 7);
    m.x += (m.tx - m.x) * mk;
    m.y += (m.ty - m.y) * mk;
    S.g.clearRect(0, 0, S.w, S.h);
    IMPL[S.presetKey].draw(S.scene, S.g, dt);
  }

  function drawStatic() {
    if (!S.g || !S.scene) return;
    if (!S.mouse.seen) {
      S.mouse.x = S.mouse.tx = S.w / 2;
      S.mouse.y = S.mouse.ty = S.h / 2;
    }
    S.g.clearRect(0, 0, S.w, S.h);
    IMPL[S.presetKey].draw(S.scene, S.g, 0);
  }

  function startLoop() {
    stopLoop();
    S.lastT = 0;
    if (document.hidden) return;      // resumed by visibilitychange
    S.raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
  }

  // ── Event handlers (named, so clear() can detach them) ──────────
  function onPointer(e) {
    const m = S.mouse;
    m.tx = e.clientX;
    m.ty = e.clientY;
    if (!m.seen) { m.seen = true; m.x = e.clientX; m.y = e.clientY; }
    // ripples spawn here (throttled by travel distance + time)
    const sc = S.scene;
    if (sc && S.presetKey === 'ripples' && !S.reduced) {
      const dx = e.clientX - sc.lx, dy = e.clientY - sc.ly;
      const now = performance.now();
      if (dx * dx + dy * dy >= 1600 && now - sc.lt >= 70) {
        sc.lx = e.clientX; sc.ly = e.clientY; sc.lt = now;
        sc.rings.push({ x: e.clientX, y: e.clientY, r: 2 });
        if (sc.rings.length > 40) sc.rings.shift();
      }
    }
  }

  function onResize() {
    if (!S.active) return;
    clearTimeout(S.resizeTimer);
    S.resizeTimer = setTimeout(() => {
      S.resizeTimer = 0;
      if (!S.active) return;
      sizeCanvas();
      rebuildScene(true);
      if (S.reduced) drawStatic();
    }, RESIZE_DEBOUNCE_MS);
  }

  function onVisibility() {
    if (!S.active) return;
    if (document.hidden) stopLoop();
    else if (!S.reduced) startLoop();
  }

  function onThemeChange() {
    if (!S.active || !S.scene) return;
    rebuildScene(true);               // re-resolves var() colors + sprites
    if (S.reduced) drawStatic();
  }

  function onMotionPref() {
    if (!S.active) return;
    S.reduced = !!(S.mql && S.mql.matches);
    if (S.reduced) { stopLoop(); drawStatic(); }
    else startLoop();
  }

  function onDomReady() {
    S.domReadyBound = false;
    if (_pendingCfg) {
      const cfg = _pendingCfg;
      _pendingCfg = null;
      apply(cfg);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  function activate() {
    const c = document.createElement('canvas');
    c.setAttribute('data-page-background', '');
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;display:block;';
    const g = c.getContext('2d');
    if (!g) return false;
    document.body.appendChild(c);
    S.canvas = c;
    S.g = g;

    S.probe = document.createElement('span');
    S.probe.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;';
    document.body.appendChild(S.probe);

    // body's opaque background would cover a negative-z canvas: move it
    // to the root element (paints beneath everything) for the duration.
    S.prevHtmlBg = document.documentElement.style.background;
    S.prevBodyBg = document.body.style.background;
    document.documentElement.style.background = 'var(--bg-body)';
    document.body.style.background = 'transparent';

    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onPointer, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    S.mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (typeof S.mql.addEventListener === 'function') S.mql.addEventListener('change', onMotionPref);
    else if (S.mql.addListener) S.mql.addListener(onMotionPref);

    S.observer = new MutationObserver(onThemeChange);
    S.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    sizeCanvas();
    S.active = true;
    return true;
  }

  /**
   * Activate (or live-update) a background.
   * @param {{preset: string, params?: Object}} config — params are partial
   *        and merged over the preset defaults. Falsy config, empty or
   *        unknown preset ⇒ clear().
   */
  function apply(config) {
    const key = (config && typeof config === 'object') ? String(config.preset || '') : '';
    let preset = null;
    if (key) { for (const pr of PRESETS) { if (pr.key === key) { preset = pr; break; } } }
    if (!preset) { clear(); return; }
    if (!document.body) {
      // called before <body> exists — defer to DOMContentLoaded
      _pendingCfg = config;
      if (!S.domReadyBound) {
        S.domReadyBound = true;
        document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
      }
      return;
    }
    const sameKey = S.active && S.presetKey === key;
    if (!S.active && !activate()) return;
    S.presetKey = key;
    S.preset = preset;

    const src = (config.params && typeof config.params === 'object') ? config.params : {};
    const p = {};
    for (const d of preset.params) {
      let v = (src[d.k] != null && src[d.k] !== '') ? src[d.k] : d.dv;
      if (d.t === 'slider') {
        v = Number(v);
        if (!isFinite(v)) v = d.dv;
        v = Math.min(d.max, Math.max(d.min, v));
      } else {
        v = String(v);
      }
      p[d.k] = v;
    }
    S.p = p;
    S.reduced = !!(S.mql && S.mql.matches);
    rebuildScene(sameKey);
    if (S.reduced) { stopLoop(); drawStatic(); }
    else if (!S.raf) startLoop();
  }

  /** Full teardown: canvas, rAF, listeners, observers, inline styles. */
  function clear() {
    stopLoop();
    if (S.resizeTimer) { clearTimeout(S.resizeTimer); S.resizeTimer = 0; }
    _pendingCfg = null;
    if (S.domReadyBound) {
      document.removeEventListener('DOMContentLoaded', onDomReady);
      S.domReadyBound = false;
    }
    if (S.observer) { S.observer.disconnect(); S.observer = null; }
    if (S.mql) {
      if (typeof S.mql.removeEventListener === 'function') S.mql.removeEventListener('change', onMotionPref);
      else if (S.mql.removeListener) S.mql.removeListener(onMotionPref);
      S.mql = null;
    }
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onPointer);
    document.removeEventListener('visibilitychange', onVisibility);
    if (S.canvas) { S.canvas.remove(); S.canvas = null; S.g = null; }
    if (S.probe) { S.probe.remove(); S.probe = null; }
    if (S.active) {
      document.documentElement.style.background = S.prevHtmlBg || '';
      if (document.body) document.body.style.background = S.prevBodyBg || '';
    }
    S.active = false;
    S.presetKey = '';
    S.preset = null;
    S.p = null;
    S.scene = null;
    S.lastT = 0;
    S.prevHtmlBg = '';
    S.prevBodyBg = '';
    S.mouse.seen = false;
    S.reduced = false;
  }

  return { PRESETS, apply, clear };
})();
