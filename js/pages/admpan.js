/**
 * IRIBHM Microscopy Platform — Admin Panel entry
 * ==============================================
 * Boots the multi-tab admin SPA: registers each tab with the shell, then starts
 * the shell (auth/setup gating, collapsible sidebar, hash routing, theme/lang).
 * Tab logic lives in js/pages/admin/*.js; the shared API/i18n/toast plumbing is
 * in js/pages/admin/shared.js.
 */

'use strict';

import { registerTab, boot } from './admin/shell.js';
import { DatasetsTab } from './admin/tab-datasets.js';
import { UploadTab } from './admin/tab-upload.js';
import { StatsTab } from './admin/tab-stats.js';
import { PluginsTab } from './admin/tab-plugins.js';
import { SecurityTab } from './admin/tab-security.js';
import { UpdatesTab } from './admin/tab-updates.js';
import { PipelineTab } from './admin/tab-pipeline.js';
import { AppearanceTab } from './admin/tab-appearance.js';
import { BrandingTab } from './admin/tab-branding.js';
import { PagesTab } from './admin/tab-pages.js';
import { LegalTab } from './admin/tab-legal.js';
import { MarketplaceTab } from './admin/tab-marketplace.js';
import { DocsTab } from './admin/tab-docs.js';

registerTab(DatasetsTab);
registerTab(UploadTab);
registerTab(StatsTab);
registerTab(PluginsTab);
registerTab(SecurityTab);
registerTab(UpdatesTab);
registerTab(PipelineTab);
registerTab(BrandingTab);
registerTab(PagesTab);
registerTab(AppearanceTab);
registerTab(LegalTab);
registerTab(MarketplaceTab);
registerTab(DocsTab);

boot();
