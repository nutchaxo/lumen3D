<?php
/* Only the platform's own top-level pages are served with the live CSP nonce. A
   .html anywhere below the install root (an unapproved plugin folder, a dataset's
   download/ folder, a file dropped by SFTP) used to get the nonce too — a trusted
   page of this origin. It is now refused (404), and never served raw by router.php.
     php tests/test_php_html_allowlist.php                                         */
declare(strict_types=1);
require_once __DIR__ . '/../api/_html_server.php';

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}

$root = sys_get_temp_dir() . '/lumen-html-' . bin2hex(random_bytes(4));
@mkdir("$root/js/modules/tools/evil", 0777, true);
@mkdir("$root/DATA_WEB/3d/demo/download", 0777, true);
$page = '<!doctype html><script nonce="{{CSP_NONCE}}"></script>';
file_put_contents("$root/admpan.html", $page);
file_put_contents("$root/js/modules/tools/evil/index.html", $page);
file_put_contents("$root/DATA_WEB/3d/demo/download/report.html", $page);

function served(string $root, string $rel): bool {
    ob_start();
    try { $ok = lumen_serve_html($root, $rel); } catch (Throwable $e) { $ok = 'threw'; }
    $body = ob_get_clean();
    if ($ok === true) return strpos((string)$body, '{{CSP_NONCE}}') === false;
    return $ok === 'threw' ? false : false;
}

check('a top-level page is served (nonce injected)', served($root, 'admpan.html'));
check('a plugin folder .html is refused', !served($root, 'js/modules/tools/evil/index.html'));
check('a dataset download/ .html is refused', !served($root, 'DATA_WEB/3d/demo/download/report.html'));
check('a NUL byte is refused without throwing', (function () use ($root) {
    ob_start();
    try { $r = lumen_serve_html($root, "admpan.html\0.html"); } catch (Throwable $e) { $r = null; }
    ob_end_clean();
    return $r === false;
})());
check('traversal is refused', !served($root, '../admpan.html'));
$router = (string)file_get_contents(__DIR__ . '/../router.php');
check('router.php answers 404 instead of a raw static serve for a refused .html',
    (bool)preg_match("/lumen_serve_html\\(.*?\\)\\)\\) \\{\\s*return true;\\s*\\}\\s*\\/\\/[^\\n]*\\n[^\\n]*\\n\\s*http_response_code\\(404\\)/s", $router));

foreach (["$root/admpan.html", "$root/js/modules/tools/evil/index.html", "$root/DATA_WEB/3d/demo/download/report.html"] as $f) @unlink($f);
foreach (["$root/js/modules/tools/evil", "$root/js/modules/tools", "$root/js/modules", "$root/js",
          "$root/DATA_WEB/3d/demo/download", "$root/DATA_WEB/3d/demo", "$root/DATA_WEB/3d", "$root/DATA_WEB", $root] as $d) @rmdir($d);

echo $fails ? "\n$fails FAILED\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
