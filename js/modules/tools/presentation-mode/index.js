/* Presentation Mode — index.js */
// The mode hides the page header, which holds this plugin's own toggle: while it is
// on, the way back is Escape or the floating exit button mounted on the canvas.
PluginRegistry.implement('presentation-mode', {
  _active: false,
  _exitBtn: null,
  _onKeydown: null,
  _offLanguage: null,

  init(ctx) {
    this._ctx = ctx;
    this._onKeydown = (e) => this._handleKeydown(e);
    const onLang = ctx?.i18n?.onLanguageChange;
    if (typeof onLang === 'function') {
      const off = onLang(() => this._labelExitButton());
      if (typeof off === 'function') this._offLanguage = off;
    }
    // An older core restored the mode by setting the body class itself: adopt it so
    // the exit controls exist.
    if (document.body.classList.contains('presentation-mode')) this._apply(true);
    return this;
  },

  activate() {
    this._apply(!this._active, { focus: true });
    return { active: this._active };
  },

  getState() { return { presentationMode: this._active }; },

  setState(s) {
    if (typeof s?.presentationMode === 'boolean') this._apply(s.presentationMode);
  },

  reset() { this.setState({ presentationMode: false }); },

  dispose() {
    this._apply(false, { sync: false });
    if (this._offLanguage) { this._offLanguage(); this._offLanguage = null; }
  },

  _apply(active, { focus = false, sync = true } = {}) {
    const wasActive = this._active;
    this._active = !!active;
    document.body.classList.toggle('presentation-mode', this._active);
    if (this._active) {
      document.addEventListener('keydown', this._onKeydown);
      this._mountExitButton();
      if (focus) this._exitBtn?.focus();
    } else {
      document.removeEventListener('keydown', this._onKeydown);
      const hadFocus = !!this._exitBtn && document.activeElement === this._exitBtn;
      this._exitBtn?.remove();
      this._exitBtn = null;
      if (wasActive && (focus || hadFocus)) document.querySelector('[data-plugin-id="presentation-mode"]')?.focus();
    }
    if (sync) PluginRegistry.syncToolbarButton('presentation-mode', { active: this._active });
    if (this._ctx?.ui?.scheduleResize) this._ctx.ui.scheduleResize();
  },

  _handleKeydown(e) {
    if (e.key !== 'Escape' || e.defaultPrevented || !this._active) return;
    // Escape belongs to whatever is open above the canvas (a modal, the Studio) or to
    // the field being typed in.
    if (document.body.classList.contains('modal-open')) return;
    if (typeof StudioEditor !== 'undefined' && StudioEditor.isOpen?.()) return;
    const target = e.target;
    if (target && typeof target.closest === 'function'
        && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]')) return;
    e.preventDefault();
    this._apply(false, { focus: true });
  },

  _mountExitButton() {
    if (this._exitBtn) return;
    const host = document.querySelector('.viewer-canvas-container') || document.body;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'presentation-exit-btn';
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'minimize-2');
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'presentation-exit-label';
    btn.append(icon, label);
    btn.addEventListener('click', () => this._apply(false, { focus: true }));
    host.appendChild(btn);
    this._exitBtn = btn;
    this._labelExitButton();
    if (typeof window !== 'undefined' && window.lucide?.createIcons) window.lucide.createIcons({ nodes: [btn] });
  },

  _labelExitButton() {
    const btn = this._exitBtn;
    if (!btn) return;
    const text = this._ctx?.i18n?.t ? this._ctx.i18n.t('exit') : 'Exit presentation mode';
    const label = btn.querySelector('.presentation-exit-label');
    if (label) label.textContent = text;
    btn.setAttribute('aria-label', text);
    btn.title = `${text} (Esc)`;
  }
});
