// The quality matrix of a v5 / v6 tree (viewer.js _renderQualityMatrix) is refreshed on
// every timepoint load of a timelapse. It must not replace its buttons when nothing it
// shows changed — a press split between two button nodes is no click, and a focused
// button that is removed sends the focus to <body> — and it must still redraw when
// something it shows does change: the level the GPU holds (qm.active), the GPU budget
// (fit colours), a measured download rate (the times), the chosen quality, the language.
// _loadTimepointInner refreshes the select and the matrix once per load, not twice.
//
// Run: node tests/js/test_viewerpage_quality_matrix_stable.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const src = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  const m = src.match(new RegExp(`\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in viewer.js`);
  return m[0];
}

// ── One refresh per load ──────────────────────────────────────────────────────────
{
  const body = lift('_loadTimepointInner');
  const refreshes = body.match(/_updateQualityOptionLabels\(\)/g) || [];
  assert.equal(refreshes.length, 1, '_loadTimepointInner refreshes the quality controls once per load');
  console.log('one quality refresh per timepoint load: OK');
}

// ── A DOM just large enough for the matrix ────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.className = '';
    this._text = '';
    const self = this;
    this.classList = {
      add(c) { const s = new Set(self.className.split(' ').filter(Boolean)); s.add(c); self.className = [...s].join(' '); },
      remove(c) { self.className = self.className.split(' ').filter(x => x && x !== c).join(' '); },
      toggle(c, on) { (on === undefined ? !this.contains(c) : on) ? this.add(c) : this.remove(c); },
      contains(c) { return self.className.split(' ').includes(c); }
    };
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  appendChild(n) { this.children.push(n); return n; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  querySelector() { return null; }
  buttons() {
    const out = [];
    const walk = (e) => { if (e.tagName === 'button') out.push(e); e.children.forEach(walk); };
    walk(this);
    return out;
  }
}

function makePage({ schema }) {
  const els = { 'quality-matrix': new El('div'), 'select-quality': new El('select') };
  const document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => new El(tag)
  };
  const env = {
    lang: 'en',
    qm: {
      budgetBytes: 2e9,
      levels: [
        { key: 'native', level: 0, target: 'native', dims: { x: 2000, y: 2000, z: 100 }, gpu: { bytes: 1.6e9, planned: true } },
        { key: '1024x1024', level: 1, target: 1024, dims: { x: 1000, y: 1000, z: 100 }, gpu: { bytes: 4e8, planned: true } }
      ],
      columns: schema === 'iribhm-bricks-v6' ? [{ id: 'll' }, { id: 'q30' }] : [{ id: 'll' }, { id: 'b2' }],
      bytes: { 0: { ll: 9e8, b2: 3e8, q30: 1e8 }, 1: { ll: 2e8, b2: 7e7, q30: 2e7 } },
      active: { level: 1 }
    }
  };
  const VolumeViewer = { getQualityMatrix: () => env.qm };
  const tr = (key, fallback, params) => {
    const text = env.lang === 'fr' ? `[fr] ${fallback}` : fallback;
    return text.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
  };
  const code = `
    let _brickManifest = { schema: env.schema, columns: env.qm.columns };
    let _qualityMode = env.schema === 'iribhm-bricks-v6' ? '1024x1024@q30' : '1024x1024@b2';
    let _exportingLossless = false;
    let _qmRenderedKey = null;
    const _rateProbe = env.rateProbe;
    const QUALITY_TIERS = { ll: { label: ['viewer.tierMax', 'Max'], short: ['s', 'Exact'] }, b2: { label: ['viewer.tierExtra', 'Extra'], short: ['s', '±2 levels'] }, q30: { label: ['viewer.tierQ30', 'Q30'] } };
    const _t = (k, f, p) => env.tr(k, f, p);
    const _tf = (k, f, p) => env.tr(k, f, p);
    const Utils = { byteUnits: () => ['B', 'KB', 'MB', 'GB'], formatNumber: (n, d) => Number(n).toFixed(d) };
    const localStorage = { getItem: () => null };
    const performance = { now: () => 0 };
    function _v6DisplayColumn() { return _fastLoading() ? 'q30' : 'll'; }
    ${['_isV5BrickManifest', '_isV6BrickManifest', '_fastLoading', '_qualityBaseOf', '_currentColumn', '_withColumn',
      '_qualityColumnLabel', '_qualityTierText', '_levelName', '_fmtMB', '_fmtDuration', '_etaLabel', '_gpuFit', '_currentQualityParts',
      '_qmOption', '_qmSection', '_guideEl', '_renderQualityMatrix'].map(lift).join('\n')}
    return { render: _renderQualityMatrix, setQuality: (q) => { _qualityMode = q; } };
  `;
  env.schema = schema;
  env.tr = tr;
  env.rateProbe = { bytes: null, at: 0, rate: null };
  const api = new Function('env', 'document', 'VolumeViewer', code)(env, document, VolumeViewer);
  return { api, env, box: els['quality-matrix'] };
}

for (const schema of ['iribhm-bricks-v5', 'iribhm-bricks-v6']) {
  const { api, env, box } = makePage({ schema });
  const label = schema.slice(-2);
  api.render();
  const first = box.buttons();
  assert.ok(first.length >= 2, `${label}: buttons drawn`);
  const active = first.find(b => b.dataset.res === '1024x1024');
  assert.ok(active && active.className.includes('is-active'), `${label}: the chosen resolution is active`);

  // Same picture (a timepoint load): the very same nodes stay.
  api.render();
  api.render();
  assert.ok(box.buttons().every((b, i) => b === first[i]) && box.buttons().length === first.length, `${label}: an unchanged matrix keeps its buttons`);

  // The GPU holds a coarser level than chosen: the note appears.
  api.setQuality(schema.endsWith('v6') ? 'native@q30' : 'native@b2');
  api.render();
  const afterPick = box.buttons();
  assert.notEqual(afterPick[0], first[0], `${label}: a new chosen quality redraws`);
  assert.ok(box.textContent.includes('Shown at 1024'), `${label}: the coarser-level note is shown (${box.textContent})`);
  env.qm = { ...env.qm, active: { level: 0 } };
  api.render();
  assert.ok(!box.textContent.includes('Shown at'), `${label}: qm.active moving to the chosen level drops the note`);

  // The budget shrinks (a context loss, the GPU memory setting): the fit colours change.
  const beforeBudget = box.buttons();
  env.qm = { ...env.qm, budgetBytes: 1e9 };
  api.render();
  const nativeBtn = box.buttons().find(b => b.dataset.res === 'native');
  assert.notEqual(nativeBtn, beforeBudget.find(b => b.dataset.res === 'native'), `${label}: a budget change redraws`);
  assert.ok(nativeBtn.className.includes('qm-over'), `${label}: native no longer fits`);

  // The language changes: the texts are rebuilt.
  const beforeLang = box.buttons();
  env.lang = 'fr';
  api.render();
  assert.notEqual(box.buttons()[0], beforeLang[0], `${label}: a language change redraws`);
  assert.ok(box.textContent.includes('[fr]'), `${label}: translated text`);

  if (!schema.endsWith('v6')) {
    // A download rate measured here adds the times to the quality list.
    const beforeRate = box.buttons();
    env.rateProbe.rate = 5e6;
    api.render();
    assert.notEqual(box.buttons()[0], beforeRate[0], 'v5: a measured rate redraws');
    assert.ok(box.textContent.includes('≈'), 'v5: the time estimate is shown');
    const stable = box.buttons();
    api.render();
    assert.ok(box.buttons().every((b, i) => b === stable[i]), 'v5: the same rate keeps the buttons');
  }
  console.log(`${label} quality matrix: stable when unchanged, redrawn on every visible change: OK`);
}

console.log('quality matrix stability: OK');
