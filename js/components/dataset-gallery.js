/* ============================================================
   Lumen3D — Dataset Gallery
   ============================================================
   Images an operator attached to a dataset (annotated captures,
   figures, schematics). They live in a floating dock pinned to the
   bottom-right corner of the canvas — 3D viewer and 2D photograph
   page alike — so they stay beside the specimen they annotate
   instead of scrolling away with the sidebar.

   Three states, persisted across datasets and reloads:
     open   compact thumbnail grid
     large  same grid, wider panel and bigger tiles
     chip   collapsed to a single puce in the corner (image count)
   A thumbnail always opens the full-screen lightbox, whatever the
   dock state — that is the point of the images being there.

   Source of truth is metadata.json's `gallery` array, which the
   catalog carries through unchanged:
       [{ file: "coupe.png", title?: "…", caption?: "…" }]
   `file` is a bare name inside the dataset's gallery/ folder — the
   server validates that shape on write (dev_server._gallery_rel and
   its PHP twin), so it is safe to compose into a URL here.

   The DOM is built with createElement rather than innerHTML: the
   captions are operator text and the file names come off disk, so
   no concatenation path can turn either into markup.
   ============================================================ */

const DatasetGallery = (() => {
  const STATE_KEY = 'iribhm-gallery-dock';
  const STATES = ['open', 'large', 'chip'];

  let _dock = null;
  let _items = [];
  let _base = '';
  let _mountSelector = '.viewer-canvas-container';
  let _state = 'open';
  // The size the puce reopens to: collapsing an enlarged dock and reopening it
  // must not silently demote it back to the compact grid.
  let _restoreState = 'open';
  let _lightbox = null;
  let _index = 0;
  let _lastFocus = null;

  function _t(key, fallback) {
    if (typeof I18n === 'undefined') return fallback;
    const res = I18n.t(key);
    return (res && res !== key) ? res : fallback;
  }

  function _urlFor(item) {
    return `${_base}/gallery/${encodeURIComponent(item.file)}`;
  }

  function _label(item, index) {
    return item.title || item.caption || `${_t('viewer.galleryImage', 'Image')} ${index + 1}`;
  }

  /**
   * @param {object} opts
   *   basePath   dataset base URL — `DATA_WEB/<type>/<folder>` or the
   *              session-gated staging blob proxy prefix
   *   items      the metadata.json `gallery` array
   *   mount      CSS selector of the canvas area the dock is pinned into
   *              (default `.viewer-canvas-container`, present on both the
   *              3D viewer and the 2D page)
   */
  function init(opts = {}) {
    _base = String(opts.basePath || '').replace(/\/+$/, '');
    if (opts.mount) _mountSelector = String(opts.mount);
    _state = _readState();
    _restoreState = _state === 'chip' ? 'open' : _state;
    setItems(opts.items);
  }

  function setItems(items) {
    _items = (Array.isArray(items) ? items : []).filter(
      (it) => it && typeof it === 'object' && typeof it.file === 'string' && it.file
    );
    _render();
  }

  // ── Persisted dock state ──────────────────────────────────────
  // A browser with storage disabled (private mode, kiosk profile) must lose the
  // preference, never the gallery: every access is guarded.
  function _readState() {
    try {
      const v = localStorage.getItem(STATE_KEY);
      return STATES.includes(v) ? v : 'open';
    } catch (e) { return 'open'; }
  }

  function _writeState(v) {
    try { localStorage.setItem(STATE_KEY, v); } catch (e) { /* storage unavailable */ }
  }

  // ── Dock ──────────────────────────────────────────────────────
  function _icon(name, cls) {
    const i = document.createElement('i');
    i.setAttribute('data-lucide', name);
    if (cls) i.className = cls;
    return i;
  }

  function _dockButton(cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `gallery-dock-btn ${cls}`;
    return b;
  }

  // Both the title and the aria-label carry their key so the language switcher's
  // document-wide pass (I18n._applyTranslations) re-translates a dock that was
  // built from JS, exactly as it does the static markup.
  function _setBtnLabel(btn, key, fallback) {
    const label = _t(key, fallback);
    btn.setAttribute('data-i18n-title', key);
    btn.setAttribute('data-i18n-aria', key);
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function _buildDock() {
    const host = document.querySelector(_mountSelector) || document.body;
    const root = document.createElement('div');
    // Outside a positioned canvas area (an unexpected host page) the dock anchors
    // to the viewport instead, so it still lands in the bottom-right corner.
    root.className = host === document.body ? 'gallery-dock gallery-dock-fixed' : 'gallery-dock';
    root.id = 'gallery-dock';
    root.hidden = true;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'gallery-dock-chip';
    _setBtnLabel(chip, 'viewer.galleryShow', 'Show the gallery');
    chip.appendChild(_icon('images'));
    const chipCount = document.createElement('span');
    chipCount.className = 'gallery-dock-chip-count';
    chip.appendChild(chipCount);

    const panel = document.createElement('div');
    panel.className = 'gallery-dock-panel';

    const head = document.createElement('div');
    head.className = 'gallery-dock-head';
    head.appendChild(_icon('images', 'gallery-dock-head-icon'));
    const title = document.createElement('span');
    title.className = 'gallery-dock-title';
    title.setAttribute('data-i18n', 'viewer.gallery');
    title.textContent = _t('viewer.gallery', 'Gallery');
    const count = document.createElement('span');
    count.className = 'gallery-dock-count';
    const spacer = document.createElement('span');
    spacer.className = 'gallery-dock-spacer';
    head.append(title, count, spacer);

    // One button toggles the size; which of its two icons shows is decided by the
    // dock's data-state in CSS, so no icon is ever re-created on a click.
    const btnSize = _dockButton('gallery-dock-size');
    btnSize.append(_icon('maximize-2', 'gallery-dock-ico-grow'), _icon('minimize-2', 'gallery-dock-ico-shrink'));
    const btnHide = _dockButton('gallery-dock-hide');
    btnHide.appendChild(_icon('minus'));
    _setBtnLabel(btnHide, 'viewer.galleryHide', 'Hide the gallery');
    head.append(btnSize, btnHide);

    const body = document.createElement('div');
    body.className = 'gallery-dock-body';
    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    grid.id = 'gallery-container';
    body.appendChild(grid);

    panel.append(head, body);
    root.append(chip, panel);
    host.appendChild(root);

    _dock = { root, chip, chipCount, count, grid, btnSize, btnHide };

    chip.addEventListener('click', () => { _setState(_restoreState); btnHide.focus(); });
    btnHide.addEventListener('click', () => { _setState('chip'); chip.focus(); });
    btnSize.addEventListener('click', () => _setState(_state === 'large' ? 'open' : 'large'));

    _syncState();
    // lucide 0.344 replaces every [data-lucide] in the document; the dock's own
    // icons are the only ones outstanding at this point.
    if (window.lucide) lucide.createIcons();
    return _dock;
  }

  function _syncState() {
    if (!_dock) return;
    _dock.root.dataset.state = _state;
    const grow = _state !== 'large';
    _setBtnLabel(
      _dock.btnSize,
      grow ? 'viewer.galleryExpand' : 'viewer.galleryReduce',
      grow ? 'Enlarge the gallery' : 'Reduce the gallery'
    );
  }

  function _setState(next) {
    _state = STATES.includes(next) ? next : 'open';
    if (_state !== 'chip') _restoreState = _state;
    _writeState(_state);
    _syncState();
  }

  function _render() {
    // A canvas area swapped out from under us leaves an orphan node: rebuild
    // rather than fill a dock nobody can see.
    if (_dock && !_dock.root.isConnected) _dock = null;
    const dock = _dock || _buildDock();

    dock.grid.textContent = '';
    // A dataset with no attached image shows no dock at all — not even the puce:
    // the canvas stays as sparse as it was before the feature existed (Rule 1.3).
    dock.root.hidden = _items.length === 0;
    if (!_items.length) { close(); return; }

    const n = String(_items.length);
    dock.count.textContent = n;
    dock.chipCount.textContent = n;

    _items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gallery-thumb';
      btn.setAttribute('aria-label', _label(item, i));
      btn.title = _label(item, i);

      const img = document.createElement('img');
      img.src = _urlFor(item);
      img.alt = item.caption || item.title || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      // A file removed from the folder behind the viewer's back must not leave a
      // broken-image tile: drop the whole tile instead (Rule 1.1 — degrade, never
      // show a half-rendered state), and drop the dock once nothing is left.
      img.addEventListener('error', () => {
        btn.remove();
        if (!dock.grid.childElementCount) dock.root.hidden = true;
      });

      btn.appendChild(img);
      btn.addEventListener('click', () => open(i));
      dock.grid.appendChild(btn);
    });
  }

  // ── Lightbox ──────────────────────────────────────────────────
  function _buildLightbox() {
    const root = document.createElement('div');
    root.className = 'gallery-lightbox';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.hidden = true;

    const stage = document.createElement('div');
    stage.className = 'gallery-lb-stage';

    const img = document.createElement('img');
    img.className = 'gallery-lb-img';
    img.alt = '';
    stage.appendChild(img);

    const caption = document.createElement('div');
    caption.className = 'gallery-lb-caption';
    stage.appendChild(caption);

    const mkBtn = (cls, glyph, labelKey, labelDefault) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `gallery-lb-btn ${cls}`;
      b.textContent = glyph;
      b.setAttribute('aria-label', _t(labelKey, labelDefault));
      b.title = _t(labelKey, labelDefault);
      return b;
    };
    const btnPrev = mkBtn('gallery-lb-prev', '‹', 'viewer.galleryPrev', 'Previous image');
    const btnNext = mkBtn('gallery-lb-next', '›', 'viewer.galleryNext', 'Next image');
    const btnClose = mkBtn('gallery-lb-close', '×', 'viewer.galleryClose', 'Close');

    btnPrev.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
    btnNext.addEventListener('click', (e) => { e.stopPropagation(); step(1); });
    btnClose.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    // Clicking the backdrop closes; clicking the image itself must not.
    root.addEventListener('click', (e) => { if (e.target === root || e.target === stage) close(); });

    root.append(btnClose, btnPrev, stage, btnNext);
    document.body.appendChild(root);
    _lightbox = { root, img, caption, btnPrev, btnNext, btnClose };
    return _lightbox;
  }

  function _onKeydown(e) {
    if (!_lightbox || _lightbox.root.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'Tab') {
      // Keep Tab inside the dialog while it owns the screen.
      e.preventDefault();
      const focusables = [_lightbox.btnClose, _lightbox.btnPrev, _lightbox.btnNext]
        .filter((b) => !b.hidden);
      const at = focusables.indexOf(document.activeElement);
      const next = (at + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
      focusables[next].focus();
    }
  }

  function _paint() {
    const item = _items[_index];
    if (!_lightbox || !item) return;
    const { img, caption, btnPrev, btnNext, root } = _lightbox;
    img.src = _urlFor(item);
    img.alt = item.caption || item.title || _label(item, _index);
    const text = [item.title, item.caption].filter(Boolean).join(' — ');
    const counter = _items.length > 1 ? `${_index + 1} / ${_items.length}` : '';
    caption.textContent = counter && text ? `${text}  ·  ${counter}` : (text || counter);
    caption.hidden = !caption.textContent;
    const many = _items.length > 1;
    btnPrev.hidden = !many;
    btnNext.hidden = !many;
    root.setAttribute('aria-label', _label(item, _index));
  }

  function open(index) {
    if (!_items.length) return;
    _index = Math.max(0, Math.min(_items.length - 1, index | 0));
    const lb = _lightbox || _buildLightbox();
    _lastFocus = document.activeElement;
    lb.root.hidden = false;
    document.body.classList.add('gallery-lightbox-open');
    document.addEventListener('keydown', _onKeydown);
    _paint();
    lb.btnClose.focus();
  }

  function step(delta) {
    if (!_items.length) return;
    _index = (_index + delta + _items.length) % _items.length;
    _paint();
  }

  function close() {
    if (!_lightbox || _lightbox.root.hidden) return;
    _lightbox.root.hidden = true;
    _lightbox.img.removeAttribute('src');   // stop a large decode we no longer show
    document.body.classList.remove('gallery-lightbox-open');
    document.removeEventListener('keydown', _onKeydown);
    // Focus must not stay on a control that just became hidden. A mouse click does
    // not necessarily focus the thumbnail it opened, so <body> is a common value for
    // _lastFocus — fall back to the tile of the image that was on screen.
    const restore = (_lastFocus && _lastFocus !== document.body && _lastFocus.isConnected)
      ? _lastFocus
      : _dock?.grid.querySelectorAll('.gallery-thumb')[_index];
    if (restore && typeof restore.focus === 'function') restore.focus();
    _lastFocus = null;
  }

  function count() { return _items.length; }
  function state() { return _state; }

  return { init, setItems, open, close, step, count, state, setState: _setState };
})();
