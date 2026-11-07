// Admin Data integrity tab: the tab is rebuilt on every dataset result, so the
// control holding keyboard focus and the unfolded findings must survive the rebuild;
// a failed list request is reported; a failed check reads in the operator's language
// and never carries the raw exception text.
//
// Run: node tests/js/test_admin_integrity_focus_errors.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const body = { tagName: 'BODY' };

function fakeNode(tag, attrs, doc) {
  const listeners = {};
  const node = {
    tagName: tag.toUpperCase(), attrs, listeners,
    id: attrs.id || '',
    disabled: 'disabled' in attrs,
    open: 'open' in attrs,
    parent: null, children: [],
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    fire(ev, extra) { (listeners[ev] || []).forEach((fn) => fn({ target: node, ...extra })); },
    focus() { doc.activeElement = node; },
    querySelector(sel) { return node.children.find((c) => c.tagName === sel.toUpperCase()) || null; },
    closest(sel) {
      const attr = sel.replace(/^\[|\]$/g, '');
      for (let n = node; n; n = n.parent) if (n.getAttribute(attr) != null) return n;
      return null;
    },
  };
  return node;
}

// Opening tags of the controls the module touches, with <summary> parented to the
// <details> that encloses it.
function parseTags(html, doc) {
  const nodes = [];
  const stack = [];
  const rx = /<(\/?)(button|input|details|summary)\b([^>]*)>/g;
  let m;
  while ((m = rx.exec(html))) {
    if (m[1]) { if (m[2] === 'details') stack.pop(); continue; }
    const attrs = {};
    const arx = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = arx.exec(m[3]))) attrs[a[1]] = a[2] ?? '';
    const n = fakeNode(m[2], attrs, doc);
    if (stack.length) { n.parent = stack[stack.length - 1]; n.parent.children.push(n); }
    if (m[2] === 'details') stack.push(n);
    nodes.push(n);
  }
  return nodes;
}

function setup({ list, check, tr }) {
  const src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-dataset-integrity.js'), 'utf8')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');

  const doc = { body, documentElement: {}, activeElement: body };
  let nodes = [];
  const root = {
    _html: '',
    set innerHTML(v) {
      this._html = v;
      if (nodes.includes(doc.activeElement)) doc.activeElement = body;   // replaced nodes drop focus
      nodes = parseTags(v, doc);
    },
    get innerHTML() { return this._html; },
    contains: (n) => nodes.includes(n),
    querySelectorAll(sel) {
      const attr = sel.replace(/^\[|\]$/g, '');
      return nodes.filter((n) => n.getAttribute(attr) != null);
    },
  };
  const errors = [];
  const sandbox = {
    JSON, Object, Array, String, Promise, Set, Number, Error,
    console: { error: (...a) => errors.push(a), warn() {}, log() {} },
    document: doc,
    Utils: { datasetTypeLabel: (x) => x },
    t: (k, d, p) => {
      const v = tr ? tr(k, p) : undefined;
      return v === undefined ? d : v;
    },
    escHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    apiFetch: async () => list(),
    fetch: async (url) => check(decodeURIComponent(String(url).split('dataset=')[1])),
    refreshIcons() {},
    el: (id) => (id === 'dataset-integrity-root' ? root : nodes.find((n) => n.id === id) || null),
  };
  vm.runInContext(src + '\n;globalThis.__T = { tab: DatasetIntegrityTab, fetchCheck, run };',
    vm.createContext(sandbox), { filename: 'tab-dataset-integrity.js' });
  return { T: sandbox.__T, root, doc, errors, el: sandbox.el, nodes: () => nodes };
}

const reply = (status, text) => ({ status, text: async () => text });
const flush = () => new Promise((r) => setTimeout(r, 0));
const warnResult = (id) => ({ id, name: id, status: 'warn', findings: [{ level: 'warn', code: 'stray_file', detail: 'x' }] });

// 1. Focus on the filter checkbox and an unfolded row survive every rebuild of a run.
{
  const gates = new Map();
  const datasets = ['3d/a', '3d/b', '3d/c', '3d/d'].map((id) => ({ id, type: '3d', folder: id.slice(3), staged: false }));
  const s = setup({
    list: () => ({ latest: 6, datasets }),
    check: (id) => new Promise((resolve) => gates.set(id, () => resolve(reply(200, JSON.stringify({ result: warnResult(id) }))))),
  });
  s.T.tab.mount();
  const running = s.T.run();
  await flush();
  // First two results arrive; the operator then tabs to the checkbox and unfolds row a.
  gates.get('3d/a')(); gates.get('3d/b')();
  await flush(); await flush();
  s.el('int-problems').focus();
  const detA = s.root.querySelectorAll('[data-int-details]').find((d) => d.getAttribute('data-int-details') === '3d/a');
  assert.ok(detA, 'row a has a findings fold');
  detA.open = true; detA.fire('toggle');

  gates.get('3d/c')();
  await flush(); await flush();
  assert.equal(s.doc.activeElement, s.el('int-problems'), 'the rebuilt checkbox holds focus again');
  assert.match(s.root.innerHTML, /data-int-details="3d\/a" open>/, 'row a is still unfolded after the rebuild');
  assert.doesNotMatch(s.root.innerHTML, /data-int-details="3d\/b" open>/, 'row b stays folded');

  // Focus on a fold's summary is put back on the same row's summary.
  const sumA = s.root.querySelectorAll('[data-int-details]').find((d) => d.getAttribute('data-int-details') === '3d/a').querySelector('summary');
  sumA.focus();
  gates.get('3d/d')();
  await running;
  const sumA2 = s.root.querySelectorAll('[data-int-details]').find((d) => d.getAttribute('data-int-details') === '3d/a').querySelector('summary');
  assert.notEqual(sumA2, sumA, 'the markup was rebuilt');
  assert.equal(s.doc.activeElement, sumA2, 'focus follows the row, not the dead node');
}

// 2. The Run button, disabled during the run, gets focus back when the run ends.
{
  const s = setup({
    list: () => ({ latest: 6, datasets: [{ id: '3d/a', type: '3d', folder: 'a', staged: false }] }),
    check: async (id) => reply(200, JSON.stringify({ result: warnResult(id) })),
  });
  s.T.tab.mount();
  s.el('int-run').focus();
  await s.T.run();
  assert.equal(s.el('int-run').disabled, false);
  assert.equal(s.doc.activeElement, s.el('int-run'), 'keyboard focus returns to the Run button');
}

// 3. A failed list request is reported in the tab, with the cause logged.
{
  let listOk = false;
  const s = setup({
    list: () => (listOk ? { latest: 6, datasets: [{ id: '3d/a', type: '3d', folder: 'a', staged: false }] } : null),
    check: async (id) => reply(200, JSON.stringify({ result: warnResult(id) })),
  });
  s.T.tab.mount();
  assert.doesNotMatch(s.root.innerHTML, /role="alert"/, 'nothing reported before a run');
  await s.T.run();
  assert.match(s.root.innerHTML, /role="alert"/);
  assert.match(s.root.innerHTML, /The list of datasets could not be loaded/);
  assert.equal(s.errors.length, 1, 'the failure is logged to the console');
  // The Run button is the retry; a successful run clears the message.
  listOk = true;
  await s.T.run();
  assert.doesNotMatch(s.root.innerHTML, /role="alert"/);
  assert.match(s.root.innerHTML, /data-int-recheck="3d\/a"/);
}

// 4. Failed checks: translated details, server text kept, no raw exception text.
{
  const row = { id: '3d/a', type: '3d', folder: 'a', staged: false };
  const detail = async (check, tr) => (await setup({ list: () => null, check, tr }).T.fetchCheck(row)).findings[0].detail;

  assert.equal(await detail(async () => reply(401, '')), 'Your session expired: sign in again, then press Recheck.');
  assert.equal(await detail(async () => reply(502, '  ')),
    'HTTP 502: empty answer from the server (a gateway or PHP timeout, or PHP ran out of memory).');
  assert.equal(await detail(async () => reply(500, '<b>Fatal error</b>: Allowed memory size exhausted')),
    'HTTP 500: Fatal error : Allowed memory size exhausted');

  const fr = { 'dint.err401': 'Session expirée : reconnecte-toi.', 'dint.errEmpty': 'HTTP {status} : réponse vide du serveur.' };
  const trFr = (k, p) => (k in fr ? fr[k].replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) : undefined);
  assert.equal(await detail(async () => reply(401, ''), trFr), 'Session expirée : reconnecte-toi.');
  assert.equal(await detail(async () => reply(504, ''), trFr), 'HTTP 504 : réponse vide du serveur.');
  // A translation layer that leaves the parameter unresolved is completed locally.
  assert.equal(await detail(async () => reply(504, ''), (k) => (k === 'dint.errEmpty' ? 'HTTP {status}: leeg' : undefined)), 'HTTP 504: leeg');

  const s = setup({ list: () => null, check: async () => { throw new TypeError('Failed to fetch secret-internal-host'); } });
  const net = (await s.T.fetchCheck(row)).findings[0].detail;
  assert.equal(net, 'Network error: the server could not be reached.');
  assert.doesNotMatch(net, /secret-internal-host/);
  assert.equal(s.errors.length, 1, 'the exception goes to the console');
}

console.log('test_admin_integrity_focus_errors: OK');
