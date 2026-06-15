/* ============================================================
   IRIBHM Microscopy Platform — About Page
   ============================================================ */

const AboutApp = (() => {
  async function init() {
    Theme.init();
    await I18n.init();
    await Catalog.load();
    document.title = 'About - IRIBHM Microscopy Platform';
    _updateThemeIcon();
    Theme.onChange(_updateThemeIcon);
    I18n.onLanguageChange(() => {
      _hydrateStaticCopy();
      _renderCatalogSummary();
    });
    _hydrateStaticCopy();
    _renderCatalogSummary();
    if (window.lucide) lucide.createIcons();
    document.body.classList.add('loaded');
  }

  function _renderCatalogSummary() {
    const node = document.getElementById('about-catalog-summary');
    if (!node) return;
    const stats = Catalog.getStats();
    node.textContent = `${stats.totalDatasets} datasets, ${stats.byType.fixed} fixed stacks, ${stats.byType.live} live-imaging datasets, ${stats.byType.tracking} tracking datasets, and ${stats.totalCells.toLocaleString()} tracked cells available through the platform.`;
  }

  function _hydrateStaticCopy() {
    const fr = I18n.getLanguage() === 'fr';
    const heroBadge = document.querySelector('.about-hero .hero-badge span:last-child');
    if (heroBadge) heroBadge.textContent = fr
      ? 'Methodes, acces, citation et notes de production'
      : 'Methods, access, citation, and production notes';

    const cards = [...document.querySelectorAll('.about-grid .about-card')];
    if (cards[0]?.querySelector('p')) {
      cards[0].querySelector('p').textContent = fr
        ? 'Les jeux de donnees fixes, live et tracking peuvent etre explores separement, compares cote a cote, et relies quand des metadonnees de registration existent.'
        : 'Fixed imaging, live imaging, and cell tracking datasets can be explored independently, compared side by side, and linked when registration metadata exists.';
    }
    if (cards[1]?.querySelector('p')) {
      cards[1].querySelector('p').textContent = fr
        ? 'Les fichiers bruts ND2, CZI, Imaris, XLSX et GLB sont convertis en metadonnees web, stacks WebP, JSON compresses, modeles 3D optimises et bundles telechargeables reproductibles.'
        : 'Raw ND2, CZI, Imaris, XLSX, and GLB files are converted into web-ready metadata, WebP stacks, compressed JSON tracks, optimized 3D models, and reproducible download bundles.';
    }
    if (cards[2]?.querySelector('p')) {
      cards[2].querySelector('p').textContent = fr
        ? 'Le Download Center expose les sources brutes, les assets web, les bundles generes et les exports de workspace reproductibles avec alertes pour les tres gros fichiers.'
        : 'The Download Center exposes raw sources, web-ready assets, generated bundles, and reproducible workspace exports with size warnings for very large microscopy files.';
    }
    if (cards[3]?.querySelector('p')) {
      cards[3].querySelector('p').textContent = fr
        ? 'Merci de citer la plateforme IRIBHM, l\'experience originale et toute publication associee. Les exports workspace incluent un bloc de citation reutilisable et un resume du dataset.'
        : 'Please cite the IRIBHM microscopy platform, the original experiment, and any associated publication. Workspace exports include a reusable citation block and dataset summary.';
    }

    const contact = document.querySelectorAll('.about-grid .about-card')[5]?.querySelector('p');
    if (contact) {
      contact.textContent = fr
        ? 'IRIBHM - Universite Libre de Bruxelles. Pour les corrections de dataset, metadonnees ou questions de reutilisation, contactez le proprietaire du dataset ou le contact IRIBHM.'
        : 'IRIBHM - Universite Libre de Bruxelles. For dataset corrections, metadata, or reuse questions, contact the dataset owner or the IRIBHM lab contact.';
    }
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
