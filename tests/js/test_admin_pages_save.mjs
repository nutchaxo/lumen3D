// Page-builder save pipeline, run against the REAL tab-pages.js with a scripted
// server:
//   * a background save never reverts a publish (save_draft writes the draft alone),
//   * a save against a revision that moved on (another editor) is a 409: nothing is
//     written, the tab stops autosaving until the operator takes the page over,
//   * a failed autosave is visible, retried, and survives a page switch prompt,
//   * switching page saves the old page first and never writes it into the new one,
//   * publish and autosave are serialised,
//   * a load failure blocks saving instead of blanking the page,
//   * a corrupt document (null entries) still opens,
//   * frame messages with bad indices cannot throw.
//
// Run: node tests/js/test_admin_pages_save.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

function load() {
  let src = readFileSync(path.join(ROOT, 'js/pages/admin/tab-pages.js'), 'utf8')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(function|const|let|class)/gm, '$1');

  // ── virtual clock ──
  let now = 0, nextId = 1;
  const timers = new Map();
  const st = (fn, ms) => { const id = nextId++; timers.set(id, { at: now + (ms || 0), fn }); return id; };
  const ct = (id) => { timers.delete(id); };
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await flush();
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      timers.delete(next.id); now = Math.max(now, next.t.at); next.t.fn();
    }
    now = end; await flush();
  }

  // ── scripted server ──
  // Like api/site.php: a get answers with the doc's revision, save_draft writes the
  // draft (and title) only and refuses a stale ?rev= with 409, every write moves
  // the revision on.
  const server = { docs: new Map(), revs: new Map(), log: [], failSaves: 0, failGets: false, getDelay: null };
  const parse = (url) => {
    const u = new URL(url, 'http://h/');
    return { action: u.searchParams.get('action'), doc: u.searchParams.get('doc'), rev: u.searchParams.get('rev') };
  };
  const revOf = (doc) => `r${server.revs.get(doc) || 0}`;
  const bump = (doc) => server.revs.set(doc, (server.revs.get(doc) || 0) + 1);
  server.touch = bump;   // a write made by another editor
  async function apiFetchStatus(url, opts = {}) {
    const { action, doc, rev } = parse(url);
    if (action === 'get') {
      if (server.getDelay) await server.getDelay(doc);
      if (server.failGets) return { ok: false, status: 500, data: null, rev: null };
      const d = server.docs.get(doc);
      return { ok: true, status: 200, data: d ? JSON.parse(JSON.stringify(d)) : {}, rev: revOf(doc) };
    }
    if (action === 'save_draft') {
      const body = JSON.parse(opts.body);
      server.log.push({ action, doc, body, rev });
      if (server.failSaves > 0) { server.failSaves--; return { ok: false, status: server.failStatus || 500, data: null }; }
      if (rev && rev !== revOf(doc)) return { ok: false, status: 409, data: { error: 'stale', rev: revOf(doc) } };
      const d = server.docs.get(doc) || {};
      d.draft = body.draft;
      if ('title' in body) d.title = body.title;
      server.docs.set(doc, d);
      bump(doc);
      return { ok: true, status: 200, data: { ok: true, rev: revOf(doc) } };
    }
    if (action === 'save') {
      server.log.push({ action, doc, body: JSON.parse(opts.body) });
      server.docs.set(doc, JSON.parse(opts.body));
      bump(doc);
      return { ok: true, status: 200, data: { ok: true, rev: revOf(doc) } };
    }
    if (action === 'publish') {
      server.log.push({ action, doc });
      const d = server.docs.get(doc) || {};
      d.published = JSON.parse(JSON.stringify(d.draft || {}));
      server.docs.set(doc, d);
      bump(doc);
      return { ok: true, status: 200, data: { ok: true, rev: revOf(doc) } };
    }
    return { ok: true, status: 200, data: {} };
  }

  const nodes = {};
  // Only the editor frame exists; every other panel is absent, as before the editor opens.
  const mkEl = (id) => (id === 'pages-frame' ? (nodes[id] ||= { id, contentWindow: { postMessage() {} }, style: {} }) : null);
  const confirms = [];
  const sandbox = {
    console, JSON, Math, Number, Array, Object, String, Boolean, Date, Promise, Map, Set, URL, Error, RegExp,
    setTimeout: st, clearTimeout: ct, encodeURIComponent, parseInt, parseFloat, isNaN, Infinity,
    API_SITE: 'api/site.php', I18n: null, Utils: null,
    t: (_k, d) => d ?? '', escHtml: (v) => String(v ?? ''),
    apiFetch: async (url) => { const r = await apiFetchStatus(url); return r.ok ? r.data : null; },
    apiFetchStatus,
    toast: (m, k) => { sandbox.__toasts.push([m, k]); },
    el: (id) => mkEl(id),
    refreshIcons() {},
    setUnsaved() {}, registerDirtyGuard() {},
    renderFields() {}, renderGroups() {}, renderTranslatePanel() {}, renderVariablesPanel() {},
    document: { querySelector: () => ({}), createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), getElementById: () => null },
    window: { addEventListener() {}, open: () => null },
    location: { origin: 'http://h', search: '' },
    navigator: { onLine: true },
    history: { replaceState() {} },
    confirm: (m) => { confirms.push(m); return sandbox.__confirmAnswer; },
    BroadcastChannel: undefined,
    InstanceConfig: undefined, PageTemplates: undefined, PageBackground: undefined, PageRenderer: undefined,
    __toasts: [], __confirmAnswer: true,
  };
  src += `
;globalThis.__T = {
  state: () => ({ slug: _slug, doc: _doc, sections: _sections, dirty: _dirty, switching: _switching,
                  autosaveFailed: _autosaveFailed, loadFailed: _loadFailed, lockedOut: _lockedOut }),
  setSections(s) { _sections = s; },
  selectPage, switchPage, saveDraft, publish, _persistDraft, _requestAutosave, _runAutosave, _afterMutate, _onChipClick,
  _onMessage, _sanitizeSections, _cleanSel, _applyAction,
  setMode(m) { _mode = m; },
};
`;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'tab-pages.js' });
  // The editor frame the message handler checks against.
  return { T: ctx.__T, server, advance, sandbox, confirms, flush };
}

const sec = (id, text) => [{ id, props: {}, columns: [{ id: id + 'c', width: 12, props: {}, widgets: [{ id: id + 'w', type: 'heading', text: { en: text }, props: {} }] }] }];

// ── 1. A background save does not revert a publish made meanwhile ─
{
  const { T, server, advance } = load();
  server.docs.set('pages/news', { title: { en: 'News' }, published: { sections: sec('p1', 'old') }, draft: { sections: sec('d1', 'old') } });
  await T.selectPage('news');
  assert.equal(T.state().slug, 'news');
  T.setSections(sec('d2', 'edit'));
  // Another tab publishes while this one is idle.
  server.docs.get('pages/news').published = { sections: sec('p9', 'published elsewhere') };
  T._afterMutate();
  await advance(1300);
  const saved = server.docs.get('pages/news');
  assert.equal(saved.draft.sections[0].id, 'd2', 'the draft is written');
  assert.equal(saved.published.sections[0].id, 'p9', 'the newer published block is preserved, not reverted');
  assert.equal(T.state().dirty, false, 'saved: no longer dirty');
}

// ── 2. A failed autosave is visible, retried with backoff, then recovers ─
{
  const { T, server, advance } = load();
  server.docs.set('pages/a', { published: { sections: [] }, draft: { sections: sec('d1', 'x') } });
  await T.selectPage('a');
  T.setSections(sec('d2', 'edit'));
  server.failSaves = 2;
  T._afterMutate();
  await advance(1300);
  assert.equal(T.state().autosaveFailed, true, 'failure is flagged (the chip turns red)');
  assert.equal(T.state().dirty, true, 'edits still count as unsaved');
  await advance(2100);          // first retry (2 s) fails again
  assert.equal(T.state().autosaveFailed, true);
  await advance(5100);          // second retry (5 s) succeeds
  assert.equal(T.state().autosaveFailed, false, 'the retry succeeded');
  assert.equal(T.state().dirty, false);
  assert.equal(server.docs.get('pages/a').draft.sections[0].id, 'd2');
}

// ── 2b. A refusal a retry cannot change is not retried forever ─
{
  const { T, server, advance } = load();
  server.docs.set('pages/a', { published: { sections: [] }, draft: { sections: sec('d1', 'x') } });
  await T.selectPage('a');
  T.setSections(sec('d2', 'edit'));
  server.failSaves = 1000; server.failStatus = 400;   // e.g. the server's page validation
  T._afterMutate();
  await advance(1300);
  assert.equal(T.state().autosaveFailed, true, 'the failure is shown');
  const n = server.log.filter((l) => l.action === 'save_draft').length;
  await advance(10 * 60 * 1000);
  assert.equal(server.log.filter((l) => l.action === 'save_draft').length, n, 'a 400 is not resent every 30 s');
  server.failSaves = 0;
  T._onChipClick();                       // the operator's click still retries
  await advance(100);
  assert.equal(T.state().autosaveFailed, false);
}

// ── 3. Switching page flushes the old page, and never writes it into the new one ─
{
  const { T, server, advance } = load();
  server.docs.set('pages/a', { published: { sections: [] }, draft: { sections: sec('a1', 'A') } });
  server.docs.set('pages/b', { published: { sections: [] }, draft: { sections: sec('b1', 'B') } });
  await T.selectPage('a');
  T.setSections(sec('a2', 'A edited'));
  T._afterMutate();                       // pending autosave, not yet fired
  await T.switchPage('b');                // the operator picks another page at once
  assert.equal(server.docs.get('pages/a').draft.sections[0].id, 'a2', 'the last edit of page A was saved before leaving');
  assert.equal(T.state().slug, 'b');
  assert.equal(T.state().sections[0].id, 'b1');
  await advance(5000);
  assert.equal(server.docs.get('pages/b').draft.sections[0].id, 'b1', 'page B was never overwritten by page A');
}

// ── 4. During the load of the next page nothing is saved or edited ─
{
  const { T, server, advance } = load();
  server.docs.set('pages/a', { published: { sections: [] }, draft: { sections: sec('a1', 'A') } });
  server.docs.set('pages/b', { published: { sections: [] }, draft: { sections: sec('b1', 'B') } });
  await T.selectPage('a');
  let release; const gate = new Promise((r) => { release = r; });
  server.getDelay = async (doc) => { if (doc === 'pages/b') await gate; };
  const pending = T.selectPage('b');
  await advance(50);
  assert.equal(T.state().slug, 'a', 'the slug stays on the old page until the new one has arrived');
  assert.equal(T.state().switching, true);
  T.setSections(sec('a9', 'late edit'));
  T._afterMutate();                       // refused while switching
  T._requestAutosave();
  await advance(3000);
  assert.equal(server.log.filter((l) => l.action === 'save_draft').length, 0, 'no save fires during the switch');
  release(); await pending;
  assert.equal(T.state().slug, 'b');
  assert.equal(T.state().switching, false);
}

// ── 5. Publish is serialised after the draft write and keeps the draft ─
{
  const { T, server } = load();
  server.docs.set('pages/a', { published: { sections: [] }, draft: { sections: sec('a1', 'A') } });
  await T.selectPage('a');
  T.setSections(sec('a2', 'to publish'));
  T._afterMutate();
  await T.publish();
  const seq = server.log.map((l) => l.action).join(',');
  assert.match(seq, /^save_draft,publish$/, 'draft written, then published, nothing in between');
  assert.equal(server.docs.get('pages/a').published.sections[0].id, 'a2');
  assert.equal(T.state().dirty, false);
}

// ── 6. A page that cannot be read is not saved over ────────────
{
  const { T, server, advance } = load();
  server.failGets = true;
  await T.selectPage('a');                // first page ever: no previous page to fall back to
  assert.equal(T.state().loadFailed, true);
  T.setSections(sec('x', 'typed into an empty shell'));
  T._afterMutate();
  await advance(3000);
  assert.equal(server.log.filter((l) => l.action === 'save_draft').length, 0, 'nothing is written over the unreadable page');
}

// ── 7. A switch whose load fails keeps the current page ────────
{
  const { T, server } = load();
  server.docs.set('pages/a', { published: { sections: [] }, draft: { sections: sec('a1', 'A') } });
  await T.selectPage('a');
  server.failGets = true;
  await T.selectPage('b');
  assert.equal(T.state().slug, 'a', 'still on page A');
  assert.equal(T.state().sections[0].id, 'a1');
}

// ── 8. Corrupt documents still open ────────────────────────────
{
  const { T, server } = load();
  server.docs.set('pages/a', { draft: { sections: [null, 5, { id: 's', columns: [null, { id: 'c', widgets: [null, { type: 'heading' }] }] }] } });
  await T.selectPage('a');
  const s = T.state().sections;
  assert.equal(s.length, 1, 'null / scalar sections are dropped');
  assert.equal(s[0].columns.length, 1);
  assert.equal(s[0].columns[0].widgets.length, 1);
}

// ── 9. Frame messages with hostile indices cannot throw or mutate ─
{
  const { T, server, sandbox } = load();
  server.docs.set('pages/a', { draft: { sections: sec('a1', 'A') } });
  await T.selectPage('a');
  const before = JSON.stringify(T.state().sections);
  const origin = 'http://h';
  const frame = sandbox.el('pages-frame').contentWindow;
  const send = (data, over = {}) => T._onMessage({ source: frame, origin, data, ...over });
  assert.doesNotThrow(() => {
    send({ type: 'LUMEN_EDIT_ACTION', action: 'dupSection', sel: null });
    send({ type: 'LUMEN_EDIT_ACTION', action: 'delWidget', sel: { si: 0, ci: 'x', wi: {} } });
    send({ type: 'LUMEN_EDIT_ACTION', action: 'moveSection', sel: { si: -1 }, arg: 'foo' });
    send({ type: 'LUMEN_EDIT_ACTION', action: 5, sel: {} });
    send({ type: 'LUMEN_EDIT_DROP', target: null, payload: null });
    send({ type: 'LUMEN_EDIT_DROP', target: { si: 0, ci: 0, index: -3 }, payload: { kind: 'new', wtype: 'heading' } });
    send({ type: 'LUMEN_EDIT_DROP', target: { si: 0, ci: 0, index: 0 }, payload: { kind: 'move', from: 'nope' } });
    send({ type: 'LUMEN_EDIT_RESIZE', si: 'a', ci: 1, leftWidth: 'x' });
    send({ type: 'LUMEN_EDIT_SELECT', sel: 'garbage' });
  });
  assert.equal(JSON.stringify(T.state().sections), before, 'nothing changed');
  // A foreign origin or another window is ignored altogether.
  send({ type: 'LUMEN_EDIT_ACTION', action: 'addSection', sel: {} }, { origin: 'http://evil' });
  send({ type: 'LUMEN_EDIT_ACTION', action: 'addSection', sel: {} }, { source: {} });
  assert.equal(JSON.stringify(T.state().sections), before, 'foreign origin / window ignored');
}

// ── 10. A save against a revision that moved on is refused, then taken over ─
{
  const { T, server, advance } = load();
  server.docs.set('pages/a', { published: { sections: [] }, draft: { sections: sec('a1', 'A') } });
  await T.selectPage('a');
  T.setSections(sec('a2', 'mine'));
  T._afterMutate();
  await advance(1300);
  assert.equal(server.log.at(-1).rev, 'r0', 'the revision read at load travels with the save');
  assert.equal(server.docs.get('pages/a').draft.sections[0].id, 'a2');
  // Another editor (another browser) writes the page.
  server.docs.get('pages/a').draft = { sections: sec('o1', 'theirs') };
  server.touch('pages/a');
  T.setSections(sec('a3', 'mine again'));
  T._afterMutate();
  await advance(1300);
  assert.equal(server.docs.get('pages/a').draft.sections[0].id, 'o1', "the other editor's draft is not overwritten");
  assert.equal(T.state().lockedOut, true, 'the tab stops autosaving and says why');
  const writes = server.log.length;
  await advance(60000);
  assert.equal(server.log.length, writes, 'no retry loop against a conflict');
  T._onChipClick();                        // the operator takes the page over
  await advance(100);
  assert.equal(server.docs.get('pages/a').draft.sections[0].id, 'a3', "take-over writes this tab's draft");
  assert.equal(T.state().lockedOut, false);
}

// ── 11. Source-level contracts ─────────────────────────────────
{
  const s = readFileSync(path.join(ROOT, 'js/pages/admin/tab-pages.js'), 'utf8');
  assert.match(s, /if \(typing\) return; e\.preventDefault\(\); undo\(\)/, 'Ctrl+Z in a text field belongs to the field');
  assert.match(s, /data-tab="pages"/, 'shortcuts are scoped to the visible Pages tab');
  assert.ok(!/postMessage\([^)]*'\*'\)/.test(s), 'no wildcard target origin');
}

console.log('admin page-builder save pipeline (published preserved · retry · switch flush · serialised publish · load failure · hostile frame input): OK');
