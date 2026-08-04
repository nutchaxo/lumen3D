<?php
/**
 * Router for PHP's built-in dev server (`php -S`).
 *
 * `php -S` ignores api/.htaccess, so the Apache deny rules for sensitive
 * server-side files (credential hash, stats, plugin toggles, legacy config,
 * the shared admin lib) would otherwise be servable as plain static files.
 * This router replicates that same deny list before falling through to the
 * built-in server's normal static/script handling.
 */

// Derive the path WITHOUT parse_url(). A request beginning with two slashes makes
// parse_url() read the first segment as an authority: for '//api/admin_credential.json'
// it returns host='api', path='/admin_credential.json', which matches no deny rule —
// while `php -S` collapses the slashes and serves the real file, so the credential
// hash went out with a 200. Three slashes are worse still: parse_url() returns false
// outright and every rule below sees an empty path.
// Split the query off the RAW URI first (so an encoded '%3F' stays part of the path),
// then decode, then normalise to exactly what the server will open.
$path = explode('?', (string)($_SERVER['REQUEST_URI'] ?? ''), 2)[0];
$path = urldecode($path);
$path = preg_replace('#/+#', '/', $path);      // '//api' | '///api' → '/api'
$_segs = [];
foreach (explode('/', $path) as $_s) {
    if ($_s === '' || $_s === '.') continue;
    if ($_s === '..') { array_pop($_segs); continue; }
    $_segs[] = $_s;
}
$path = '/' . implode('/', $_segs);

// Deny EVERY api/*.json (credential/stats/plugin toggles/quarantine/TRUST STORE)
// plus the shared PHP includes (underscore-prefixed) — mirrors api/.htaccess's
// `\.json$` catch-all so this php -S twin can't drift as new state files are added.
// The real API routes are .php (auth/datasets/admin/plugins), unaffected.
// The directory deny mirrors the root .htaccess: secrets/ holds the Ed25519
// signing seeds, logs/ and backups/ hold operational traces and copies of them,
// and uploads/ holds dataset bytes that have not been validated yet (the admin
// preview reads those through api/upload.php?action=blob, never a static URL).
if (preg_match('#^/api/.*\.json$#i', $path)
    || preg_match('#^/api/_[A-Za-z0-9_]+\.php$#i', $path)
    || preg_match('#^/api/config\.php$#i', $path)
    || preg_match('#^/(secrets|logs|backups|uploads|\.git)(/|$)#i', $path)) {
    http_response_code(403);
    header('Content-Type: text/plain');
    echo 'Forbidden';
    return true;
}

// The dataset catalog is derived from every DATA_WEB/<type>/<name>/metadata.json.
// Mirrors the .htaccess rewrite so a dataset dropped in by SFTP shows up without a
// manual "Régénérer catalog.json" — api/catalog.php builds the response per request;
// there is no catalog file on disk any more.
if ($path === '/DATA_WEB/catalog.json') {
    require __DIR__ . '/api/catalog.php';
    return true;
}

// HTML documents: inject a per-request CSP nonce + emit the enforcing nonce-CSP
// (same policy as dev_server.py). Without this, `php -S` would serve the raw
// {{CSP_NONCE}} placeholder with no CSP header, leaving the trust gate cosmetic.
if ($path === '/' || substr($path, -5) === '.html') {
    require_once __DIR__ . '/api/_html_server.php';
    if (lumen_serve_html(__DIR__, lumen_request_rel($_SERVER, __DIR__))) {
        return true;
    }
}

return false;
