/* ============================================================
   Lumen3D — Page edit frame (in-iframe visual editor runtime)
   ============================================================
   The EDITING half of the white-label page builder. Loaded by page.html
   when the URL carries ?edit=1; page-view.js hands control here after the
   core singletons (InstanceConfig / I18n / Theme / Catalog) are ready.

   It turns the REAL page (real navbar, footer, theme, PageRenderer output)
   into a live editing surface: every section / column / widget is rendered
   with the actual renderer, then wrapped in editor chrome (hover outline,
   click-to-select, inline toolbar, drag-to-reorder, drop zones). This is
   what makes the experience feel like Elementor — you edit the page itself,
   full-width, not an abstract tree in an admin panel.

   SINGLE SOURCE OF TRUTH is the PARENT (admin Pages tab). This frame never
   owns the document: it emits INTENTS (select / drop / action / resize) up
   to the parent, the parent mutates its model and posts the whole doc back
   (LUMEN_EDIT_DOC), and the frame re-renders. That one-way data-flow keeps
   the two windows from drifting.

   Protocol
   ── parent → frame ──────────────────────────────────────────────
     LUMEN_EDIT_DOC   { sections, sel, editLoc }   set model + selection
     LUMEN_EDIT_DRAGMOVE { x, y }                  palette drag over the frame
     LUMEN_EDIT_DROP_AT  { x, y, payload }         palette drop
     LUMEN_EDIT_DRAGCLEAR                          drag left the frame / ended
   ── frame → parent ──────────────────────────────────────────────
     LUMEN_EDIT_READY
     LUMEN_EDIT_SELECT { sel }
     LUMEN_EDIT_DROP   { target:{si,ci,index}, payload:{kind:'new'|'move',…} }
     LUMEN_EDIT_RESIZE { si, ci, leftWidth }
     LUMEN_EDIT_ACTION { action, sel, arg }

   Classic IIFE singleton — bare name PageEditFrame. CSP-safe: no injected
   <style>, colors via var() fallbacks, all handlers attached in JS.
   ============================================================ */

const PageEditFrame = (() => {
  'use strict';

  const PRIMARY = 'var(--color-primary,#2F6BFF)';
  let _sections = [];
  let _sel = null;                 // { si, ci, wi } — ci/wi null = column/section
  let _editLoc = 'en';
  let _host = null, _empty = null, _ind = null;

  function _post(msg) { try { window.parent.postMessage(msg, '*'); } catch (_) {} }
  function _t(sel) { return sel && typeof sel === 'object' ? { si: sel.si, ci: sel.ci ?? null, wi: sel.wi ?? null } : null; }
  function _select(sel) { _post({ type: 'LUMEN_EDIT_SELECT', sel: _t(sel) }); }
  function _action(action, sel, arg) { _post({ type: 'LUMEN_EDIT_ACTION', action, sel: _t(sel), arg }); }
  function _lv(v) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return v[_editLoc] || v.en || Object.values(v)[0] || ''; return String(v); }
  function _icons(scope) { try { if (window.lucide) lucide.createIcons(scope ? { nodes: [scope] } : undefined); } catch (_) {} }

  // ── small chrome helpers ────────────────────────────────────────
  function _btn(icon, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.style.cssText = 'width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:0;' +
      'border:none;border-radius:6px;background:transparent;color:#fff;cursor:pointer;opacity:.85';
    b.innerHTML = `<i data-lucide="${icon}" style="width:15px;height:15px"></i>`;
    b.addEventListener('mouseenter', () => (b.style.background = 'rgba(255,255,255,.18)'));
    b.addEventListener('mouseleave', () => (b.style.background = 'transparent'));
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return b;
  }
  function _bar(align) {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;top:6px;${align};z-index:6;display:flex;gap:2px;align-items:center;` +
      `background:${PRIMARY};border-radius:8px;padding:2px 3px;opacity:0;transition:opacity .12s;box-shadow:0 3px 10px rgba(0,0,0,.28)`;
    return d;
  }
  function _chip(text) {
    const c = document.createElement('span');
    c.style.cssText = `position:absolute;top:6px;left:6px;z-index:6;font-size:10px;letter-spacing:.05em;text-transform:uppercase;` +
      `background:${PRIMARY};color:#fff;padding:2px 7px;border-radius:6px;opacity:0;transition:opacity .12s;pointer-events:none`;
    c.textContent = text;
    return c;
  }

  // ── render ──────────────────────────────────────────────────────
  function render() {
    if (!_host) return;
    _host.textContent = '';
    if (_empty) _empty.style.display = 'none';
    if (!_sections.length) { _host.appendChild(_emptyState()); return; }
    _sections.forEach((sec, si) => _host.appendChild(_sectionNode(sec, si)));
    _host.appendChild(_addSectionBar());
    _icons(_host);
  }

  function _emptyState() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:560px;margin:60px auto;text-align:center;padding:0 24px';
    const h = document.createElement('h2'); h.textContent = _msg('emptyTitle', 'Page vierge'); h.style.cssText = 'margin:0 0 8px';
    const p = document.createElement('p'); p.textContent = _msg('emptyBody', 'Ajoutez une section, puis glissez des éléments depuis le panneau de gauche.'); p.style.cssText = 'opacity:.7;margin:0 0 22px';
    wrap.appendChild(h); wrap.appendChild(p);
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'btn btn-accent btn-lg';
    add.textContent = _msg('addSection', '＋ Ajouter une section');
    add.addEventListener('click', () => _action('addSection', null));
    wrap.appendChild(add);
    if (_hasTemplate) {
      const alt = document.createElement('button');
      alt.type = 'button'; alt.className = 'btn btn-ghost'; alt.style.cssText = 'margin-left:10px';
      alt.textContent = _msg('startFromDefault', 'Partir d\'un modèle');
      alt.addEventListener('click', () => _action('loadDefault', null));
      wrap.appendChild(alt);
    }
    return wrap;
  }

  function _addSectionBar() {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = 'display:block;width:calc(100% - 48px);max-width:1080px;margin:14px auto 40px;padding:14px;' +
      `border:2px dashed var(--border-strong,#3a3a4a);border-radius:12px;background:transparent;color:var(--text-muted,#8a8a9a);` +
      'cursor:pointer;font-size:14px;font-weight:600';
    b.textContent = _msg('addSection', '＋ Ajouter une section');
    b.addEventListener('mouseenter', () => { b.style.borderColor = 'var(--color-primary,#2F6BFF)'; b.style.color = 'var(--color-primary,#2F6BFF)'; });
    b.addEventListener('mouseleave', () => { b.style.borderColor = 'var(--border-strong,#3a3a4a)'; b.style.color = 'var(--text-muted,#8a8a9a)'; });
    b.addEventListener('click', () => _action('addSection', null));
    return b;
  }

  // Section/column CSS comes from PageRenderer (sectionCss/columnCss) so the
  // editing surface renders exactly what the live page will; the frame only
  // adds its chrome (outline, chip, toolbar) and swaps the row's column-gap
  // for in-flow resize handles of exactly `gap`px. (The old fixed-width
  // handles plus "- gap" column bases overflowed the flex line, wrapping every
  // column to its own full-width row.)
  function _sectionNode(sec, si) {
    const p = sec.props || {};
    const selected = _sel && _sel.si === si && _sel.ci == null && _sel.wi == null;
    const css = PageRenderer.sectionCss(p);
    const gap = css.gap;
    const outer = document.createElement('section');
    outer.dataset.ebSi = si;
    outer.style.cssText = css.outer +
      `;outline:2px solid ${selected ? PRIMARY : 'transparent'};outline-offset:-2px;transition:outline-color .12s`;
    const ov = PageRenderer.overlayNode(p.style);
    if (ov) outer.appendChild(ov);

    const chip = _chip(`${_msg('section', 'Section')} ${si + 1}`);
    const bar = _bar('right:6px');
    bar.appendChild(_btn('chevron-up', _msg('moveUp', 'Monter'), () => _action('moveSection', { si }, -1)));
    bar.appendChild(_btn('chevron-down', _msg('moveDown', 'Descendre'), () => _action('moveSection', { si }, 1)));
    bar.appendChild(_btn('columns-2', _msg('addColumn', 'Ajouter une colonne'), () => _action('addColumn', { si })));
    bar.appendChild(_btn('settings-2', _msg('settings', 'Réglages'), () => _select({ si, ci: null, wi: null })));
    bar.appendChild(_btn('copy', _msg('duplicate', 'Dupliquer'), () => _action('dupSection', { si })));
    bar.appendChild(_btn('trash-2', _msg('delete', 'Supprimer'), () => _action('delSection', { si })));

    const showChrome = (on) => { chip.style.opacity = on || selected ? '1' : '0'; bar.style.opacity = on || selected ? '1' : '0'; if (!selected) outer.style.outlineColor = on ? 'color-mix(in srgb,' + 'var(--color-primary,#2F6BFF)' + ' 55%,transparent)' : 'transparent'; };
    outer.addEventListener('mouseenter', () => showChrome(true));
    outer.addEventListener('mouseleave', () => showChrome(false));
    outer.addEventListener('click', () => _select({ si, ci: null, wi: null }));
    outer.appendChild(chip);
    outer.appendChild(bar);

    const inner = document.createElement('div');
    inner.style.cssText = css.inner;
    const row = document.createElement('div');
    // Match the live renderer EXACTLY: column-gap between columns (which, unlike
    // an in-flow spacer element, is suppressed at wrap boundaries) so wrapped
    // multi-column layouts render identically here and on the published page.
    // Resize handles are absolute overlays straddling each boundary (see
    // _resizeHandle) — they consume no layout width.
    row.style.cssText = css.row + `;column-gap:${gap}px`;
    (Array.isArray(sec.columns) ? sec.columns : []).forEach((col, ci) => {
      const colNode = _columnNode(sec, si, col, ci, gap);
      if (ci > 0) colNode.appendChild(_resizeHandle(si, ci, sec, gap));
      row.appendChild(colNode);
    });
    inner.appendChild(row);
    outer.appendChild(inner);
    return outer;
  }

  // Absolute overlay straddling the gap on THIS column's left edge. Because it
  // is position:absolute it adds NO flex width — column-gap alone governs
  // spacing, so the row wraps exactly like the live page. Anchored to the
  // column (which is position:relative in _columnNode).
  function _resizeHandle(si, ci, sec, gap) {
    const h = document.createElement('div');
    h.title = _msg('resizeCols', 'Glisser pour redimensionner');
    h.style.cssText = `position:absolute;top:0;bottom:0;left:${-gap / 2}px;transform:translateX(-50%);` +
      'width:16px;min-height:40px;cursor:col-resize;display:flex;align-items:center;justify-content:center;z-index:5;touch-action:none';
    const grip = document.createElement('div');
    grip.style.cssText = 'width:4px;height:44px;border-radius:3px;background:var(--border-strong,#3a3a4a)';
    h.appendChild(grip);
    h.addEventListener('mouseenter', () => (grip.style.background = 'var(--color-primary,#2F6BFF)'));
    h.addEventListener('mouseleave', () => (grip.style.background = 'var(--border-strong,#3a3a4a)'));
    h.addEventListener('pointerdown', (e) => _startResize(e, si, ci, sec, h, gap));
    return h;
  }

  function _startResize(e, si, ci, sec, handle, gap) {
    e.preventDefault(); e.stopPropagation();
    // Keep receiving pointer events even when the cursor leaves the iframe.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    const left = sec.columns[ci - 1], right = sec.columns[ci];
    if (!left || !right) return;
    const row = handle.parentElement.parentElement;   // handle → column → row
    if (!row) return;
    const rowW = row.getBoundingClientRect().width || 1;
    const unit = rowW / 12;
    const startX = e.clientX, startLeft = left.width, total = left.width + right.width;
    let finalLeft = startLeft;
    const cols = [...row.querySelectorAll(':scope > [data-eb-col]')];
    const n = sec.columns.length;
    const share = (n > 1 ? (gap * (n - 1)) / n + 0.5 : 0).toFixed(2);
    const onMove = (ev) => {
      const d = Math.round((ev.clientX - startX) / unit);
      finalLeft = Math.min(total - 1, Math.max(1, startLeft + d));
      // live visual resize (no round-trip) — parent commits on pointerup
      cols.forEach((cel) => { const cci = +cel.dataset.ebCi; if (cci === ci - 1) cel.style.flexBasis = `calc(${(finalLeft / 12) * 100}% - ${share}px)`; else if (cci === ci) cel.style.flexBasis = `calc(${((total - finalLeft) / 12) * 100}% - ${share}px)`; });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      _post({ type: 'LUMEN_EDIT_RESIZE', si, ci, leftWidth: finalLeft });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function _columnNode(sec, si, col, ci, gap) {
    const selected = _sel && _sel.si === si && _sel.ci === ci && _sel.wi == null;
    const c = document.createElement('div');
    c.dataset.ebCol = '1'; c.dataset.ebSi = si; c.dataset.ebCi = ci;
    // position:relative anchors the absolute resize-handle overlay; chrome radius
    // first so a column style radius (in columnCss) overrides it.
    c.style.cssText = 'position:relative;border-radius:8px;' + PageRenderer.columnCss(col, gap, sec.columns.length) +
      `;outline:1px dashed ${selected ? PRIMARY : 'transparent'};outline-offset:-1px;transition:outline-color .12s`;
    c.addEventListener('mouseenter', () => { if (!selected) c.style.outlineColor = 'var(--border-subtle,#2a2a3a)'; });
    c.addEventListener('mouseleave', () => { if (!selected) c.style.outlineColor = 'transparent'; });
    c.addEventListener('click', (e) => { e.stopPropagation(); _select({ si, ci, wi: null }); });

    const widgets = Array.isArray(col.widgets) ? col.widgets : [];
    widgets.forEach((w, wi) => c.appendChild(_widgetNode(w, si, ci, wi)));
    if (!widgets.length) {
      const dz = document.createElement('div');
      dz.style.cssText = 'text-align:center;opacity:.5;font-size:13px;padding:26px 8px;border:1px dashed var(--border-subtle,#2a2a3a);border-radius:8px;pointer-events:none';
      dz.textContent = _msg('dropHere', '＋ Glissez un élément ici');
      c.appendChild(dz);
    }
    return c;
  }

  function _widgetNode(w, si, ci, wi) {
    const selected = _sel && _sel.si === si && _sel.ci === ci && _sel.wi === wi;
    const box = document.createElement('div');
    box.dataset.ebWi = wi; box.dataset.ebSi = si; box.dataset.ebCi = ci;
    box.style.cssText = `position:relative;border-radius:8px;margin:0 0 4px;` +
      `outline:2px solid ${selected ? PRIMARY : 'transparent'};outline-offset:1px;transition:outline-color .12s`;
    box.addEventListener('mouseenter', () => { if (!selected) box.style.outlineColor = 'color-mix(in srgb,var(--color-primary,#2F6BFF) 45%,transparent)'; hbar.style.opacity = '1'; handle.style.opacity = '1'; });
    box.addEventListener('mouseleave', () => { if (!selected) box.style.outlineColor = 'transparent'; if (!selected) { hbar.style.opacity = '0'; handle.style.opacity = '0'; } });
    box.addEventListener('click', (e) => { e.stopPropagation(); _select({ si, ci, wi }); });

    // drag handle (reorder / move between columns)
    const handle = document.createElement('div');
    handle.title = _msg('drag', 'Déplacer');
    handle.style.cssText = `position:absolute;top:6px;left:6px;z-index:6;width:26px;height:26px;border-radius:6px;background:${PRIMARY};` +
      'color:#fff;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;opacity:' + (selected ? '1' : '0') + ';transition:opacity .12s';
    handle.innerHTML = '<i data-lucide="grip-vertical" style="width:15px;height:15px"></i>';
    handle.addEventListener('pointerdown', (e) => _beginMove(e, si, ci, wi));
    handle.addEventListener('click', (e) => e.stopPropagation());

    const hbar = _bar('right:6px');
    hbar.style.opacity = selected ? '1' : '0';
    hbar.appendChild(_btn('copy', _msg('duplicate', 'Dupliquer'), () => _action('dupWidget', { si, ci, wi })));
    hbar.appendChild(_btn('trash-2', _msg('delete', 'Supprimer'), () => _action('delWidget', { si, ci, wi })));

    box.appendChild(handle);
    box.appendChild(hbar);

    const view = document.createElement('div');
    view.style.cssText = 'pointer-events:none';
    try { if (typeof PageRenderer !== 'undefined') { const n = PageRenderer.renderWidget(w); if (n) view.appendChild(n); } } catch (_) {}
    if (!view.childNodes.length) {
      view.style.cssText = 'opacity:.55;font-size:13px;padding:14px;border:1px dashed var(--border-subtle,#2a2a3a);border-radius:8px';
      view.textContent = _lv(w.text) || (w.type || 'widget');
    }
    box.appendChild(view);
    return box;
  }

  // ── reorder (drag within the frame) ─────────────────────────────
  function _beginMove(e, si, ci, wi) {
    e.preventDefault(); e.stopPropagation();
    // Keep receiving pointer events even when the cursor leaves the iframe.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    const from = { si, ci, wi };
    document.body.style.cursor = 'grabbing';
    const onMove = (ev) => _paintIndicator(_slotAt(ev.clientX, ev.clientY));
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      _clearIndicator();
      const slot = _slotAt(ev.clientX, ev.clientY);
      if (slot) _post({ type: 'LUMEN_EDIT_DROP', target: { si: slot.si, ci: slot.ci, index: slot.index }, payload: { kind: 'move', from } });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ── drop-slot resolution (shared by reorder + palette drops) ────
  function _slotAt(x, y) {
    let node = document.elementFromPoint(x, y);
    const col = node && node.closest ? node.closest('[data-eb-col]') : null;
    if (!col) return null;
    const si = +col.dataset.ebSi, ci = +col.dataset.ebCi;
    const boxes = [...col.querySelectorAll(':scope > [data-eb-wi]')];
    let index = boxes.length;
    for (let i = 0; i < boxes.length; i++) {
      const r = boxes[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { index = i; break; }
    }
    return { si, ci, index, col, boxes };
  }
  function _paintIndicator(slot) {
    if (!slot) { _clearIndicator(); return; }
    if (!_ind) { _ind = document.createElement('div'); _ind.style.cssText = `position:fixed;z-index:9999;height:3px;background:${PRIMARY};border-radius:2px;box-shadow:0 0 8px var(--color-primary,#2F6BFF);pointer-events:none`; document.body.appendChild(_ind); }
    const cr = slot.col.getBoundingClientRect();
    let top;
    if (slot.boxes.length && slot.index < slot.boxes.length) top = slot.boxes[slot.index].getBoundingClientRect().top;
    else if (slot.boxes.length) { const last = slot.boxes[slot.boxes.length - 1].getBoundingClientRect(); top = last.bottom; }
    else top = cr.top + 12;
    _ind.style.left = (cr.left + 6) + 'px';
    _ind.style.width = (cr.width - 12) + 'px';
    _ind.style.top = (top - 1) + 'px';
    _ind.style.display = 'block';
  }
  function _clearIndicator() { if (_ind) _ind.style.display = 'none'; }

  // ── parent messages ─────────────────────────────────────────────
  function _onMessage(e) {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'LUMEN_EDIT_DOC':
        _sections = Array.isArray(m.sections) ? m.sections : [];
        _sel = m.sel || null;
        if (typeof m.editLoc === 'string') _editLoc = m.editLoc;
        if (m.messages && typeof m.messages === 'object') _msgs = m.messages;
        if (typeof m.hasTemplate === 'boolean') _hasTemplate = m.hasTemplate;
        render();
        break;
      case 'LUMEN_EDIT_DRAGMOVE':
        _paintIndicator(_slotAt(m.x, m.y));
        break;
      case 'LUMEN_EDIT_DROP_AT': {
        const slot = _slotAt(m.x, m.y);
        _clearIndicator();
        if (slot) _post({ type: 'LUMEN_EDIT_DROP', target: { si: slot.si, ci: slot.ci, index: slot.index }, payload: m.payload });
        break;
      }
      case 'LUMEN_EDIT_DRAGCLEAR':
        _clearIndicator();
        break;
    }
  }

  // ── i18n (labels handed down from the parent so the frame needs no dict) ──
  let _msgs = {};
  let _hasTemplate = false;
  function _msg(k, dflt) { return _msgs[k] || dflt; }

  function init(opts) {
    opts = opts || {};
    if (opts.messages) _msgs = opts.messages;
    if (opts.hasTemplate) _hasTemplate = true;
    _host = document.getElementById('page-blocks');
    _empty = document.getElementById('page-empty');
    if (_empty) _empty.style.display = 'none';
    document.body.dataset.editing = '1';
    // Neutralize real nav/footer links so editing clicks never navigate away.
    document.querySelectorAll('.navbar a, .footer a, nav a, footer a').forEach((a) => {
      a.addEventListener('click', (e) => e.preventDefault());
      a.style.cursor = 'default';
    });
    window.addEventListener('message', _onMessage);
    _post({ type: 'LUMEN_EDIT_READY' });
  }

  return { init };
})();
