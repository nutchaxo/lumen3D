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

// Deny EVERY api/*.json (credential/stats/plugin toggles/quarantine/TRUST STORE)
// plus the shared PHP includes (underscore-prefixed) — mirrors api/.htaccess's
// `\.json$` catch-all so this php -S twin can't drift as new state files are added.
// The real API routes are .php (auth/datasets/admin/plugins), unaffected.
if (preg_match('#^/api/[^/]+\.json$#i', $path)
    || preg_match('#^/api/_[A-Za-z0-9_]+\.php$#i', $path)
    || preg_match('#^/api/config\.php$#i', $path)) {
    http_response_code(403);
    header('Content-Type: text/plain');
    echo 'Forbidden';
    return true;
}

// HTML documents: inject a per-request CSP nonce + emit the enforcing nonce-CSP
// (same policy as dev_server.py). Without this, `php -S` would serve the raw
// {{CSP_NONCE}} placeholder with no CSP header, leaving the trust gate cosmetic.
if ($path === '/' || substr($path, -5) === '.html') {
    require_once __DIR__ . '/api/_html_server.php';
    if (lumen_serve_html(__DIR__, $path === '/' ? 'index.html' : ltrim($path, '/'))) {
        return true;
    }
}

return false;
