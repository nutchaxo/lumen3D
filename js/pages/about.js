/* ============================================================
   IRIBHM Microscopy Platform — About Page
   ============================================================
   Static copy is driven by data-i18n attributes (see
   lang/{en,fr,es}.json -> "about"). This controller wires the
   theme icon, the catalog stat strip, and the citation
   copy / BibTeX controls.
   ============================================================ */

const AboutApp = (() => {
  async function init() {
    Theme.init();
    await InstanceConfig.load();
    await I18n.init();
    InstanceConfig.applyHead();
    InstanceConfig.applyDom();
    await Catalog.load();
    _updateThemeIcon();
    Theme.onChange(_updateThemeIcon);
    _renderStats();
    _bindCitations();
    if (window.lucide) lucide.createIcons();
    document.body.classList.add('loaded');
  }

  function _renderStats() {
    const strip = document.getElementById('about-stats');
    const empty = document.getElementById('about-stats-empty');
    if (!strip || !empty) return;
    const stats = Catalog.getStats();
    // No catalog bundled (e.g. dev build with empty DATA_WEB) -> show a
    // neutral note instead of a wall of zeros.
    if (!stats || stats.totalDatasets === 0) {
      strip.hidden = true;
      empty.hidden = false;
      return;
    }
    strip.hidden = false;
    empty.hidden = true;
    const set = (id, val) => { const n = document.getElementById(id); if (n) n.textContent = Number(val || 0).toLocaleString(); };
    set('stat-datasets', stats.totalDatasets);
    set('stat-embryos', stats.totalEmbryos);
    set('stat-cells', stats.totalCells);
    set('stat-regions', stats.totalRegions);
  }

  function _bindCitations() {
    document.querySelectorAll('.copy-btn[data-copy-target]').forEach(btn => {
      btn.addEventListener('click', () => _copy(btn));
    });
    document.querySelectorAll('.bibtex-toggle[data-bibtex-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const block = document.getElementById(btn.getAttribute('data-bibtex-toggle'));
        if (block) block.classList.toggle('open');
      });
    });
  }

  async function _copy(btn) {
    const target = document.getElementById(btn.getAttribute('data-copy-target'));
    if (!target) return;
    const text = target.innerText.trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // Clipboard API unavailable (insecure context / older browser): fall back
      // to a transient textarea + execCommand so copy still works on http://.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* give up silently */ }
      ta.remove();
    }
    _flashCopied(btn);
  }

  function _flashCopied(btn) {
    const label = btn.querySelector('span');
    if (!label) return;
    const original = label.textContent;
    label.textContent = I18n.t('about.copied');
    btn.classList.add('copied');
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      label.textContent = original;
      btn.classList.remove('copied');
    }, 1600);
  }

  function _updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const icon = Theme.isDark() ? 'moon' : 'sun';
    btn.innerHTML = `<i data-lucide="${icon}" data-theme-icon></i>`;
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', AboutApp.init);
