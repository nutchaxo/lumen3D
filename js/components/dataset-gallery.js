/* ============================================================
   Lumen3D — Dataset Gallery
   ============================================================
   Images an operator attached to a dataset (annotated captures,
   figures, schematics). Rendered as a thumbnail grid in the viewer
   sidebar; clicking one opens a full-screen lightbox with
   prev/next navigation.

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
  let _section = null;
  let _grid = null;
  let _items = [];
  let _base = '';
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
   *   sectionId  wrapper revealed only when the dataset has images
   *   containerId  grid mount point
   *   basePath   dataset base URL — `DATA_WEB/<type>/<folder>` or the
   *              session-gated staging blob proxy prefix
   *   items      the metadata.json `gallery` array
   */
  function init(opts = {}) {
    _section = document.getElementById(opts.sectionId || 'gallery-section');
    _grid = document.getElementById(opts.containerId || 'gallery-container');
    _base = String(opts.basePath || '').replace(/\/+$/, '');
    setItems(opts.items);
  }

  function setItems(items) {
    _items = (Array.isArray(items) ? items : []).filter(
      (it) => it && typeof it === 'object' && typeof it.file === 'string' && it.file
    );
    _render();
  }

  function _render() {
    if (!_grid) return;
    _grid.textContent = '';
    // A dataset with no attached image shows no empty panel at all — the sidebar
    // stays as sparse as it was before the feature existed (Rule 1.3).
    if (_section) _section.hidden = _items.length === 0;
    if (!_items.length) return;

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
      // show a half-rendered state).
      img.addEventListener('error', () => btn.remove());

      btn.appendChild(img);
      btn.addEventListener('click', () => open(i));
      _grid.appendChild(btn);
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
    if (!_lightbox) return;
    _lightbox.root.hidden = true;
    _lightbox.img.removeAttribute('src');   // stop a large decode we no longer show
    document.body.classList.remove('gallery-lightbox-open');
    document.removeEventListener('keydown', _onKeydown);
    // Focus must not stay on a control that just became hidden. A mouse click does
    // not necessarily focus the thumbnail it opened, so <body> is a common value for
    // _lastFocus — fall back to the tile of the image that was on screen.
    const restore = (_lastFocus && _lastFocus !== document.body && _lastFocus.isConnected)
      ? _lastFocus
      : _grid?.querySelectorAll('.gallery-thumb')[_index];
    if (restore && typeof restore.focus === 'function') restore.focus();
    _lastFocus = null;
  }

  function count() { return _items.length; }

  return { init, setItems, open, close, step, count };
})();
