/* ============================================================
   IRIBHM Microscopy Platform — Color Blindness Accessibility
   ============================================================
   Provides SVG-based color matrix filters for various types
   of color blindness and applies them to the document body.
   Includes a modal with preview palettes for selection.
   ============================================================ */

const ColorBlind = (() => {
  let _current = 'none';

  const _filters = {
    'none': '',
    'protanopia': `
      <filter id="cb-protanopia">
        <feColorMatrix type="matrix" values="1.2 0 0 0 0  0 1 0 0 0  0.8 0 1 0 0  0 0 0 1 0" />
      </filter>`,
    'protanomaly': `
      <filter id="cb-protanomaly">
        <feColorMatrix type="matrix" values="1.1 0 0 0 0  0 1 0 0 0  0.4 0 1 0 0  0 0 0 1 0" />
      </filter>`,
    'deuteranopia': `
      <filter id="cb-deuteranopia">
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 1.2 0 0 0  0 0.8 1 0 0  0 0 0 1 0" />
      </filter>`,
    'deuteranomaly': `
      <filter id="cb-deuteranomaly">
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 1.1 0 0 0  0 0.4 1 0 0  0 0 0 1 0" />
      </filter>`,
    'tritanopia': `
      <filter id="cb-tritanopia">
        <feColorMatrix type="matrix" values="1 0 0.8 0 0  0 1 0 0 0  0 0 1.2 0 0  0 0 0 1 0" />
      </filter>`,
    'tritanomaly': `
      <filter id="cb-tritanomaly">
        <feColorMatrix type="matrix" values="1 0 0.4 0 0  0 1 0 0 0  0 0 1.1 0 0  0 0 0 1 0" />
      </filter>`,
    'achromatopsia': `
      <filter id="cb-achromatopsia">
        <feColorMatrix type="matrix" values="1.5 0 0 0 -0.2  0 1.5 0 0 -0.2  0 0 1.5 0 -0.2  0 0 0 1 0" />
      </filter>`,
    'achromatomaly': `
      <filter id="cb-achromatomaly">
        <feColorMatrix type="matrix" values="1.2 0 0 0 -0.1  0 1.2 0 0 -0.1  0 0 1.2 0 -0.1  0 0 0 1 0" />
      </filter>`
  };

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
    const saved = localStorage.getItem('iribhm-colorblind');
    if (saved && _filters[saved] !== undefined) {
      _current = saved;
    }
    
    _apply();
    injectModalStyles();
  }

  function set(type) {
    if (_filters[type] === undefined) return;
    _current = type;
    localStorage.setItem('iribhm-colorblind', _current);
    _apply();
    closeModal();
  }

  function get() {
    return _current;
  }

  function _apply() {
    if (_current === 'none') {
      document.body.style.filter = '';
    } else {
      document.body.style.filter = `url(#cb-${_current})`;
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
    let modal = document.getElementById('cb-modal');
    if (!modal) {
      modal = createModal();
      // Append to html (documentElement) instead of body to prevent the body's CSS filter
      // from breaking the position:fixed containing block of the modal.
      document.documentElement.appendChild(modal);
      // Wait for DOM to register the modal before adding 'show' class for animation
      setTimeout(() => modal.classList.add('show'), 10);
    } else {
      modal.classList.add('show');
    }
    _apply(); // to ensure active class is set
  }

  function closeModal() {
    const modal = document.getElementById('cb-modal');
    if (modal) {
      modal.classList.remove('show');
      setTimeout(() => {
        if (modal.parentNode) modal.parentNode.removeChild(modal);
      }, 300); // match transition
    }
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
    header.innerHTML = `
      <h3 data-i18n="colorblind.title">${I18n.t('colorblind.title')}</h3>
      <button class="cb-modal-close" onclick="ColorBlind.closeModal()">&times;</button>
    `;
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

// Assign to window for inline onclick handlers
window.ColorBlind = ColorBlind;
