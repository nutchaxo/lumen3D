<?php
/**
 * Apache HTML entry point (rewrite target). The root .htaccess rewrites every
 * *.html document (and the directory index) here so a PHP/Apache host emits the
 * enforcing nonce-CSP (per-request nonce injected into {{CSP_NONCE}}), matching
 * dev_server.py. Non-HTML assets and api/*.php are NOT rewritten here.
 */

declare(strict_types=1);
if (is_file(__DIR__ . '/api/_bootstrap.php')) require_once __DIR__ . '/api/_bootstrap.php';
require_once __DIR__ . '/api/_html_server.php';

// Subdirectory-aware (strips the install-dir prefix from REQUEST_URI) so the
// platform works whether it lives at the domain root or under e.g. /tools/webplatform/.
$rel = lumen_request_rel($_SERVER, __DIR__);
$accept = (string)($_SERVER['HTTP_ACCEPT'] ?? '');
$base = lumen_mount_base($_SERVER, __DIR__) . '/';

// The root .htaccess sends the implicit /favicon.ico probe here when no such file
// exists (pages declare assets/favicon.svg): "no icon" rather than a 404 in the logs.
if (isset($_GET['lumen_favicon'])) {
    http_response_code(204);
    header('Cache-Control: public, max-age=86400');
    return;
}

// ...and any extension-less path that is neither a file nor a directory, so a page
// that does not exist answers with the branded 404.html (status 404). The rewrite
// keeps the API and DATA_WEB out of it; lumen_serve_not_found checks it again.
if (isset($_GET['lumen_404'])) {
    if (!lumen_serve_not_found(__DIR__, $rel, $accept, $base)) {
        http_response_code(404);
        header('Content-Type: text/plain');
        echo 'Not found';
    }
    return;
}

if (!lumen_serve_html(__DIR__, $rel, $base)) {
    if (!lumen_serve_not_found(__DIR__, $rel, $accept, $base)) {
        http_response_code(404);
        header('Content-Type: text/plain');
        echo 'Not found';
    }
}
