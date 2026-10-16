/**
 * Admin SPA — page import / export, the dialogs and the requests
 * ==============================================================
 * Export: the operator ticks pages (built-in home / about with authored content,
 * custom pages of the menu); each page document is read as the admin sees it
 * (published + private draft), the media library images it references are read
 * as base64, the fixed page variables it uses are copied, and one
 * `*.lumen-pages.json` file is downloaded (format in pages-transfer.js).
 *
 * Import: the file is parsed and validated BEFORE any write (pages-transfer.js
 * parseBundle), the operator sees what it will do (new page / replaces …, target
 * slug editable, publish now or keep as a draft), then the writes go through the
 * existing endpoints, one at a time:
 *   1. images      api/media.php upload (an identical file already there is reused;
 *                  a different one gets the name the server picks, and the pages follow);
 *   2. variables   instance.json `variables`, absent ones only (merge write);
 *   3. pages       api/site.php save_draft [+ publish] — the same writes as the editor;
 *   4. menu        instance.json `nav.customPages`, a row for each new custom page
 *                  (hidden unless published).
 * An editor tab open on an imported page is told to stop autosaving first (the
 * editor's BroadcastChannel `takeover`), so it cannot write its older draft over the
 * import.
 */

'use strict';

import { API_SITE, API_MEDIA, API_ADMIN, t, escHtml, apiFetch, apiFetchStatus, toast, refreshIcons } from './shared.js';
import {
  SCHEMA, FILE_EXTENSION, isEmptyDoc, pageEntry, usedVariables, collectMediaRefs, collectTokens,
  buildBundle, bundleFileName, mediaType, parseBundle, planImport, planMedia, planVariables,
  renameMediaRefs, pageWrites, widgetCount, pageLocales, primaryContent, MEDIA_MAX_BYTES,
} from './pages-transfer.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// ── Small dialog shell (same overlay as the admin's other confirmations) ─────
function openDialog(html) {
  const overlay = document.createElement('div');
  overlay.className = 'upl-exit pg-xfer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `<div class="upl-exit-card pg-xfer-card">${html}</div>`;
  const previous = document.activeElement;
  let onClose = null;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    try { previous?.focus?.(); } catch (_) { /* gone */ }
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && !overlay.dataset.busy) { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  refreshIcons(overlay);
  return { overlay, card: overlay.firstElementChild, close, set onClose(fn) { onClose = fn; } };
}

function localLabel(v, loc) {
  if (typeof v === 'string') return v;
  if (isObj(v)) return v[loc] || v.en || Object.values(v).find((x) => typeof x === 'string' && x) || '';
  return '';
}

function widgetsText(n) {
  return `${n} ${n === 1 ? t('pages.xfer.widget', 'widget') : t('pages.xfer.widgets', 'widgets')}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function readLibraryFile(name) {
  try {
    const res = await fetch(`config/uploads/${encodeURIComponent(name)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return { blob, data: await blobToBase64(blob) };
  } catch (_) { return null; }
}

function download(text, fileName) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function readPageDoc(slug) {
  const r = await apiFetchStatus(`${API_SITE}?action=get&doc=pages/${encodeURIComponent(slug)}`);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, doc: isObj(r.data) ? r.data : {} };
}

// ══════════════════════════════════════════════════════════════
// Export
// ══════════════════════════════════════════════════════════════
/**
 * ctx = { pages() → [{slug, builtin, label}], currentSlug(), instance(), locale() }
 */
export async function openExportDialog(ctx) {
  const list = ctx.pages();
  const dlg = openDialog(`
    <h3 class="upl-exit-title"><i data-lucide="file-down"></i> ${escHtml(t('pages.xfer.exportTitle', 'Exporter des pages'))}</h3>
    <p class="upl-exit-body">${escHtml(t('pages.xfer.exportSub', 'Un fichier .lumen-pages.json avec le contenu publié, le brouillon en cours, les images de la médiathèque et les variables utilisées. Il s\'importe sur cette instance ou sur une autre.'))}</p>
    <div class="pg-xfer-list" data-role="list"><div class="pg-xfer-row is-note"><span class="spinner spinner-sm"></span> ${escHtml(t('pages.xfer.reading', 'Lecture des pages…'))}</div></div>
    <label class="pg-xfer-opt"><input type="checkbox" data-role="media" checked> ${escHtml(t('pages.xfer.includeMedia', 'Inclure les images de la médiathèque utilisées par ces pages'))}</label>
    <p class="pg-xfer-status" data-role="status" aria-live="polite"></p>
    <div class="upl-exit-actions">
      <button type="button" class="adm-btn adm-btn-ghost" data-act="cancel">${escHtml(t('admin.cancel', 'Annuler'))}</button>
      <button type="button" class="adm-btn adm-btn-accent" data-act="go" disabled><i data-lucide="download"></i> ${escHtml(t('pages.xfer.download', 'Télécharger'))}</button>
    </div>`);
  const $ = (sel) => dlg.card.querySelector(sel);
  $('[data-act="cancel"]').addEventListener('click', dlg.close);

  // Read every page as the operator sees it, so the list says what each one holds.
  const docs = new Map();
  for (const p of list) docs.set(p.slug, await readPageDoc(p.slug));
  if (!dlg.overlay.isConnected) return;
  const current = ctx.currentSlug();
  const rows = list.map((p) => {
    const r = docs.get(p.slug);
    const empty = r.ok && isEmptyDoc(r.doc);
    const name = p.builtin ? t(`pages.xfer.builtin_${p.slug}`, p.slug === 'home' ? 'Accueil' : 'À propos') : (p.label || p.slug);
    let note;
    if (!r.ok) note = t('pages.xfer.unreadable', 'illisible');
    else if (empty) note = p.builtin ? t('pages.xfer.defaultPage', 'page par défaut — rien à exporter') : t('pages.xfer.emptyPage', 'vide');
    else {
      const hasDraft = isObj(r.doc.draft) && JSON.stringify(r.doc.draft) !== JSON.stringify(r.doc.published);
      note = `${widgetsText(widgetCount(primaryContent(pageEntry(p.slug, r.doc)) || {}))}${hasDraft ? ' · ' + t('pages.xfer.hasDraft', 'brouillon non publié') : ''}`;
    }
    const disabled = !r.ok || (empty && p.builtin);
    const checked = !disabled && (!empty) && (p.slug === current || list.length <= 6);
    return `<label class="pg-xfer-row${disabled ? ' is-disabled' : ''}">
      <input type="checkbox" data-slug="${escHtml(p.slug)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="pg-xfer-name">${escHtml(name)} <code>${escHtml(p.slug)}</code></span>
      <span class="pg-xfer-note">${escHtml(note)}</span>
    </label>`;
  });
  $('[data-role="list"]').innerHTML = rows.join('');
  const go = $('[data-act="go"]');
  const sync = () => { go.disabled = !dlg.card.querySelector('input[data-slug]:checked'); };
  dlg.card.querySelectorAll('input[data-slug]').forEach((i) => i.addEventListener('change', sync));
  sync();

  go.addEventListener('click', async () => {
    const slugs = [...dlg.card.querySelectorAll('input[data-slug]:checked')].map((i) => i.dataset.slug);
    if (!slugs.length) return;
    go.disabled = true;
    dlg.overlay.dataset.busy = '1';
    const status = $('[data-role="status"]');
    try {
      const inst = ctx.instance() || {};
      const navRows = (isObj(inst.nav) && Array.isArray(inst.nav.customPages)) ? inst.nav.customPages : [];
      const pages = slugs.map((slug) => pageEntry(slug, docs.get(slug).doc, navRows.find((n) => n && n.slug === slug)));
      const media = [];
      const skipped = [];
      if ($('[data-role="media"]').checked) {
        const names = collectMediaRefs(pages);
        for (let i = 0; i < names.length; i++) {
          status.textContent = t('pages.xfer.readingMedia', 'Lecture des images… {n}/{total}').replace('{n}', i + 1).replace('{total}', names.length);
          const f = await readLibraryFile(names[i]);
          if (!f || f.blob.size > MEDIA_MAX_BYTES) { skipped.push(names[i]); continue; }
          media.push({ name: names[i], type: f.blob.type || mediaType(names[i]), data: f.data });
        }
      }
      let platform = '';
      try { const v = await apiFetch(`${API_ADMIN}?action=version`); platform = (v && v.web) || ''; } catch (_) {}
      const bundle = buildBundle({ pages, media, variables: usedVariables(pages, inst.variables), platform, source: location.host });
      download(JSON.stringify(bundle, null, 2), bundleFileName(bundle, location.host));
      dlg.close();
      toast(t('pages.xfer.exported', '{n} page(s) exportée(s).').replace('{n}', pages.length), 'success');
      if (skipped.length) toast(t('pages.xfer.mediaSkipped', 'Images non incluses (introuvables ou > 8 Mo) : {list}').replace('{list}', skipped.join(', ')), 'warning');
    } catch (e) {
      console.error('page export', e);
      delete dlg.overlay.dataset.busy;
      go.disabled = false;
      status.textContent = t('pages.xfer.exportFailed', 'L\'export a échoué.');
    }
  });
}

// ══════════════════════════════════════════════════════════════
// Import
// ══════════════════════════════════════════════════════════════
const ERROR_TEXT = {
  json: ['pages.xfer.err.json', 'Ce fichier n\'est pas un JSON lisible.'],
  schema: ['pages.xfer.err.schema', 'Ce fichier n\'est pas un export de pages ({schema}).'],
  version: ['pages.xfer.err.version', 'Format {detail} inconnu de cette version de la plateforme : mettez-la à jour.'],
  pages: ['pages.xfer.err.pages', 'Le fichier ne contient aucune page valide.'],
  slug: ['pages.xfer.err.slug', 'Identifiant de page invalide : « {detail} ».'],
  duplicate: ['pages.xfer.err.duplicate', 'Page présente deux fois : « {detail} ».'],
  content: ['pages.xfer.err.content', 'Contenu de page invalide ({detail}).'],
  size: ['pages.xfer.err.size', 'Trop volumineux ({detail}).'],
  media: ['pages.xfer.err.media', 'Image invalide ou trop lourde dans le fichier : {detail}.'],
  variables: ['pages.xfer.err.variables', 'Variable invalide dans le fichier : {detail}.'],
};
function errorText(e) {
  const [k, d] = ERROR_TEXT[e.code] || ['pages.xfer.err.json', ERROR_TEXT.json[1]];
  return t(k, d).replace('{detail}', e.detail != null ? String(e.detail) : '').replace('{schema}', SCHEMA);
}

/** Opens the file picker, then the import dialog. */
export function pickImportFile(ctx) {
  if (ctx.isBusy()) { toast(t('pages.xfer.busy', 'Des modifications de page ne sont pas encore enregistrées : attendez la fin de l\'enregistrement.'), 'warning'); return; }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = `${FILE_EXTENSION},.json,application/json`;
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let text;
    try { text = await file.text(); } catch (_) { toast(errorText({ code: 'json' }), 'error'); return; }
    const parsed = parseBundle(text, file.name);
    if (!parsed.ok) {
      const lines = parsed.errors.slice(0, 6).map(errorText);
      const dlg = openDialog(`
        <h3 class="upl-exit-title">${escHtml(t('pages.xfer.importTitle', 'Importer des pages'))}</h3>
        <p class="upl-exit-body">${escHtml(t('pages.xfer.refused', 'Rien n\'a été importé :'))} <strong>${escHtml(file.name)}</strong></p>
        <ul class="pg-xfer-errors">${lines.map((l) => `<li>${escHtml(l)}</li>`).join('')}</ul>
        <div class="upl-exit-actions"><button type="button" class="adm-btn adm-btn-accent" data-act="ok">OK</button></div>`);
      dlg.card.querySelector('[data-act="ok"]').addEventListener('click', dlg.close);
      return;
    }
    openImportDialog(ctx, parsed, file.name);
  });
  input.click();
}

/**
 * ctx = { pages(), instance(), locale(), isBusy(), normalizeContent(block),
 *         reconcileInstance(), saveInstancePaths(paths), takeOver(slug), afterImport(slugs) }
 */
export function openImportDialog(ctx, parsed, fileName) {
  const loc = ctx.locale();
  const bundle = parsed.bundle;
  const existing = ctx.pages().map((p) => p.slug);
  const targets = bundle.pages.map((p) => p.slug);
  const origin = [bundle.source, bundle.platform ? 'v' + bundle.platform : '', bundle.exportedAt ? bundle.exportedAt.slice(0, 10) : ''].filter(Boolean).join(' · ');
  const mediaBytes = bundle.media.reduce((n, m) => n + (m.size || 0), 0);
  const varCount = Object.keys(bundle.variables).length;
  const warn = parsed.warnings.filter((w) => w.code === 'mediaMissing').map((w) => t('pages.xfer.mediaMissing', 'Images référencées mais absentes du fichier (elles s\'afficheront seulement si cette instance les possède déjà) : {list}').replace('{list}', w.detail));

  const dlg = openDialog(`
    <h3 class="upl-exit-title"><i data-lucide="file-up"></i> ${escHtml(t('pages.xfer.importTitle', 'Importer des pages'))}</h3>
    <p class="upl-exit-body"><strong>${escHtml(fileName)}</strong>${origin ? ` <span class="pg-xfer-origin">${escHtml(origin)}</span>` : ''}</p>
    <div class="pg-xfer-list" data-role="list"></div>
    <p class="pg-xfer-meta">${escHtml([
      bundle.media.length ? t('pages.xfer.mediaCount', '{n} image(s) pour la médiathèque ({size})').replace('{n}', bundle.media.length).replace('{size}', fmtBytes(mediaBytes)) : '',
      varCount ? t('pages.xfer.varCount', '{n} variable(s) de page').replace('{n}', varCount) : '',
    ].filter(Boolean).join(' · '))}</p>
    ${warn.map((w) => `<p class="pg-xfer-warn">${escHtml(w)}</p>`).join('')}
    <label class="pg-xfer-opt"><input type="checkbox" data-role="publish"> ${escHtml(t('pages.xfer.publishNow', 'Publier directement'))}</label>
    <p class="pg-xfer-hint" data-role="hint"></p>
    <p class="pg-xfer-status" data-role="status" aria-live="polite"></p>
    <div class="upl-exit-actions">
      <button type="button" class="adm-btn adm-btn-ghost" data-act="cancel">${escHtml(t('admin.cancel', 'Annuler'))}</button>
      <button type="button" class="adm-btn adm-btn-accent" data-act="go"><i data-lucide="upload"></i> ${escHtml(t('pages.xfer.importBtn', 'Importer'))}</button>
    </div>`);
  const $ = (sel) => dlg.card.querySelector(sel);
  const publishBox = $('[data-role="publish"]');
  const go = $('[data-act="go"]');
  $('[data-act="cancel"]').addEventListener('click', dlg.close);

  const checked = bundle.pages.map(() => true);
  const hint = () => {
    $('[data-role="hint"]').textContent = publishBox.checked
      ? t('pages.xfer.hintPublish', 'Les pages importées remplacent tout de suite ce que voient les visiteurs.')
      : t('pages.xfer.hintDraft', 'Les pages importées arrivent en brouillon : les visiteurs voient la version actuelle jusqu\'à ce que vous publiiez depuis l\'éditeur.');
  };
  const draw = () => {
    const plan = planImport(bundle, existing, targets);
    $('[data-role="list"]').innerHTML = plan.map((r) => {
      const p = bundle.pages[r.index];
      const name = localLabel(p.nav && p.nav.label, loc) || localLabel(p.title, loc) || (r.builtin ? t(`pages.xfer.builtin_${r.target}`, r.target === 'home' ? 'Accueil' : 'À propos') : p.slug || '—');
      let state;
      if (r.error === 'slug') state = `<span class="pg-xfer-tag is-error">${escHtml(t('pages.xfer.badSlug', 'identifiant invalide'))}</span>`;
      else if (r.error === 'duplicate') state = `<span class="pg-xfer-tag is-error">${escHtml(t('pages.xfer.dupTarget', 'cible en double'))}</span>`;
      else if (r.builtin) state = `<span class="pg-xfer-tag is-warn">${escHtml(t('pages.xfer.replacesBuiltin', 'remplace la page intégrée'))}</span>`;
      else if (r.exists) state = `<span class="pg-xfer-tag is-warn">${escHtml(t('pages.xfer.replaces', 'remplace la page existante'))}</span>`;
      else state = `<span class="pg-xfer-tag is-new">${escHtml(t('pages.xfer.newPage', 'nouvelle page'))}</span>`;
      const content = primaryContent(p);
      const langs = pageLocales(p);
      const facts = [widgetsText(widgetCount(content)), langs.length ? langs.join(' ').toUpperCase() : '', p.draft && p.published ? t('pages.xfer.withDraft', '+ brouillon') : '', !p.published ? t('pages.xfer.draftOnly', 'brouillon seulement') : ''].filter(Boolean).join(' · ');
      return `<div class="pg-xfer-row${checked[r.index] ? '' : ' is-off'}">
        <input type="checkbox" data-i="${r.index}" ${checked[r.index] ? 'checked' : ''} aria-label="${escHtml(name)}">
        <span class="pg-xfer-name"><span class="pg-xfer-title">${escHtml(name)} ${state}</span><span class="pg-xfer-note">${escHtml(facts)}</span></span>
        <span class="pg-xfer-target"><i data-lucide="arrow-right"></i><input class="adm-field-input" data-t="${r.index}" value="${escHtml(r.target)}" spellcheck="false" aria-label="${escHtml(t('pages.xfer.target', 'Page de destination'))}"></span>
      </div>`;
    }).join('');
    refreshIcons($('[data-role="list"]'));
    dlg.card.querySelectorAll('input[data-i]').forEach((i) => i.addEventListener('change', () => { checked[+i.dataset.i] = i.checked; draw(); }));
    dlg.card.querySelectorAll('input[data-t]').forEach((i) => i.addEventListener('change', () => { targets[+i.dataset.t] = i.value.trim().toLowerCase(); draw(); }));
    const live = plan.filter((r) => checked[r.index]);
    go.disabled = !live.length || live.some((r) => r.error);
  };
  publishBox.addEventListener('change', hint);
  hint();
  draw();

  go.addEventListener('click', async () => {
    const plan = planImport(bundle, existing, targets).filter((r) => checked[r.index]);
    if (!plan.length || plan.some((r) => r.error)) return;
    if (ctx.isBusy()) { toast(t('pages.xfer.busy', 'Des modifications de page ne sont pas encore enregistrées : attendez la fin de l\'enregistrement.'), 'warning'); return; }
    const publish = publishBox.checked;
    const replaced = plan.filter((r) => r.exists).length;
    if (replaced && !confirm(t('pages.xfer.confirmReplace', '{n} page(s) existante(s) seront remplacées. Continuer ?').replace('{n}', replaced))) return;
    go.disabled = true; publishBox.disabled = true;
    dlg.overlay.dataset.busy = '1';
    dlg.card.querySelectorAll('input').forEach((i) => { i.disabled = true; });
    $('[data-act="cancel"]').disabled = true;
    const status = $('[data-role="status"]');
    const say = (s) => { status.textContent = s; };
    let result;
    try {
      result = await runImport(ctx, bundle, plan, { publish, say });
    } catch (e) {
      console.error('page import', e);
      result = { done: [], failed: plan.map((r) => r.target), notes: [] };
    }
    delete dlg.overlay.dataset.busy;
    try { await ctx.afterImport(result.done); } catch (_) {}
    dlg.close();
    if (result.done.length) toast((publish ? t('pages.xfer.importedPublished', '{n} page(s) importée(s) et publiée(s).') : t('pages.xfer.importedDraft', '{n} page(s) importée(s) en brouillon.')).replace('{n}', result.done.length), 'success');
    if (result.failed.length) toast(t('pages.xfer.importFailed', 'Échec de l\'import de : {list}').replace('{list}', result.failed.join(', ')), 'error');
    result.notes.forEach((n) => toast(n, 'warning'));
  });
}

async function postJson(url, body) {
  return apiFetchStatus(url, { method: 'POST', body: JSON.stringify(body == null ? {} : body) });
}

/** The writes, in order. Resolves { done:[slug], failed:[slug], notes:[text] }. */
export async function runImport(ctx, bundle, plan, { publish, say }) {
  const notes = [];
  const done = [];
  const failed = [];
  const targets = plan.map((r) => r.target);
  // An editor tab open on one of these pages stops autosaving before anything is written.
  targets.forEach((slug) => { try { ctx.takeOver(slug); } catch (_) {} });

  // 1. Images: only those the imported pages use.
  const pagesIn = plan.map((r) => bundle.pages[r.index]);
  const wanted = new Set(collectMediaRefs(pagesIn));
  const mediaIn = Object.assign({}, bundle, { media: bundle.media.filter((m) => wanted.has(m.name)) });
  const renames = new Map();
  if (mediaIn.media.length) {
    const lib = await postJson(`${API_MEDIA}?action=list`, {});
    const have = new Set(lib.ok && lib.data && Array.isArray(lib.data.files) ? lib.data.files.map((f) => f.name) : []);
    const library = new Map();
    for (const m of mediaIn.media) {
      if (!have.has(m.name)) continue;
      const cur = await readLibraryFile(m.name);
      library.set(m.name, { sameBytes: !!cur && cur.data === m.data });
    }
    const mp = planMedia(mediaIn, library);
    for (let i = 0; i < mp.upload.length; i++) {
      const m = mp.upload[i];
      say(t('pages.xfer.uploadingMedia', 'Images… {n}/{total}').replace('{n}', i + 1).replace('{total}', mp.upload.length));
      const r = await postJson(`${API_MEDIA}?action=upload`, { filename: m.name, data: m.data });
      const url = r.ok && r.data && typeof r.data.url === 'string' ? r.data.url : '';
      const name = url.startsWith('config/uploads/') ? url.slice('config/uploads/'.length) : '';
      if (!name) { notes.push(t('pages.xfer.mediaFailed', 'Image non importée : {name}').replace('{name}', m.name)); continue; }
      if (name !== m.name) renames.set(m.name, name);
    }
  }

  // 2. Fixed page variables: the absent ones, merged into the stored list.
  if (Object.keys(bundle.variables).length) {
    say(t('pages.xfer.savingVars', 'Variables de page…'));
    const fresh = await apiFetch(`${API_SITE}?action=get&doc=instance`);
    const stored = isObj(fresh) && isObj(fresh.variables) ? fresh.variables : {};
    const used = new Set(collectTokens(pagesIn));
    const vp = planVariables({ variables: Object.fromEntries(Object.entries(bundle.variables).filter(([k]) => used.has(k))) }, stored);
    if (Object.keys(vp.add).length) {
      const inst = ctx.instance();
      if (!isObj(inst.variables)) inst.variables = {};
      Object.assign(inst.variables, stored, vp.add);
      if (!(await ctx.saveInstancePaths(['variables']))) notes.push(t('pages.xfer.varsFailed', 'Les variables de page n\'ont pas pu être enregistrées.'));
    }
    if (vp.conflicts.length) notes.push(t('pages.xfer.varsKept', 'Variables déjà définies ici, gardées telles quelles : {list}').replace('{list}', vp.conflicts.join(', ')));
  }

  // 3. Pages, one at a time, through the editor's own endpoints.
  for (let i = 0; i < plan.length; i++) {
    const r = plan[i];
    const src = bundle.pages[r.index];
    say(t('pages.xfer.writingPage', 'Page {n}/{total} : {slug}…').replace('{n}', i + 1).replace('{total}', plan.length).replace('{slug}', r.target));
    const page = {
      title: src.title,
      published: src.published ? ctx.normalizeContent(renameMediaRefs(src.published, renames)) : null,
      draft: src.draft ? ctx.normalizeContent(renameMediaRefs(src.draft, renames)) : null,
    };
    let ok = true;
    for (const step of pageWrites(page, { publish })) {
      const url = `${API_SITE}?action=${step.action}&doc=pages/${encodeURIComponent(r.target)}`;
      const res = await postJson(url, step.body || {});
      if (!res.ok) { ok = false; break; }
    }
    (ok ? done : failed).push(r.target);
  }

  // 4. Menu rows for the custom pages that have none yet.
  const custom = plan.filter((r) => !r.builtin && done.includes(r.target));
  if (custom.length) {
    say(t('pages.xfer.savingNav', 'Menu…'));
    await ctx.reconcileInstance();
    const inst = ctx.instance();
    inst.nav = isObj(inst.nav) ? inst.nav : {};
    inst.nav.customPages = Array.isArray(inst.nav.customPages) ? inst.nav.customPages : [];
    let changed = false;
    for (const r of custom) {
      const src = bundle.pages[r.index];
      const wantShow = publish && !(src.nav && src.nav.show === false);
      const row = inst.nav.customPages.find((n) => n && n.slug === r.target);
      if (!row) {
        const label = (src.nav && Object.keys(src.nav.label || {}).length) ? src.nav.label
          : (Object.keys(src.title || {}).length ? src.title : { [ctx.locale()]: r.target });
        inst.nav.customPages.push({ slug: r.target, label, show: wantShow });
        changed = true;
      } else if (wantShow && row.show === false) {
        row.show = true;   // first publication of a hidden page, as the editor's Publish does
        changed = true;
      }
    }
    if (changed && !(await ctx.saveInstancePaths(['nav.customPages']))) notes.push(t('pages.xfer.navFailed', 'Le menu n\'a pas pu être mis à jour : ajoutez les pages depuis Identité → Navigation.'));
  }
  return { done, failed, notes };
}
