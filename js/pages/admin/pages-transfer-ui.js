/**
 * Admin SPA — page import / export, the requests shared by the Import / export tab
 * ================================================================================
 * The tab (tab-pages-io.js) owns the dialogs, the verification report and the version
 * writes; what stays here is what talks to the media library and to the page variables:
 *   - readLibraryFile / download   a library image as base64, a file saved by the browser;
 *   - importMedia                  api/media.php upload (an identical file already there is
 *                                  reused; a different one gets the name the server picks,
 *                                  and the pages follow);
 *   - importVariables              instance.json `variables`, absent ones only (merge write).
 */

'use strict';

import { API_SITE, API_MEDIA, t, apiFetch, apiFetchStatus } from './shared.js';
import { collectMediaRefs, collectTokens, planMedia, planVariables } from './pages-transfer.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function readLibraryFile(name) {
  try {
    const res = await fetch(`config/uploads/${encodeURIComponent(name)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return { blob, data: await blobToBase64(blob) };
  } catch (_) { return null; }
}

export function download(text, fileName) {
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

async function postJson(url, body) {
  return apiFetchStatus(url, { method: 'POST', body: JSON.stringify(body == null ? {} : body) });
}

/**
 * The images the pages use, written to the media library: an identical file already
 * there is reused, a different one gets the name the server picks. → Map oldName → newName
 * (the pages follow); what could not be written is added to `notes`.
 */
export async function importMedia(bundle, pagesIn, say, notes) {
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
  return renames;
}

/**
 * The fixed page variables the pages use, merged into instance.variables (absent
 * ones only; a different value already set is kept and reported in `notes`).
 * ctx = { instance(), saveInstancePaths(paths) }
 */
export async function importVariables(ctx, bundle, pagesIn, say, notes) {
  if (!Object.keys(bundle.variables).length) return;
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
