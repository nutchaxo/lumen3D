/**
 * Admin SPA — client of api/page-versions.php (the history of every page)
 * =======================================================================
 * One function per action of DOCS/pages-library/SPEC.md §3. Every call answers
 * { ok, status, data, error }: `error` is the server's code ('' when ok), or one of
 * the client's own — 'network' (no answer), 'auth' (session gone), 'bad_answer' (a
 * 200 that is not the JSON the endpoint speaks). `errorText` turns it into a
 * translated sentence; the raw code, the HTTP status and any server message stay
 * out of the DOM.
 */

'use strict';

import { t, apiFetchStatus } from './shared.js';

export const API_VERSIONS = 'api/page-versions.php';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function url(action, params) {
  const q = [`action=${encodeURIComponent(action)}`];
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') q.push(`${k}=${encodeURIComponent(v)}`);
  return `${API_VERSIONS}?${q.join('&')}`;
}

async function call(action, params, body) {
  const write = body !== undefined;
  const r = await apiFetchStatus(url(action, params), write ? { method: 'POST', body: JSON.stringify(body) } : { cache: 'no-store' });
  const data = isObj(r.data) ? r.data : null;
  if (r.ok && data && data.error === undefined) return { ok: true, status: r.status, data, error: '' };
  let error = data && typeof data.error === 'string' ? data.error : '';
  if (!error) {
    if (r.status === 0) error = 'network';
    else if (r.status === 401) error = 'auth';
    else error = r.ok ? 'bad_answer' : `http_${r.status}`;
  }
  // The script is a static asset and the endpoint a separate file: an update can reach one without the other. A
  // missing endpoint (404 / 405 / 501 that is not the endpoint's own JSON `not_found`), or a page that answers a
  // list with something that is not its JSON, is "this server is too old", not a failure a retry could fix.
  if ((r.status === 404 || r.status === 405 || r.status === 501) && error !== 'not_found') error = 'unsupported';
  else if (r.ok && !data && action === 'list') error = 'unsupported';
  return { ok: false, status: r.status, data, error };
}

/** The histories: one page (`slug`), or every page that has one. data.pages = { slug: { active, count, versions } } */
export const list = (slug) => call('list', slug ? { slug } : {});
/** One version with its content. data.version */
export const get = (slug, id) => call('get', { slug, id });
/** body = { label?, note?, origin, content, exportedAt?, source?, platform?, activate?, snapshotLabel? } */
export const add = (slug, body) => call('add', { slug }, body);
/** body = { label? | note? | content? | fromLive? } */
export const update = (slug, id, body) => call('update', { slug, id }, body);
/** body = { mode?: 'publish'|'draft', snapshotLabel? } */
export const activate = (slug, id, body) => call('activate', { slug, id }, body || {});
export const remove = (slug, id) => call('delete', { slug, id }, {});
export const purge = (slug) => call('purge', { slug }, {});

const ERRORS = {
  network: ['pagesIo.err.network', 'The server cannot be reached. Check the connection and try again.'],
  auth: ['pagesIo.err.auth', 'Your session has ended. Sign in again.'],
  forbidden: ['pagesIo.err.forbidden', 'The server refused the request. Reload the page and try again.'],
  invalid_slug: ['pagesIo.err.invalid_slug', 'This page identifier is not valid.'],
  invalid_id: ['pagesIo.err.invalid_id', 'This version does not exist any more.'],
  invalid_body: ['pagesIo.err.invalid_body', 'The server could not read the request.'],
  invalid_content: ['pagesIo.err.invalid_content', 'The page content is not valid, so nothing was saved.'],
  invalid_origin: ['pagesIo.err.invalid_body', 'The server could not read the request.'],
  invalid_mode: ['pagesIo.err.invalid_body', 'The server could not read the request.'],
  nothing_to_update: ['pagesIo.err.nothing_to_update', 'There is nothing to change.'],
  not_found: ['pagesIo.err.not_found', 'This version does not exist any more. The list has been refreshed.'],
  active_version: ['pagesIo.err.active_version', 'This is the active version. Activate another version first, then delete this one.'],
  too_many_versions: ['pagesIo.err.too_many_versions', 'This page already keeps the maximum number of versions. Delete some first.'],
  version_too_large: ['pagesIo.err.version_too_large', 'This version is too large to be kept.'],
  write_failed: ['pagesIo.err.write_failed', 'The server could not save the change. Check that it can write to its folders.'],
  internal_error: ['pagesIo.err.write_failed', 'The server could not save the change. Check that it can write to its folders.'],
  unsupported: ['pagesIo.err.unsupported', 'This server does not know page versions yet: update the platform (Updates tab), then reload this page.'],
  bad_answer: ['pagesIo.err.generic', 'The request failed. Try again.'],
};

/** A translated sentence for a failed call, never the server's own words. */
export function errorText(res) {
  const code = res && res.error;
  let entry = ERRORS[code];
  if (!entry && res && res.status === 403) entry = ERRORS.forbidden;
  if (!entry) entry = ['pagesIo.err.generic', 'The request failed. Try again.'];
  return t(entry[0], entry[1]);
}
