/**
 * Admin SPA — Security tab
 * ========================
 * Change the admin password (requires the current one). Also explains the
 * hardened storage model so an operator understands the guarantees.
 */

'use strict';

import { API_AUTH, t, escHtml, apiFetchStatus, toast, el, refreshIcons } from './shared.js';

function render() {
  const root = el('security-root');
  if (!root) return;
  root.innerHTML = `
    <div class="adm-page-head">
      <h2 class="adm-page-title">${escHtml(t('admin.secPassword', 'Mot de passe administrateur'))}</h2>
      <p class="adm-page-sub">${escHtml(t('admin.securityPageSub', 'Modifiez le mot de passe d\'accès au panneau.'))}</p>
    </div>

    <div class="adm-grid adm-grid-2">
      <div class="adm-card">
        <div class="adm-card-head"><i data-lucide="key-round"></i><span>${escHtml(t('admin.changePassword', 'Changer le mot de passe'))}</span></div>
        <div class="adm-card-body">
          <div class="adm-gate-error" id="sec-error" style="display:none"><span id="sec-error-msg"></span></div>
          <div class="adm-field">
            <label class="adm-field-label">${escHtml(t('admin.currentPassword', 'Mot de passe actuel'))}</label>
            <input type="password" id="sec-current" class="adm-field-input" autocomplete="current-password">
          </div>
          <div class="adm-field">
            <label class="adm-field-label">${escHtml(t('admin.newPassword', 'Nouveau mot de passe'))}</label>
            <input type="password" id="sec-new" class="adm-field-input" autocomplete="new-password">
          </div>
          <div class="adm-field">
            <label class="adm-field-label">${escHtml(t('admin.confirmPassword', 'Confirmer le mot de passe'))}</label>
            <input type="password" id="sec-new2" class="adm-field-input" autocomplete="new-password">
          </div>
          <button class="adm-btn adm-btn-accent" id="sec-submit" style="margin-top:6px">${escHtml(t('admin.changePassword', 'Changer le mot de passe'))}</button>
        </div>
      </div>

      <div class="adm-card">
        <div class="adm-card-head"><i data-lucide="shield-check"></i><span>${escHtml(t('admin.storageModel', 'Stockage sécurisé'))}</span></div>
        <div class="adm-card-body">
          <ul class="adm-bullets">
            <li><i data-lucide="lock"></i><span>${escHtml(t('admin.secPoint1', 'Le mot de passe est stocké uniquement sous forme de hash irréversible (PBKDF2, salé). Le mot de passe en clair n\'est jamais écrit sur le disque.'))}</span></li>
            <li><i data-lucide="eye-off"></i><span>${escHtml(t('admin.secPoint2', 'Le fichier d\'identifiants n\'est jamais accessible via le serveur web (le dossier api/ est bloqué).'))}</span></li>
            <li><i data-lucide="file-x"></i><span>${escHtml(t('admin.secPoint3', 'Si le fichier est supprimé, le panneau redemande la création d\'un mot de passe au prochain accès.'))}</span></li>
            <li><i data-lucide="shield-alert"></i><span>${escHtml(t('admin.secPoint4', 'La création initiale est exclusive : elle ne peut jamais écraser un mot de passe existant.'))}</span></li>
          </ul>
        </div>
      </div>
    </div>`;
  el('sec-submit').addEventListener('click', submit);
  el('sec-new2').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  refreshIcons(root);
}

function err(msg) {
  const box = el('sec-error');
  if (!box) return;
  el('sec-error-msg').textContent = msg;
  box.style.display = msg ? 'flex' : 'none';
}

async function submit() {
  const current = el('sec-current').value || '';
  const n1 = el('sec-new').value || '';
  const n2 = el('sec-new2').value || '';
  err('');
  if (n1.length < 4) { err(t('admin.setupWeak', 'Mot de passe trop court (4 caractères minimum).')); return; }
  if (n1 !== n2) { err(t('admin.setupMismatch', 'Les mots de passe ne correspondent pas.')); return; }

  const btn = el('sec-submit');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner spinner-sm"></span> ${t('admin.saving', 'Sauvegarde…')}`;
  const r = await apiFetchStatus(`${API_AUTH}?action=change_password`,
    { method: 'POST', body: JSON.stringify({ current, new: n1 }) });
  btn.disabled = false;
  btn.textContent = t('admin.changePassword', 'Changer le mot de passe');

  if (r.ok && r.data?.ok) {
    toast(t('admin.passwordChanged', 'Mot de passe modifié ✓'));
    ['sec-current', 'sec-new', 'sec-new2'].forEach((id) => { const e = el(id); if (e) e.value = ''; });
  } else if (r.status === 401 || r.data?.error === 'bad_current') {
    err(t('admin.badCurrent', 'Mot de passe actuel incorrect.'));
  } else if (r.data?.error === 'weak_password') {
    err(t('admin.setupWeak', 'Mot de passe trop court (4 caractères minimum).'));
  } else {
    err(t('admin.changeFailed', 'Échec du changement de mot de passe.'));
  }
}

export const SecurityTab = {
  id: 'security',
  titleKey: 'admin.navSecurity',
  titleDefault: 'Sécurité',
  mounted: false,
  mount() { render(); },
  activate() {},
  relabel() { render(); },
};
