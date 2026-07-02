/**
 * Admin SPA — Plugins tab
 * =======================
 * Lists every discovered plugin grouped by placement and lets the operator
 * enable/disable each. Disabling persists to api/disabled-plugins.json; the
 * server filters discovery so a disabled plugin no longer loads in the viewer.
 */

'use strict';

import { API_ADMIN, t, escHtml, apiFetch, apiFetchStatus, toast, el, refreshIcons } from './shared.js';

let _plugins = [];

const PLACEMENTS = [
  { key: 'tools',    icon: 'wrench',  labelKey: 'admin.placementTools',    labelDef: 'Outils (barre d\'outils)' },
  { key: 'channels', icon: 'sliders-horizontal', labelKey: 'admin.placementChannels', labelDef: 'Canaux (par-canal)' },
  { key: 'shaders',  icon: 'layers',  labelKey: 'admin.placementShaders',  labelDef: 'Modes de rendu (shaders)' },
];

function row(p, isProtected) {
  // compat === false → the server-side gate excludes this plugin from discovery
  // (its index.js is never loaded); explain WHY inline and freeze the toggle.
  const incompatible = p.compat === false;
  const dis = (p.enabled && !incompatible) ? '' : 'is-off';
  const lock = (isProtected || incompatible) ? 'disabled' : '';
  const meta = [p.version ? `v${escHtml(p.version)}` : '', p.creator ? escHtml(p.creator) : '', escHtml(p.path)]
    .filter(Boolean).join(' · ');
  return `
    <div class="adm-plugin-row ${dis}" data-path="${escHtml(p.path)}">
      <span class="adm-plugin-ic"><i data-lucide="${escHtml(p.icon || 'puzzle')}"></i></span>
      <div class="adm-plugin-info">
        <div class="adm-plugin-name">${escHtml(p.name || p.id)}${isProtected ? ` <span class="adm-tag">${escHtml(t('admin.protectedPlugin', 'protégé'))}</span>` : ''}${incompatible ? ` <span class="adm-tag adm-tag-warn" title="${escHtml(p.compatReason || '')}">${escHtml(t('admin.compatIncompatible', 'incompatible'))}</span>` : ''}</div>
        <div class="adm-plugin-meta">${meta}${incompatible && p.compatReason ? ` · <span class="adm-compat-reason">${escHtml(p.compatReason)}</span>` : ''}</div>
      </div>
      <label class="adm-switch" title="${isProtected ? escHtml(t('admin.lastShaderWarn', 'Au moins un mode de rendu doit rester actif.')) : (incompatible ? escHtml(t('admin.compatIntro', 'Un plugin incompatible n\'est pas chargé par le viewer ; il redevient actif dès qu\'une mise à jour satisfait sa contrainte de version.')) : '')}">
        <input type="checkbox" class="adm-plugin-toggle" data-path="${escHtml(p.path)}" ${p.enabled && !incompatible ? 'checked' : ''} ${lock}>
        <span class="adm-switch-track"><span class="adm-switch-thumb"></span></span>
      </label>
    </div>`;
}

function render() {
  const root = el('plugins-root');
  if (!root) return;
  if (!_plugins.length) { root.innerHTML = `<div class="adm-loading"><span class="spinner spinner-lg"></span></div>`; return; }

  const enabled = _plugins.filter((p) => p.enabled).length;
  // Recompute "protected" (last enabled shader) from the live in-memory state so a
  // toggle reflects immediately, without waiting for a server refetch.
  const enabledShaders = _plugins.filter((p) => p.placement === 'shaders' && p.enabled);
  const isProtected = (p) => p.placement === 'shaders' && p.enabled && enabledShaders.length <= 1;
  const groups = PLACEMENTS.map((pl) => {
    const items = _plugins.filter((p) => p.placement === pl.key);
    if (!items.length) return '';
    return `
      <div class="adm-card">
        <div class="adm-card-head"><i data-lucide="${pl.icon}"></i><span>${escHtml(t(pl.labelKey, pl.labelDef))}</span>
          <span class="adm-card-count">${items.filter((p) => p.enabled).length}/${items.length}</span></div>
        <div class="adm-card-body adm-plugin-list">${items.map((p) => row(p, isProtected(p))).join('')}</div>
      </div>`;
  }).join('');

  const incompatCount = _plugins.filter((p) => p.compat === false).length;
  root.innerHTML = `
    <div class="adm-page-head">
      <div>
        <h2 class="adm-page-title">${escHtml(t('admin.pluginsTitle', 'Plugins'))}</h2>
        <p class="adm-page-sub">${escHtml(t('admin.pluginsIntro', 'Activez ou désactivez les modules. Les changements s\'appliquent au prochain chargement du viewer.'))} · ${enabled}/${_plugins.length}</p>
      </div>
    </div>
    ${incompatCount ? `<div class="adm-update-state adm-warn" style="margin-bottom:14px"><i data-lucide="alert-triangle"></i> ${escHtml(t('admin.compatIntro', 'Un plugin incompatible n\'est pas chargé par le viewer ; il redevient actif dès qu\'une mise à jour satisfait sa contrainte de version.'))}</div>` : ''}
    ${groups}`;

  root.querySelectorAll('.adm-plugin-toggle').forEach((cb) =>
    cb.addEventListener('change', () => onToggle(cb)));
  refreshIcons(root);
}

async function onToggle(cb) {
  const path = cb.dataset.path;
  const enabled = cb.checked;
  cb.disabled = true;
  const r = await apiFetchStatus(`${API_ADMIN}?action=set_plugin`,
    { method: 'POST', body: JSON.stringify({ id: path, enabled }) });
  cb.disabled = false;

  if (r.ok && r.data?.ok) {
    const p = _plugins.find((x) => x.path === path);
    if (p) p.enabled = enabled;
    toast(enabled ? t('admin.pluginEnabled', 'Plugin activé ✓') : t('admin.pluginDisabled', 'Plugin désactivé ✓'));
    render();
  } else if (r.status === 409 && r.data?.error === 'last_shader') {
    cb.checked = true;   // revert
    toast(t('admin.lastShaderWarn', 'Au moins un mode de rendu doit rester actif.'), 'warning');
  } else {
    cb.checked = !enabled;  // revert
    toast(t('admin.pluginError', 'Erreur lors du changement d\'état du plugin.'), 'error');
  }
}

async function load() {
  const data = await apiFetch(`${API_ADMIN}?action=plugins`);
  if (data?.plugins) _plugins = data.plugins;
  render();
}

export const PluginsTab = {
  id: 'plugins',
  titleKey: 'admin.navPlugins',
  titleDefault: 'Plugins',
  mounted: false,
  mount() { render(); load(); },
  activate() { load(); },
  relabel() { render(); },
};
