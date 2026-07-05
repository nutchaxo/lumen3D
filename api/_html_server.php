<?php
/**
 * Shared HTML server with per-request CSP nonce injection (PHP hosts).
 * ===================================================================
 * Twin of dev_server.py:_serve_html / _csp_policy. Lets a PHP host (php -S via
 * router.php, or Apache via _serve.php + a rewrite) emit the SAME enforcing
 * nonce-CSP as the Python dev server, closing the "PHP hosts have no CSP" gap.
 * Pure-static hosts (no PHP/Python) still cannot inject a per-request nonce and
 * therefore cannot enforce this CSP — an inherent limit of static hosting.
 *
 * This file only DEFINES functions (no output on include); it is also denied
 * from direct HTTP by api/.htaccess and router.php.
 */

declare(strict_types=1);

/** The canonical enforcing policy — MUST match dev_server.py:_csp_policy. */
function lumen_csp_policy(string $nonce): string {
    return "default-src 'self'; "
        . "script-src 'self' 'nonce-$nonce'; "
        // L8: element context nonce-locked (blocks injected <style>); attribute
        // context keeps 'unsafe-inline' for data-driven style="". style-src is the
        // CSP2 fallback. Mirror of dev_server.py:_csp_policy.
        . "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        . "style-src-elem 'self' 'nonce-$nonce' https://fonts.googleapis.com; "
        . "style-src-attr 'unsafe-inline'; "
        . "font-src 'self' https://fonts.gstatic.com; "
        . "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; "
        . "frame-src 'self'; child-src 'self'; object-src 'none'; base-uri 'self'; "
        . "form-action 'self'; frame-ancestors 'self'";
}

/** URL-safe per-request nonce (mirrors secrets.token_urlsafe(18)). */
function lumen_csp_nonce(): string {
    return rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');
}

/**
 * Serve $root/$rel (an .html file) with the injected nonce + enforcing CSP header.
 * Returns true if it served the response, false if the path is not a servable
 * .html under $root (caller then falls through / 404s). Path-contained.
 */
function lumen_serve_html(string $root, string $rel): bool {
    $rootReal = realpath($root);
    if ($rootReal === false) return false;
    $rel = ltrim(str_replace('\\', '/', $rel), '/');
    if ($rel === '') $rel = 'index.html';
    // Reject traversal up front, then realpath+prefix as the authoritative check.
    if (strpos($rel, '..') !== false || substr($rel, -5) !== '.html') return false;
    $full = realpath($rootReal . DIRECTORY_SEPARATOR . $rel);
    if ($full === false || strncmp($full, $rootReal, strlen($rootReal)) !== 0 || !is_file($full)) return false;

    $html = file_get_contents($full);
    if ($html === false) return false;
    $nonce = lumen_csp_nonce();
    $body = str_replace('{{CSP_NONCE}}', $nonce, $html);

    header('Content-Type: text/html; charset=utf-8');
    header('Content-Security-Policy: ' . lumen_csp_policy($nonce));
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header('Cache-Control: no-store');  // per-request nonce → never cache
    echo $body;
    return true;
}
