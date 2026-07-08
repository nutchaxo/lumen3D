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

const TRUST_BADGE = {
  bundled: ['adm-tag-ok', 'intégré'],
  dev: ['adm-tag-ok', 'dev'],
  'approved-trusted': ['adm-tag-ok', 'approuvé'],
  sandboxed: ['adm-tag-ok', 'sandbox'],
  untrusted: ['adm-tag-danger', 'non fiable'],
};

function trustControls(p) {
  const tier = p.trust && p.trust.tier;
  if (!tier) return '';
  if (tier === 'untrusted') {
    // Not loaded until an operator approves this exact content hash.
    return `<div class="adm-trust-actions">
        <button class="adm-btn adm-btn-ghost adm-btn-sm adm-approve" data-path="${escHtml(p.path)}" data-mode="sandboxed"><i data-lucide="box"></i> ${escHtml(t('admin.approveSandboxed', 'Approuver (bac à sable)'))}</button>
        <button class="adm-btn adm-btn-ghost adm-btn-sm adm-approve" data-path="${escHtml(p.path)}" data-mode="trusted"><i data-lucide="shield-check"></i> ${escHtml(t('admin.approveTrusted', 'Approuver (in-page)'))}</button>
      </div>`;
  }
  if (tier === 'approved-trusted' || tier === 'sandboxed') {
    return `<div class="adm-trust-actions">
        <button class="adm-btn adm-btn-ghost adm-btn-sm adm-revoke" data-path="${escHtml(p.path)}"><i data-lucide="shield-off"></i> ${escHtml(t('admin.revoke', 'Révoquer'))}</button>
      </div>`;
  }
  return '';
}

function row(p, isProtected) {
  // compat === false → the server-side gate excludes this plugin from discovery
  // (its index.js is never loaded); explain WHY inline and freeze the toggle.
  const incompatible = p.compat === false;
  const tier = p.trust && p.trust.tier;
  const untrusted = tier === 'untrusted';
  const dis = (p.enabled && !incompatible && !untrusted) ? '' : 'is-off';
  const lock = (isProtected || incompatible) ? 'disabled' : '';
  const [badgeCls, badgeTxt] = TRUST_BADGE[tier] || ['', ''];
  const meta = [p.version ? `v${escHtml(p.version)}` : '', p.creator ? escHtml(p.creator) : '', escHtml(p.path)]
    .filter(Boolean).join(' · ');
  const hashShort = p.trust && p.trust.hash ? p.trust.hash.slice(0, 12) : '';
  return `
    <div class="adm-plugin-row ${dis}" data-path="${escHtml(p.path)}">
      <span class="adm-plugin-ic"><i data-lucide="${escHtml(p.icon || 'puzzle')}"></i></span>
      <div class="adm-plugin-info">
        <div class="adm-plugin-name">${escHtml(p.name || p.id)}${isProtected ? ` <span class="adm-tag">${escHtml(t('admin.protectedPlugin', 'protégé'))}</span>` : ''}${badgeTxt ? ` <span class="adm-tag ${badgeCls}" title="${escHtml((p.trust && p.trust.reason) || '')}">${escHtml(badgeTxt)}</span>` : ''}${incompatible ? ` <span class="adm-tag adm-tag-warn" title="${escHtml(p.compatReason || '')}">${escHtml(t('admin.compatIncompatible', 'incompatible'))}</span>` : ''}</div>
        <div class="adm-plugin-meta">${meta}${hashShort ? ` · <span class="adm-compat-reason" title="${escHtml(p.trust.hash)}">#${hashShort}</span>` : ''}</div>
        ${untrusted ? trustControls(p) : ''}
      </div>
      ${untrusted ? '' : `<label class="adm-switch" title="${isProtected ? escHtml(t('admin.lastShaderWarn', 'Au moins un mode de rendu doit rester actif.')) : (incompatible ? escHtml(t('admin.compatIntro', 'Un plugin incompatible n\'est pas chargé par le viewer ; il redevient actif dès qu\'une mise à jour satisfait sa contrainte de version.')) : '')}">
        <input type="checkbox" class="adm-plugin-toggle" data-path="${escHtml(p.path)}" ${p.enabled && !incompatible ? 'checked' : ''} ${lock}>
        <span class="adm-switch-track"><span class="adm-switch-thumb"></span></span>
      </label>`}
      ${(tier === 'approved-trusted' || tier === 'sandboxed') ? trustControls(p) : ''}
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
  root.querySelectorAll('.adm-approve').forEach((b) =>
    b.addEventListener('click', () => onApprove(b.dataset.path, b.dataset.mode)));
  root.querySelectorAll('.adm-revoke').forEach((b) =>
    b.addEventListener('click', () => onRevoke(b.dataset.path)));
  refreshIcons(root);
}

// Approve an untrusted plugin, PINNED to the exact content hash the server sees.
// Re-authentication (current password) is required server-side (INV-4): approving
// is the one action that lets third-party code run, so a live admin session alone
// must not suffice (a compromised in-page script can't self-approve).
async function onApprove(path, mode) {
  const p = _plugins.find((x) => x.path === path);
  if (!p || !p.trust) return;
  const caps = (p.trust.declaredCaps || []);
  const capsNote = mode === 'sandboxed' && caps.length
    ? `\n\n${t('admin.approveCapsNote', 'Capabilities accordées')} : ${caps.join(', ')}` : '';
  const warn = mode === 'trusted'
    ? t('admin.approveTrustedWarn', 'ATTENTION : ce plugin s\'exécutera avec les pleins privilèges de la page (comme un plugin intégré). N\'approuvez « in-page » que du code que vous avez audité.')
    : t('admin.approveSandboxedWarn', 'Ce plugin s\'exécutera isolé dans un bac à sable (sans accès au DOM ni à l\'API admin).');
  if (!confirm(`${warn}\n\n${t('admin.approveHashNote', 'Empreinte')} : ${p.trust.hash}${capsNote}`)) return;
  const password = prompt(t('admin.reauthPrompt', 'Confirmez votre mot de passe administrateur pour approuver :'));
  if (!password) return;
  const r = await apiFetchStatus(`${API_ADMIN}?action=approve_plugin`, {
    method: 'POST',
    body: JSON.stringify({ path, sha256: p.trust.hash, mode, caps, password }),
  });
  if (r.ok && r.data?.ok) {
    toast(t('admin.pluginApproved', 'Plugin approuvé ✓ (rechargez le viewer)'));
    load();
  } else if (r.data?.error === 'bad_password') {
    toast(t('admin.badPassword', 'Mot de passe incorrect.'), 'error');
  } else if (r.data?.error === 'hash_mismatch') {
    toast(t('admin.hashMismatch', 'Le contenu du plugin a changé — rechargez la liste et revérifiez.'), 'error');
  } else {
    toast(t('admin.pluginError', 'Erreur lors de l\'approbation.'), 'error');
  }
}

async function onRevoke(path) {
  if (!confirm(t('admin.revokeConfirm', 'Révoquer l\'approbation de ce plugin ? Il ne se chargera plus.'))) return;
  const r = await apiFetchStatus(`${API_ADMIN}?action=revoke_plugin`, {
    method: 'POST', body: JSON.stringify({ path }),
  });
  if (r.ok && r.data?.ok) { toast(t('admin.pluginRevoked', 'Approbation révoquée ✓')); load(); }
  else toast(t('admin.pluginError', 'Erreur lors de la révocation.'), 'error');
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
