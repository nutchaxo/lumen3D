/**
 * IRIBHM Microscopy Platform — Admin Panel entry
 * ==============================================
 * Boots the multi-tab admin SPA: registers each tab with the shell, then starts
 * the shell (auth/setup gating, collapsible sidebar, hash routing, theme/lang).
 * Tab logic lives in js/pages/admin/*.js; the shared API/i18n/toast plumbing is
 * in js/pages/admin/shared.js.
 *
 * Tabs are registered by name and imported on first use: the login screen and the
 * tab the operator actually opens no longer parse the other fourteen modules
 * (the page builder alone is ~250 KB of source).
 */

'use strict';

import { registerTab, boot } from './admin/shell.js';

// Cache-busting suffix of this entry point (`?v=<release>` stamped into admpan.html
// by the release build): dynamic import() specifiers are invisible to the build's
// static-import rewrite, so they inherit it from here.
const V = (() => { try { return new URL(import.meta.url).search; } catch (_) { return ''; } })();

// The page-builder tab drives the page renderer, which is a set of classic
// scripts (global lexical bindings, see CLAUDE.md §8). They are only needed there.
const PAGE_SYSTEM_SCRIPTS = [
  'js/core/page-vars.js',
  'js/core/page-background.js',
  'js/core/page-renderer.js',
  'js/core/page-templates.js',
];

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const bare = src.split('?')[0];
    if ([...document.scripts].some((s) => (s.getAttribute('src') || '').split('?')[0] === bare)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src + V;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`script failed: ${src}`));
    document.head.appendChild(s);
  });
}

async function loadPageSystem() {
  // page-renderer reads page-vars / page-background at call time, but keep the
  // dependency order of the former <script> tags.
  for (const src of PAGE_SYSTEM_SCRIPTS) await loadClassicScript(src);
}

registerTab({ id: 'datasets', titleKey: 'admin.navDatasets', titleDefault: 'Datasets', load: async () => { return (await import(`./admin/tab-datasets.js${V}`)).DatasetsTab; } });
registerTab({ id: 'dataset-types', titleKey: 'dtypes.nav', titleDefault: 'Types de données', load: async () => { return (await import(`./admin/tab-dataset-types.js${V}`)).DatasetTypesTab; } });
registerTab({ id: 'upload', titleKey: 'admin.navUpload', titleDefault: 'Import', load: async () => { return (await import(`./admin/tab-upload.js${V}`)).UploadTab; } });
registerTab({ id: 'stats', titleKey: 'admin.navStats', titleDefault: 'Statistiques', load: async () => { return (await import(`./admin/tab-stats.js${V}`)).StatsTab; } });
registerTab({ id: 'plugins', titleKey: 'admin.navPlugins', titleDefault: 'Plugins', load: async () => { return (await import(`./admin/tab-plugins.js${V}`)).PluginsTab; } });
registerTab({ id: 'security', titleKey: 'admin.navSecurity', titleDefault: 'Sécurité', load: async () => { return (await import(`./admin/tab-security.js${V}`)).SecurityTab; } });
registerTab({ id: 'updates', titleKey: 'admin.navUpdates', titleDefault: 'Mises à jour', load: async () => { return (await import(`./admin/tab-updates.js${V}`)).UpdatesTab; } });
registerTab({ id: 'changelog', titleKey: 'admin.changelogTitle', titleDefault: 'Notes de version', load: async () => { return (await import(`./admin/tab-changelog.js${V}`)).ChangelogTab; } });
registerTab({ id: 'pipeline', titleKey: 'admin.navPipeline', titleDefault: 'Pipeline', load: async () => { return (await import(`./admin/tab-pipeline.js${V}`)).PipelineTab; } });
registerTab({ id: 'branding', titleKey: 'admin.navBranding', titleDefault: 'Identité', load: async () => { return (await import(`./admin/tab-branding.js${V}`)).BrandingTab; } });
registerTab({ id: 'pages', titleKey: 'admin.navPages', titleDefault: 'Pages', load: async () => { await loadPageSystem(); return (await import(`./admin/tab-pages.js${V}`)).PagesTab; } });
registerTab({ id: 'appearance', titleKey: 'admin.navAppearance', titleDefault: 'Apparence', load: async () => { return (await import(`./admin/tab-appearance.js${V}`)).AppearanceTab; } });
registerTab({ id: 'legal', titleKey: 'admin.navLegal', titleDefault: 'Mentions légales', load: async () => { return (await import(`./admin/tab-legal.js${V}`)).LegalTab; } });
registerTab({ id: 'marketplace', titleKey: 'admin.navMarketplace', titleDefault: 'Catalogue', load: async () => { return (await import(`./admin/tab-marketplace.js${V}`)).MarketplaceTab; } });
registerTab({ id: 'docs', titleKey: 'admin.navDocs', titleDefault: 'Documentation', load: async () => { return (await import(`./admin/tab-docs.js${V}`)).DocsTab; } });

boot();
