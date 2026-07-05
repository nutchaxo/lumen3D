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
// plus the shared PHP include — mirrors api/.htaccess's `\.json$` catch-all so this
// php -S twin can't drift as new state files are added (e.g. plugin-trust.json). The
// real API routes are .php (auth/datasets/admin/plugins), unaffected.
if (preg_match('#^/api/[^/]+\.json$#i', $path)
    || preg_match('#^/api/(_admin_lib|config)\.php$#i', $path)) {
    http_response_code(403);
    header('Content-Type: text/plain');
    echo 'Forbidden';
    return true;
}

return false;
