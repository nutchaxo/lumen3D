<?php
/**
 * Apache HTML entry point (rewrite target). The root .htaccess rewrites every
 * *.html document (and the directory index) here so a PHP/Apache host emits the
 * enforcing nonce-CSP (per-request nonce injected into {{CSP_NONCE}}), matching
 * dev_server.py. Non-HTML assets and api/*.php are NOT rewritten here.
 */

declare(strict_types=1);
require_once __DIR__ . '/api/_html_server.php';

// Subdirectory-aware (strips the install-dir prefix from REQUEST_URI) so the
// platform works whether it lives at the domain root or under e.g. /tools/webplatform/.
$rel = lumen_request_rel($_SERVER, __DIR__);

if (!lumen_serve_html(__DIR__, $rel)) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo 'Not found';
}
