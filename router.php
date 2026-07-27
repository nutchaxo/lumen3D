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

$path = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));

// Collapse duplicate slashes and resolve './' | '../' BEFORE matching. The deny
// rules below are anchored to '/api/…', but `php -S` normalises the path when it
// resolves the file — so the raw '//api/admin_credential.json' slipped past an
// un-normalised check and was served. Match what the server will actually open.
$path = preg_replace('#/+#', '/', $path);
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
// signing seeds, logs/ and backups/ hold operational traces and copies of them.
if (preg_match('#^/api/.*\.json$#i', $path)
    || preg_match('#^/api/_[A-Za-z0-9_]+\.php$#i', $path)
    || preg_match('#^/api/config\.php$#i', $path)
    || preg_match('#^/(secrets|logs|backups|\.git)(/|$)#i', $path)) {
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
