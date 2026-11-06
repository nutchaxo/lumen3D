<?php
/**
 * Branded 404 and favicon on PHP hosts: the pure decision (lumen_wants_not_found_page),
 * the install-root base (lumen_mount_base) and the rendered page (status, base, nonce)
 * through lumen_serve_not_found, for a domain-root mount and a subdirectory mount.
 *
 * Run:  php tests/test_404_router.php   (exit 0 = all pass)
 */
declare(strict_types=1);
require_once __DIR__ . '/../api/_html_server.php';

$fails = 0;
function ok(string $label, $got, $want) {
    global $fails;
    $pass = ($got === $want);
    if (!$pass) $fails++;
    printf("  [%s] %s%s\n", $pass ? 'PASS' : 'FAIL', $label,
        $pass ? '' : "  (got " . var_export($got, true) . ", want " . var_export($want, true) . ")");
}

$HTML = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';

echo "== lumen_wants_not_found_page ==\n";
foreach (['nope', 'nope.html', 'a/b/c', 'a/b/c.htm', 'js/nope'] as $p) ok("page: $p", lumen_wants_not_found_page($p, $HTML), true);
ok('no Accept header', lumen_wants_not_found_page('nope', ''), true);
foreach (['api/x', 'API/x.php', 'DATA_WEB/3d/none', 'data_web/3d/none/metadata.json', 'js/x.js', 'css/x.css', 'assets/x.png', 'lang/xx.json'] as $p)
    ok("plain: $p", lumen_wants_not_found_page($p, $HTML), false);
ok('JSON client', lumen_wants_not_found_page('nope', 'application/json'), false);
ok('*/* client', lumen_wants_not_found_page('nope', '*/*'), false);

echo "== lumen_mount_base ==\n";
ok('domain root', lumen_mount_base(['SCRIPT_NAME' => '/_serve.php'], '/var/www'), '');
ok('subdirectory', lumen_mount_base(['SCRIPT_NAME' => '/tools/webplatform/_serve.php'], '/home/u/public_html/tools/webplatform'), '/tools/webplatform');

echo "== lumen_serve_not_found ==
";
$root = sys_get_temp_dir() . '/lumen-404-' . bin2hex(random_bytes(4));
mkdir($root, 0777, true);
copy(__DIR__ . '/../404.html', $root . '/404.html');

function render(string $root, string $rel, string $accept, string $base): array {
    ob_start();
    $served = lumen_serve_not_found($root, $rel, $accept, $base);
    $body = (string)ob_get_clean();
    return [$served, $body];
}
[$served, $body] = render($root, 'a/b/c', $HTML, '/');
ok('served', $served, true);
ok('base at the root', strpos($body, '<base href="/">') !== false, true);
ok('placeholders resolved', strpos($body, '{{') === false, true);
ok('page markup', strpos($body, 'data-i18n="app.notFoundTitle"') !== false, true);
[$served, $body] = render($root, 'a/b/c', $HTML, '/tools/webplatform/');
ok('base in a subdirectory', strpos($body, '<base href="/tools/webplatform/">') !== false, true);
[$served, $body] = render($root, 'api/x', $HTML, '/');
ok('API path: not served', [$served, $body], [false, '']);
[$served, $body] = render($root, 'x.js', $HTML, '/');
ok('script path: not served', [$served, $body], [false, '']);
unlink($root . '/404.html');
[$served, $body] = render($root, 'nope', $HTML, '/');
ok('page missing: plain fallback left to the caller', [$served, $body], [false, '']);
@rmdir($root);

echo $fails ? "\n$fails FAILED\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
