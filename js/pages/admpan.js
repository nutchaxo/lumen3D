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
import { StatsTab } from './admin/tab-stats.js';
import { PluginsTab } from './admin/tab-plugins.js';
import { SecurityTab } from './admin/tab-security.js';
import { UpdatesTab } from './admin/tab-updates.js';

registerTab(DatasetsTab);
registerTab(StatsTab);
registerTab(PluginsTab);
registerTab(SecurityTab);
registerTab(UpdatesTab);

boot();
