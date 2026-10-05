/* ============================================================
   IRIBHM Microscopy Platform — Color Blindness Accessibility
   ============================================================
   Provides SVG-based color matrix filters for various types
   of color blindness and applies them to the document body.
   Includes a modal with preview palettes for selection.
   ============================================================ */

const ColorBlind = (() => {
  let _current = 'none';

  // Per-page CSP nonce (L9): from THIS script tag's own .nonce, captured at load
  // (document.currentScript is valid only during initial synchronous execution).
  // Used to nonce the modal's injected <style> so style-src-elem admits it.
  const _PAGE_NONCE = (() => {
    try {
      const s = document.currentScript;
      const n = s && s.nonce;
      return n && n !== '{{CSP_NONCE}}' ? n : null;
    } catch (_) { return null; }
  })();

  // ── Colour-vision SIMULATION matrices ───────────────────────
  // These filters show the page as a person with the chosen deficiency perceives it
  // (a simulation, so a designer can check that nothing relies on a confusable hue);
  // they do not recolour the page to compensate for it.
  //
  // protan / deutan / tritan: Machado, Oliveira & Fernandes, "A Physiologically-based
  // Model for Simulation of Color Vision Deficiency", IEEE TVCG 15(6), 2009 — the 3x3
  // matrices of the table at severity 1.0 (…opia, complete absence of the cone type) and
  // 0.5 (…omaly, anomalous cone). They act on LINEAR-light RGB, which is why every
  // filter below declares color-interpolation-filters="linearRGB" (the SVG default,
  // stated so nobody "fixes" it to sRGB). Each row sums to 1: neutral greys are preserved.
  //
  // achromatopsia: rod monochromacy keeps only luminance, so all three output channels
  // are the relative luminance Y = 0.2126 R + 0.7152 G + 0.0722 B (Rec. 709, linear light).
  // achromatomaly: partial loss, the same 0.5 severity as the anomalies above, i.e. the
  // mean of identity and the luminance matrix.
  const _LUM = [0.2126, 0.7152, 0.0722];
  const _MATRICES = {
    protanopia:    [0.152286, 1.052583, -0.204868,  0.114503, 0.786281, 0.099216,  -0.003882, -0.048116, 1.051998],
    protanomaly:   [0.458064, 0.679578, -0.137642,  0.092785, 0.846313, 0.060902,  -0.007494, -0.016807, 1.024301],
    deuteranopia:  [0.367322, 0.860646, -0.227968,  0.280085, 0.672501, 0.047413,  -0.011820,  0.042940, 0.968881],
    deuteranomaly: [0.547494, 0.607765, -0.155259,  0.181692, 0.781742, 0.036566,  -0.010410,  0.027275, 0.983136],
    tritanopia:    [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602,  0.004733,  0.691367, 0.303900],
    tritanomaly:   [1.017277, 0.027029, -0.044306,  -0.006113, 0.958479, 0.047634,  0.006379,  0.248708, 0.744913],
    achromatopsia: [..._LUM, ..._LUM, ..._LUM],
    achromatomaly: [
      0.5 + 0.5 * _LUM[0], 0.5 * _LUM[1],       0.5 * _LUM[2],
      0.5 * _LUM[0],       0.5 + 0.5 * _LUM[1], 0.5 * _LUM[2],
      0.5 * _LUM[0],       0.5 * _LUM[1],       0.5 + 0.5 * _LUM[2]
    ]
  };

  // feColorMatrix wants 4x5 (RGBA + offset); alpha passes through untouched.
  function _filterMarkup(id, m) {
    const f = n => (+n.toFixed(6)).toString();
    const values = [
      m[0], m[1], m[2], 0, 0,
      m[3], m[4], m[5], 0, 0,
      m[6], m[7], m[8], 0, 0,
      0, 0, 0, 1, 0
    ].map(f).join(' ');
    return `<filter id="cb-${id}" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${values}" /></filter>`;
  }

  const _filters = { none: '' };
  Object.keys(_MATRICES).forEach(id => { _filters[id] = _filterMarkup(id, _MATRICES[id]); });

  function _isKnown(type) {
    return typeof type === 'string' && Object.prototype.hasOwnProperty.call(_filters, type);
  }
  function _storageGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function _storageSet(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* blocked or full */ } }

  const _options = [
    { id: 'none' },
    { id: 'protanopia' },
    { id: 'protanomaly' },
    { id: 'deuteranopia' },
    { id: 'deuteranomaly' },
    { id: 'tritanopia' },
    { id: 'tritanomaly' },
    { id: 'achromatopsia' },
    { id: 'achromatomaly' }
  ];

  const _groups = [
    {
      id: 'general',
      options: ['none']
    },
    {
      id: 'red',
      options: ['protanopia', 'protanomaly']
    },
    {
      id: 'green',
      options: ['deuteranopia', 'deuteranomaly']
    },
    {
      id: 'blue',
      options: ['tritanopia', 'tritanomaly']
    },
    {
      id: 'mono',
      options: ['achromatopsia', 'achromatomaly']
    }
  ];

  // Bright, distinct colors to demonstrate the filter
  const _paletteColors = ['#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4'];

  function init() {
    // Inject SVG filters into body
    const svgContainer = document.createElement('div');
    svgContainer.style.height = '0';
    svgContainer.style.width = '0';
    svgContainer.style.position = 'absolute';
    svgContainer.style.visibility = 'hidden';
    
    let defs = '<svg><defs>';
    for (let key in _filters) {
      if (key !== 'none') {
        defs += _filters[key];
      }
    }
    defs += '</defs></svg>';
    svgContainer.innerHTML = defs;
    document.body.appendChild(svgContainer);

    // Load saved preference
    const saved = _storageGet('iribhm-colorblind');
    if (saved && _isKnown(saved)) {
      _current = saved;
    }
    
    _apply();
    injectModalStyles();

    // The filter chosen in another document of this origin (the Compare page over
    // its panels) arrives as a `storage` event; apply it here too.
    if (typeof window.addEventListener === 'function') window.addEventListener('storage', e => {
      if (e.key !== 'iribhm-colorblind') return;
      const next = e.newValue && _isKnown(e.newValue) ? e.newValue : 'none';
      if (next === _current) return;
      _current = next;
      _apply();
    });
  }

  function set(type) {
    if (!_isKnown(type)) return;
    _current = type;
    _storageSet('iribhm-colorblind', _current);
    _apply();
    closeModal();
  }

  function get() {
    return _current;
  }

  // The filter sits on <html>, not <body>: a filter on any other element makes it the
  // containing block of its position:fixed descendants (navbars, dialogs, toasts, the
  // lightbox would then scroll with the page); the Filter Effects spec exempts the
  // document root element. While the chooser is open the page filter is lifted so the
  // option previews (which carry their own filter) are not filtered twice.
  let _modalOpen = false;

  function _apply() {
    const root = document.documentElement;
    if (_current === 'none' || _modalOpen) {
      root.style.filter = '';
    } else {
      root.style.filter = `url(#cb-${_current})`;
    }
    
    // Update active state in modal if it's open
    const modal = document.getElementById('cb-modal');
    if (modal) {
      modal.querySelectorAll('.cb-option-card').forEach(el => {
        if (el.dataset.cbType === _current) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
    }
  }

  function openModal() {
    if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
    _modalOpen = true;
    let modal = document.getElementById('cb-modal');
    if (!modal) {
      modal = createModal();
      document.documentElement.appendChild(modal);
      // Wait for DOM to register the modal before adding 'show' class for animation
      setTimeout(() => modal.classList.add('show'), 10);
    } else {
      modal.classList.add('show');
    }
    _apply(); // to ensure active class is set
  }

  let _closeTimer = null;

  function closeModal() {
    _modalOpen = false;
    const modal = document.getElementById('cb-modal');
    if (modal) {
      modal.classList.remove('show');
      if (_closeTimer) clearTimeout(_closeTimer);
      _closeTimer = setTimeout(() => {
        _closeTimer = null;
        if (modal.parentNode) modal.parentNode.removeChild(modal);
      }, 300); // match transition
    }
    _apply();
  }

  function createModal() {
    const overlay = document.createElement('div');
    overlay.id = 'cb-modal';
    overlay.className = 'cb-modal-overlay';
    
    // Close on click outside
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    const content = document.createElement('div');
    content.className = 'cb-modal-content';

    const header = document.createElement('div');
    header.className = 'cb-modal-header';
    const heading = document.createElement('h3');
    heading.dataset.i18n = 'colorblind.title';
    heading.textContent = I18n.t('colorblind.title');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cb-modal-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeModal);
    header.append(heading, closeBtn);
    content.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cb-modal-body';

    const paletteHtml = _paletteColors.map(c => `<div class="cb-swatch" style="background-color: ${c}"></div>`).join('');

    _groups.forEach(group => {
      const section = document.createElement('div');
      section.className = 'cb-section';

      const secTitle = document.createElement('div');
      secTitle.className = 'cb-section-title';
      secTitle.dataset.i18n = 'colorblind.group.' + group.id;
      secTitle.textContent = I18n.t('colorblind.group.' + group.id);
      section.appendChild(secTitle);

      const grid = document.createElement('div');
      grid.className = 'cb-options-grid';

      group.options.forEach(optId => {
        const opt = _options.find(o => o.id === optId);
        if (!opt) return;

        const card = document.createElement('button');
        card.className = 'cb-option-card';
        card.dataset.cbType = opt.id;
        card.onclick = () => set(opt.id);

        const title = document.createElement('div');
        title.className = 'cb-option-title';
        title.dataset.i18n = 'colorblind.' + opt.id;
        title.textContent = I18n.t('colorblind.' + opt.id);

        const preview = document.createElement('div');
        preview.className = 'cb-option-preview';
        if (opt.id !== 'none') {
          preview.style.filter = `url(#cb-${opt.id})`;
        }
        preview.innerHTML = paletteHtml;

        card.appendChild(title);
        card.appendChild(preview);
        grid.appendChild(card);
      });

      section.appendChild(grid);
      body.appendChild(section);
    });

    content.appendChild(body);
    overlay.appendChild(content);

    return overlay;
  }

  function injectModalStyles() {
    if (document.getElementById('cb-modal-styles')) return;
    const style = document.createElement('style');
    style.id = 'cb-modal-styles';
    // CSP (L8): style-src-elem is nonce-gated (no 'unsafe-inline'), so a
    // dynamically injected <style> is refused unless it carries the page nonce.
    if (_PAGE_NONCE) style.nonce = _PAGE_NONCE;
    style.innerHTML = `
      .cb-modal-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.3s ease, visibility 0.3s ease;
        backdrop-filter: blur(4px);
      }
      .cb-modal-overlay.show {
        opacity: 1;
        visibility: visible;
      }
      .cb-modal-content {
        background: var(--bg-surface, #ffffff);
        border: 1px solid var(--border-subtle, #e5e7eb);
        border-radius: var(--radius-lg, 12px);
        box-shadow: 0 10px 25px rgba(0,0,0,0.2);
        width: 100%;
        max-width: 840px;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        transform: scale(0.95) translateY(20px);
        transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }
      [data-theme="dark"] .cb-modal-content {
        background: var(--bg-surface, #1e1e2e);
        border-color: var(--border-subtle, #333344);
      }
      .cb-modal-overlay.show .cb-modal-content {
        transform: scale(1) translateY(0);
      }
      .cb-modal-header {
        padding: var(--space-4, 16px) var(--space-6, 24px);
        border-bottom: 1px solid var(--border-subtle, #e5e7eb);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      [data-theme="dark"] .cb-modal-header {
        border-bottom-color: var(--border-subtle, #333344);
      }
      .cb-modal-header h3 {
        margin: 0;
        font-size: var(--text-xl, 1.25rem);
      }
      .cb-modal-close {
        background: transparent;
        border: none;
        font-size: 24px;
        line-height: 1;
        cursor: pointer;
        color: var(--text-muted, #9ca3af);
        transition: color 0.2s;
      }
      .cb-modal-close:hover {
        color: var(--text-primary, #111827);
      }
      [data-theme="dark"] .cb-modal-close:hover {
        color: var(--text-primary, #ffffff);
      }
      .cb-modal-body {
        padding: var(--space-6, 24px);
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: var(--space-6, 24px);
      }
      .cb-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-3, 12px);
      }
      .cb-section-title {
        font-size: var(--text-xs, 0.75rem);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 700;
        color: var(--text-muted, #888899);
        border-bottom: 1px solid var(--border-subtle, rgba(0,0,0,0.06));
        padding-bottom: 6px;
      }
      [data-theme="dark"] .cb-section-title {
        border-bottom-color: var(--border-subtle, rgba(255,255,255,0.08));
      }
      .cb-options-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: var(--space-4, 16px);
      }
      .cb-option-card {
        background: var(--bg-body, #f9fafb);
        border: 2px solid var(--border-subtle, #e5e7eb);
        border-radius: var(--radius-md, 8px);
        padding: var(--space-4, 16px);
        text-align: left;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        flex-direction: column;
        gap: var(--space-3, 12px);
      }
      [data-theme="dark"] .cb-option-card {
        background: var(--bg-body, #181825);
        border-color: var(--border-subtle, #333344);
      }
      .cb-option-card:hover {
        border-color: var(--color-primary-subtle, #93c5fd);
        transform: translateY(-2px);
      }
      .cb-option-card.active {
        border-color: var(--color-primary, #3b82f6);
        background: var(--bg-active, #eff6ff);
        box-shadow: 0 0 0 1px var(--color-primary, #3b82f6);
      }
      [data-theme="dark"] .cb-option-card.active {
        background: rgba(59, 130, 246, 0.1);
      }
      .cb-option-title {
        font-weight: 600;
        font-size: var(--text-sm, 0.875rem);
        color: var(--text-primary, #111827);
      }
      [data-theme="dark"] .cb-option-title {
        color: var(--text-primary, #ffffff);
      }
      .cb-option-preview {
        display: flex;
        gap: 4px;
        height: 24px;
        border-radius: 4px;
        overflow: hidden;
      }
      .cb-swatch {
        flex: 1;
        height: 100%;
      }
    `;
    document.head.appendChild(style);
  }

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { set, get, openModal, closeModal };
})();

window.ColorBlind = ColorBlind;
