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

if (preg_match('#^/api/(admin_credential|stats|disabled-plugins|config)\.json$#i', $path)
    || preg_match('#^/api/(_admin_lib|config)\.php$#i', $path)) {
    http_response_code(403);
    header('Content-Type: text/plain');
    echo 'Forbidden';
    return true;
}

return false;
