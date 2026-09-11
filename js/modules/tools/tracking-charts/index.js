/* Tracking Charts — index.js
 *
 * Population statistics of a tracked timelapse, per region, over time: how
 * many cells, how fast they move, how many neighbours they have, when they
 * divide. The series are computed from the packed tables the overlay holds
 * (ctx.tracking.getData) in the frame of reference on screen; the neighbour
 * radius is the shared one the inspector sets.
 *
 * Plotly (3.5 MB) is NOT part of the viewer page: it is fetched from the
 * platform's own vendor folder the first time the panel opens, with the same
 * integrity digest the platform pins for it — the strict CSP allows 'self'.
 */
PluginRegistry.implement('tracking-charts', {
  _ctx: null,
  _T: null,
  _panel: null,
  _els: null,
  _unsubs: [],
  _open: false,
  _metric: 'population',
  _scale: 'linear',
  _plotly: null,
  _renderedIn: null,      // { stabilized, threshold } of the last plot

  METRICS: ['population', 'velocity', 'neighbors', 'mitoses'],
  PLOTLY_SRC: 'js/vendor/plotly.min.js',
  PLOTLY_SRI: 'sha384-Hl48Kq2HifOWdXEjMsKo6qxqvRLTYqIGbvlENBmkHAxZKIGCXv43H6W1jA671RzC',

  _t(key, params) { return this._ctx.i18n.t(key, params); },
  _esc(s) { return this._ctx.ui.escapeHtml(s); },

  init(ctx) {
    this._ctx = ctx;
    this._T = ctx.tracking;
    if (!this._T || !this._T.isAvailable()) return this;
    this._panel = ctx.ui.addCanvasPanel({
      id: 'tracking-charts',
      className: 'tracking-chart-panel',
      html: this._html(),
      bind: (root) => this._bind(root)
    });
    this._unsubs = [
      this._T.on('loaded', () => this._render()),
      this._T.on('options', () => this._render()),
      // Only the frame of REFERENCE matters here (stabilised vs raw); the frame
      // index does not, so a scrub never re-plots.
      this._T.on('frame', (d) => { if (this._renderedIn && this._renderedIn.stabilized !== Boolean(d.stabilized)) this._render(); })
    ];
    ctx.i18n.onLanguageChange?.(() => { this._applyLabels(); this._render(); });
    return this;
  },

  activate() {
    this._setOpen(!this._open);
    return { active: this._open };
  },

  getState() { return { open: this._open, metric: this._metric, scale: this._scale }; },

  setState(s) {
    if (!s || typeof s !== 'object') return;
    if (this.METRICS.includes(s.metric)) this._metric = s.metric;
    if (s.scale === 'log' || s.scale === 'linear') this._scale = s.scale;
    this._syncControls();
    this._setOpen(Boolean(s.open));
    PluginRegistry.syncToolbarButton('tracking-charts', { active: this._open });
  },

  reset() {
    this._metric = 'population';
    this._scale = 'linear';
    this._syncControls();
    this._setOpen(false);
    PluginRegistry.syncToolbarButton('tracking-charts', { active: false });
  },

  /** The on-screen plot for the Download Center's graph exports. */
  getGraph() {
    return (this._open && this._renderedIn && this._els?.graph) ? this._els.graph : null;
  },

  dispose() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    if (this._els?.graph && window.Plotly) { try { Plotly.purge(this._els.graph); } catch (_) { /* nothing to purge */ } }
    this._panel?.remove();
    this._panel = null;
  },

  // ── Series (pure functions of the packed tables) ──────────

  /** [{ region, color, x: timepoints, y: values }] for a metric. */
  series(metric, data = this._T.getData(), options = {}) {
    if (!data) return [];
    const F = data.frameCount;
    const R = data.regionNames.length;
    const x = Array.from(data.timepoints);
    const sums = Array.from({ length: R }, () => new Float64Array(F));
    const n = Array.from({ length: R }, () => new Float64Array(F));
    const radius = Number.isFinite(options.neighborThresholdUm) ? options.neighborThresholdUm : this._T.getOptions().neighborThresholdUm;
    const um = [0, 0, 0], prev = [0, 0, 0];

    if (metric === 'neighbors') {
      for (let f = 0; f < F; f++) {
        const cells = this._T.cellsAt(f);
        const pts = cells.map(c => this._T.positionUm(c, f));
        for (let i = 0; i < cells.length; i++) {
          if (!pts[i]) continue;
          let count = 0;
          for (let j = 0; j < cells.length; j++) {
            if (i === j || !pts[j]) continue;
            if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]) <= radius) count++;
          }
          const r = data.regionIdx[cells[i]];
          sums[r][f] += count; n[r][f]++;
        }
      }
      return this._pack(data, x, sums, n, true);
    }

    if (metric === 'mitoses') {
      for (let c = 0; c < data.cellTotal; c++) {
        if (!(data.flags[c] & 1)) continue;
        // The division sits where the daughters start; a cell flagged without
        // daughters (an event the exporter kept but did not link) counts at its
        // own last frame.
        let when = -1;
        for (let k = data.daughterStart[c]; k < data.daughterStart[c + 1]; k++) {
          const d = data.daughterIdx[k];
          if (data.firstFrame[d] >= 0 && (when < 0 || data.firstFrame[d] < when)) when = data.firstFrame[d];
        }
        if (when < 0) when = data.lastFrame[c];
        if (when < 0) continue;
        sums[data.regionIdx[c]][when] += 1;
      }
      return this._pack(data, x, sums, n, false);
    }

    for (let c = 0; c < data.cellTotal; c++) {
      const r = data.regionIdx[c];
      let havePrev = false;
      for (let f = data.firstFrame[c]; f <= data.lastFrame[c]; f++) {
        if (!this._T.positionUm(c, f, {}, um)) { havePrev = false; continue; }
        if (metric === 'velocity') {
          if (havePrev) {
            const dt = Math.max(1e-6, data.timepoints[f] - data.timepoints[f - 1]);
            sums[r][f] += Math.hypot(um[0] - prev[0], um[1] - prev[1], um[2] - prev[2]) / dt;
            n[r][f]++;
          }
          prev[0] = um[0]; prev[1] = um[1]; prev[2] = um[2];
          havePrev = true;
        } else {
          sums[r][f] += 1;
        }
      }
    }
    return this._pack(data, x, sums, n, metric === 'velocity');
  },

  _pack(data, x, sums, n, average) {
    const out = [];
    for (let r = 0; r < data.regionNames.length; r++) {
      const y = Array.from(sums[r], (v, f) => (average ? (n[r][f] ? v / n[r][f] : 0) : v));
      if (!y.some(v => v > 0)) continue;
      out.push({ region: data.regionNames[r], color: data.regionColors[r], x, y });
    }
    return out;
  },

  // ── Private: plotting ─────────────────────────────────────

  _ensurePlotly() {
    if (window.Plotly) return Promise.resolve(window.Plotly);
    if (this._plotly) return this._plotly;
    this._plotly = new Promise((resolve, reject) => {
      // Plotly writes its CSS into <style id="plotly.js-style-global"> at load and
      // reuses that element when it already exists. Under the nonce-locked CSP an
      // element it creates itself has no sheet (blocked), so the registry creates
      // it first with the page nonce — the plugin never sees the nonce.
      if (PluginRegistry.ensureNoncedStyle) PluginRegistry.ensureNoncedStyle('plotly.js-style-global');
      const script = document.createElement('script');
      script.src = this.PLOTLY_SRC;
      script.integrity = this.PLOTLY_SRI;
      script.crossOrigin = 'anonymous';
      script.onload = () => (window.Plotly ? resolve(window.Plotly) : reject(new Error('Plotly did not define itself')));
      script.onerror = () => reject(new Error('Plotly failed to load'));
      document.head.appendChild(script);
    }).catch(err => { this._plotly = null; throw err; });
    return this._plotly;
  },

  _setOpen(on) {
    this._open = Boolean(on);
    this._panel?.toggle(this._open);
    if (this._open) this._render();
  },

  _cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  },

  _render() {
    if (!this._open || !this._els?.graph) return;
    const data = this._T.getData();
    if (!data) { this._els.status.textContent = this._t('loading'); return; }
    this._els.status.textContent = '';
    this._ensurePlotly().then(() => {
      if (!this._open || !this._T.getData()) return;
      const series = this.series(this._metric);
      const bar = this._metric === 'mitoses';
      const traces = series.map(row => ({
        x: row.x,
        y: this._scale === 'log' ? row.y.map(v => (v > 0 ? v : null)) : row.y,
        name: row.region,
        type: bar ? 'bar' : 'scatter',
        mode: bar ? undefined : 'lines',
        marker: { color: row.color },
        line: { shape: 'spline', width: 2, color: row.color }
      }));
      const text = this._cssVar('--text-secondary', '#a0a3b1');
      const grid = this._cssVar('--border-subtle', '#2a2d3a');
      Plotly.newPlot(this._els.graph, traces, {
        margin: { t: 12, l: 42, r: 14, b: 36 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: text, size: 10 },
        xaxis: { title: this._t('axisTime'), gridcolor: grid },
        yaxis: { title: this._t(`axis_${this._metric}`), type: this._scale, gridcolor: grid },
        legend: { orientation: 'h', y: -0.32 },
        barmode: 'stack',
        showlegend: true
      }, { displayModeBar: false, responsive: true });
      this._renderedIn = { stabilized: this._T.isStabilized(), threshold: this._T.getOptions().neighborThresholdUm };
      this._syncTitle();
    }).catch(err => {
      console.warn('[tracking-charts] plot failed:', err);
      if (this._els?.status) this._els.status.textContent = this._t('plotFailed');
    });
  },

  // ── Panel ─────────────────────────────────────────────────

  _html() {
    const esc = (s) => this._esc(s);
    return `
      <div class="scientific-panel-header">
        <strong class="flex items-center gap-2" id="tc-title"><i data-lucide="bar-chart-2" class="w-4 h-4"></i> <span>${esc(this._t('metric_population'))}</span></strong>
        <div class="flex items-center gap-2">
          <button class="btn btn-outline btn-sm active" type="button" data-tc-scale="linear" data-tc="linear">${esc(this._t('linear'))}</button>
          <button class="btn btn-outline btn-sm" type="button" data-tc-scale="log" data-tc="log">${esc(this._t('log'))}</button>
          <button class="btn btn-icon btn-ghost" type="button" id="tc-close" aria-label="${esc(this._t('close'))}"><i data-lucide="x"></i></button>
        </div>
      </div>
      <div class="chart-actions tracking-chart-metrics">
        ${this.METRICS.map(m => `<button class="btn btn-outline btn-sm${m === 'population' ? ' active' : ''}" type="button" data-tc-metric="${m}" data-tc="metric_${m}">${esc(this._t(`metric_${m}`))}</button>`).join('')}
      </div>
      <div id="tc-status" class="text-xs text-muted"></div>
      <div id="tc-graph" class="tracking-chart-graph"></div>`;
  },

  _bind(root) {
    this._els = { graph: root.querySelector('#tc-graph'), status: root.querySelector('#tc-status'), title: root.querySelector('#tc-title span') };
    root.querySelector('#tc-close')?.addEventListener('click', () => {
      this._setOpen(false);
      PluginRegistry.syncToolbarButton('tracking-charts', { active: false });
    });
    root.querySelectorAll('[data-tc-metric]').forEach(btn => btn.addEventListener('click', () => {
      this._metric = btn.getAttribute('data-tc-metric');
      this._syncControls();
      this._render();
    }));
    root.querySelectorAll('[data-tc-scale]').forEach(btn => btn.addEventListener('click', () => {
      this._scale = btn.getAttribute('data-tc-scale') === 'log' ? 'log' : 'linear';
      this._syncControls();
      this._render();
    }));
  },

  _syncControls() {
    const root = this._panel?.root;
    if (!root) return;
    root.querySelectorAll('[data-tc-metric]').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-tc-metric') === this._metric));
    root.querySelectorAll('[data-tc-scale]').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-tc-scale') === this._scale));
    this._syncTitle();
  },

  _syncTitle() {
    if (this._els?.title) this._els.title.textContent = this._t(`metric_${this._metric}`);
  },

  _applyLabels() {
    if (!this._panel) return;
    this._panel.root.querySelectorAll('[data-tc]').forEach(el => { el.textContent = this._t(el.getAttribute('data-tc')); });
    this._syncTitle();
  }
});
