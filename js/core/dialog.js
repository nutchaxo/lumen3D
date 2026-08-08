/* ============================================================
   IRIBHM Microscopy Platform — Modal Dialog
   ============================================================ */

/**
 * A promise-returning modal choice.
 *
 *   const answer = await Dialog.ask({
 *     title: 'Reset?', message: '…',
 *     options: [{ id: 'reset', label: '…', variant: 'danger' },
 *               { id: 'cancel', label: '…' }],
 *     dismissId: 'cancel'
 *   });
 *
 * Every string is passed in ALREADY TRANSLATED — the dialog never resolves an
 * i18n key itself, so a plugin can drive it from its own `plugins.<id>` namespace
 * exactly like the platform drives it from `dialog.*`.
 *
 * Text is written with textContent (never innerHTML): a dataset name reaches this
 * dialog straight from `metadata.json`, which is operator-supplied content.
 * `dismissId` is what Escape and a backdrop click resolve to; omit it and the
 * dialog becomes modal in the strict sense — an explicit choice is the only exit.
 */
const Dialog = (() => {
  let _overlay = null;
  let _resolve = null;
  let _dismissId = null;
  let _previousFocus = null;

  function ask(config = {}) {
    // A second dialog replaces the first rather than stacking: the caller of the
    // one being displaced still gets its promise settled (on its dismiss value).
    if (_overlay) _settle(_dismissId);

    const options = Array.isArray(config.options) ? config.options.filter(o => o && o.id) : [];
    if (!options.length) return Promise.resolve(null);
    _dismissId = config.dismissId ?? null;

    _overlay = _build(config, options);
    _previousFocus = document.activeElement;
    document.body.appendChild(_overlay);
    document.body.classList.add('modal-open');
    if (window.lucide) lucide.createIcons({ nodes: [_overlay] });

    document.addEventListener('keydown', _onKeydown, true);

    const primary = _overlay.querySelector('[data-dialog-primary="true"]')
      || _overlay.querySelector('[data-dialog-option]');
    primary?.focus();

    return new Promise(resolve => { _resolve = resolve; });
  }

  function close(id = null) {
    _settle(id);
  }

  function isOpen() {
    return Boolean(_overlay);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  function _build(config, options) {
    const overlay = document.createElement('div');
    overlay.className = 'lumen-dialog-overlay';

    const box = document.createElement('div');
    box.className = 'lumen-dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    if (config.icon) {
      const icon = document.createElement('div');
      icon.className = 'lumen-dialog-icon';
      if (config.tone) icon.classList.add(`is-${config.tone}`);
      const glyph = document.createElement('i');
      glyph.setAttribute('data-lucide', config.icon);
      icon.appendChild(glyph);
      box.appendChild(icon);
    }

    if (config.title) {
      const title = document.createElement('h2');
      title.className = 'lumen-dialog-title';
      title.id = 'lumen-dialog-title';
      title.textContent = config.title;
      box.appendChild(title);
      box.setAttribute('aria-labelledby', title.id);
    }

    if (config.message) {
      const message = document.createElement('p');
      message.className = 'lumen-dialog-message';
      message.textContent = config.message;
      box.appendChild(message);
    }

    if (config.note) {
      const note = document.createElement('p');
      note.className = 'lumen-dialog-note';
      note.textContent = config.note;
      box.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'lumen-dialog-actions';
    if (config.layout === 'row') actions.classList.add('is-row');

    for (const option of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lumen-dialog-option';
      if (option.variant) btn.classList.add(`is-${option.variant}`);
      btn.setAttribute('data-dialog-option', option.id);
      if (option.primary) btn.setAttribute('data-dialog-primary', 'true');

      if (option.icon) {
        const glyph = document.createElement('i');
        glyph.setAttribute('data-lucide', option.icon);
        btn.appendChild(glyph);
      }

      const text = document.createElement('span');
      text.className = 'lumen-dialog-option-text';
      const label = document.createElement('strong');
      label.textContent = option.label || option.id;
      text.appendChild(label);
      if (option.hint) {
        const hint = document.createElement('small');
        hint.textContent = option.hint;
        text.appendChild(hint);
      }
      btn.appendChild(text);

      btn.addEventListener('click', () => _settle(option.id));
      actions.appendChild(btn);
    }
    box.appendChild(actions);

    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay && _dismissId !== null) _settle(_dismissId);
    });
    return overlay;
  }

  function _onKeydown(e) {
    if (!_overlay) return;
    if (e.key === 'Escape' && _dismissId !== null) {
      e.preventDefault();
      _settle(_dismissId);
      return;
    }
    // Keep the tab ring inside the dialog: it is the only thing the operator may
    // act on while it is up, and the viewer behind it is still fully focusable.
    if (e.key === 'Tab') {
      const focusables = Array.from(_overlay.querySelectorAll('[data-dialog-option]'));
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !_overlay.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function _settle(id) {
    const overlay = _overlay;
    const resolve = _resolve;
    _overlay = null;
    _resolve = null;
    _dismissId = null;
    document.removeEventListener('keydown', _onKeydown, true);
    document.body.classList.remove('modal-open');
    if (overlay) {
      // The removal is on a timer, not on transitionend: in a document that is not
      // compositing the fade never fires an event and the node would linger forever.
      overlay.classList.add('is-closing');
      setTimeout(() => overlay.remove(), 160);
    }
    if (_previousFocus && typeof _previousFocus.focus === 'function') {
      try { _previousFocus.focus(); } catch (_) { /* node gone from the DOM */ }
    }
    _previousFocus = null;
    resolve?.(id ?? null);
  }

  return { ask, close, isOpen };
})();
