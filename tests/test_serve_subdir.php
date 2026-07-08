<?php
/**
 * Subdirectory HTML serving (PHP hosts) — api/_html_server.php.
 *
 * Regression guard for the v1.12.5 bug where the platform only worked when
 * installed at the domain root: _serve.php fed lumen_serve_html the FULL request
 * path (incl. the /tools/webplatform/ prefix), so it looked for
 * "<subdir>/<subdir>/index.html" and every page 404'd ("Not found"). Covers the
 * pure resolver lumen_request_rel across docroot + subdir mounts, and a full
 * lumen_serve_html render (nonce injection, {{SITE}}) through a simulated subdir.
 *
 * Run:  php tests/test_serve_subdir.php   (exit 0 = all pass)
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

$APP = '/home/u/public_html/tools/webplatform';

echo "== lumen_request_rel — docroot mount ==\n";
ok('root /',            lumen_request_rel(['REQUEST_URI' => '/',            'SCRIPT_NAME' => '/_serve.php'], '/var/www'), 'index.html');
ok('root /index.html',  lumen_request_rel(['REQUEST_URI' => '/index.html',  'SCRIPT_NAME' => '/_serve.php'], '/var/www'), 'index.html');
ok('root /admpan.html', lumen_request_rel(['REQUEST_URI' => '/admpan.html', 'SCRIPT_NAME' => '/_serve.php'], '/var/www'), 'admpan.html');

echo "== lumen_request_rel — subdirectory mount (/tools/webplatform) ==\n";
ok('subdir /…/index.html',  lumen_request_rel(['REQUEST_URI' => '/tools/webplatform/index.html',  'SCRIPT_NAME' => '/tools/webplatform/_serve.php'], $APP), 'index.html');
ok('subdir /…/admpan.html', lumen_request_rel(['REQUEST_URI' => '/tools/webplatform/admpan.html', 'SCRIPT_NAME' => '/tools/webplatform/_serve.php'], $APP), 'admpan.html');
ok('subdir dir index /…/',  lumen_request_rel(['REQUEST_URI' => '/tools/webplatform/',            'SCRIPT_NAME' => '/tools/webplatform/_serve.php'], $APP), 'index.html');
ok('subdir page + query',   lumen_request_rel(['REQUEST_URI' => '/tools/webplatform/page.html?slug=x', 'SCRIPT_NAME' => '/tools/webplatform/_serve.php'], $APP), 'page.html');
// Some hosts report the ORIGINAL html as SCRIPT_NAME (not the rewritten _serve.php):
ok('subdir, SCRIPT_NAME=html', lumen_request_rel(['REQUEST_URI' => '/tools/webplatform/admpan.html', 'SCRIPT_NAME' => '/tools/webplatform/admpan.html'], $APP), 'admpan.html');

echo "== lumen_request_rel — DOCUMENT_ROOT fallback (SCRIPT_NAME unhelpful) ==\n";
ok('docroot-derived base', lumen_request_rel(
    ['REQUEST_URI' => '/tools/webplatform/admpan.html', 'SCRIPT_NAME' => '/_serve.php', 'DOCUMENT_ROOT' => '/home/u/public_html'],
    $APP), 'admpan.html');

echo "== traversal stays rejectable ==\n";
$rel = lumen_request_rel(['REQUEST_URI' => '/tools/webplatform/../secret.html', 'SCRIPT_NAME' => '/tools/webplatform/_serve.php'], $APP);
ok('rel keeps ..', strpos($rel, '..') !== false, true);

echo "== full lumen_serve_html render through a simulated subdir ==\n";
$tmp = sys_get_temp_dir() . '/lumen_subdir_' . bin2hex(random_bytes(4));
@mkdir($tmp, 0755, true);
file_put_contents($tmp . '/admpan.html',
    "<!doctype html><title>{{SITE:brand.name|Fallback Brand}}</title>" .
    "<script nonce=\"{{CSP_NONCE}}\">1</script><body>ADMIN OK</body>");
$server = ['REQUEST_URI' => '/tools/webplatform/admpan.html', 'SCRIPT_NAME' => '/tools/webplatform/_serve.php'];
$rel = lumen_request_rel($server, $tmp);
ok('resolves to admpan.html', $rel, 'admpan.html');
ob_start();
$served = lumen_serve_html($tmp, $rel);
$body = ob_get_clean();
ok('served true',            $served, true);
ok('body rendered',          strpos($body, 'ADMIN OK') !== false, true);
ok('nonce placeholder gone', strpos($body, '{{CSP_NONCE}}') === false, true);
ok('real nonce injected',    (bool)preg_match('/<script nonce="[A-Za-z0-9_-]{16,}">/', $body), true);
// {{SITE:…}} must be resolved (to the config value if config/instance.json exists,
// else the inline fallback) — either way the raw placeholder must not survive.
ok('{{SITE}} placeholder gone', strpos($body, '{{SITE:') === false, true);
@unlink($tmp . '/admpan.html');
@rmdir($tmp);

echo "\n" . ($fails === 0 ? "ALL PASS\n" : "$fails FAILURE(S)\n");
exit($fails === 0 ? 0 : 1);
