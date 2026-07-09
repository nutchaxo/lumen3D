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
 * Parsed config/instance.json (white-label). Cached per request. Tolerant: a
 * missing/malformed file yields [] (placeholders then use their inline fallbacks).
 * Twin of dev_server.py:_load_instance.
 */
function lumen_instance_config(): array {
    static $cache = null;
    if ($cache !== null) return $cache;
    $f = dirname(__DIR__) . '/config/instance.json';
    $d = is_file($f) ? json_decode((string)@file_get_contents($f), true) : null;
    $cache = is_array($d) ? $d : [];
    return $cache;
}

/** Resolve a dotted path against the instance config → string or null. */
function lumen_site_lookup(array $cfg, string $path) {
    $v = $cfg;
    foreach (explode('.', $path) as $seg) {
        if (is_array($v) && array_key_exists($seg, $v)) $v = $v[$seg];
        else return null;
    }
    return is_string($v) ? $v : null;
}

/**
 * Replace {{SITE:dotted.path|fallback}} with the instance-config value (HTML-escaped)
 * or the inline fallback. Twin of dev_server.py:_apply_site_placeholders — keep in step.
 */
function lumen_apply_site(string $html): string {
    if (strpos($html, '{{SITE:') === false) return $html;
    $cfg = lumen_instance_config();
    return preg_replace_callback('/\{\{SITE:([^}|]+)(?:\|([^}]*))?\}\}/', function ($m) use ($cfg) {
        $val = lumen_site_lookup($cfg, trim($m[1]));
        if ($val === null || $val === '') $val = $m[2] ?? '';
        return htmlspecialchars($val, ENT_QUOTES, 'UTF-8');
    }, $html);
}

/**
 * Resolve the requested .html file (relative to the install dir) from the server
 * vars, tolerating installation in a SUBDIRECTORY (e.g. /tools/webplatform/).
 *
 * Apache rewrites every *.html to _serve.php but REQUEST_URI keeps the full path
 * INCLUDING the subdirectory prefix. That prefix must be stripped before resolving
 * against the install dir — otherwise "<subdir>/<subdir>/index.html" is looked up
 * and every page 404s ("works only at the domain root" bug). The mount base is
 * dirname(SCRIPT_NAME) (the dir the executed script lives in, relative to the web
 * root); a DOCUMENT_ROOT-vs-appDir fallback covers hosts that misreport it. Pure
 * (no globals/output) so it is unit-testable. Twin intent: dev_server serves from
 * its own root, so it has no prefix to strip.
 */
function lumen_request_rel(array $server, string $appDir): string {
    $reqPath = parse_url((string)($server['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    if ($reqPath === null || $reqPath === false || $reqPath === '') $reqPath = '/';

    $base = str_replace('\\', '/', dirname((string)($server['SCRIPT_NAME'] ?? '')));
    if ($base === '.') $base = '/';
    if (($base === '' || $base === '/') && !empty($server['DOCUMENT_ROOT'])) {
        $docRoot = rtrim(str_replace('\\', '/', (string)$server['DOCUMENT_ROOT']), '/');
        $app     = rtrim(str_replace('\\', '/', $appDir), '/');
        if ($docRoot !== '' && strncmp($app, $docRoot, strlen($docRoot)) === 0) {
            $base = substr($app, strlen($docRoot));            // e.g. "/tools/webplatform"
        }
    }
    $base = rtrim($base, '/');

    if ($base !== '' && $base !== '/') {
        if (strncmp($reqPath, $base . '/', strlen($base) + 1) === 0) {
            $reqPath = substr($reqPath, strlen($base));
        } elseif ($reqPath === $base) {
            $reqPath = '/';
        }
    }
    if ($reqPath === '' || $reqPath === '/') return 'index.html';
    return ltrim(urldecode($reqPath), '/');
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
    // White-label head/brand injection ({{SITE:…}}), then the per-request nonce.
    $body = lumen_apply_site($html);
    // Cache-bust config/theme.css by its mtime so an operator theme change appears
    // immediately even though CSS is long-cached (.htaccess). The URL only changes
    // when theme.css is regenerated (theme editor / wizard) → cache stays effective.
    $themeCss = dirname(__DIR__) . '/config/theme.css';
    $tv = is_file($themeCss) ? (int)@filemtime($themeCss) : 0;
    $body = str_replace('href="config/theme.css"', 'href="config/theme.css?v=' . $tv . '"', $body);
    $body = str_replace('{{CSP_NONCE}}', $nonce, $body);

    header('Content-Type: text/html; charset=utf-8');
    header('Content-Security-Policy: ' . lumen_csp_policy($nonce));
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header('Cache-Control: no-store');  // per-request nonce → never cache
    echo $body;
    return true;
}
