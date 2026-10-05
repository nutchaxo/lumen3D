<?php
/* install.php must REFUSE a release it cannot verify: no SHA256SUMS asset, a sums
   file that does not list the archive, or only the repository zipball (listed in no
   sums file). It used to install all three with a "no_checksum" warning. Also covers
   the root .htaccess merge (operator lines kept) and the DATA_WEB guard text.
     php tests/test_php_install_failclosed.php                                     */
declare(strict_types=1);

// The release key is pinned, so every accepted release must carry a valid signature
// of its SHA256SUMS. The test signs with a throwaway key of its own (libsodium); a
// PHP build that ships sodium as a shared extension not enabled by default is
// re-run once with it loaded.
if (!function_exists('sodium_crypto_sign_detached')) {
    if (getenv('LUMEN_TEST_SODIUM_RETRY') === '1') { echo "SKIP: libsodium unavailable in this PHP build
"; exit(0); }
    $ext = dirname(PHP_BINARY) . DIRECTORY_SEPARATOR . 'ext';
    putenv('LUMEN_TEST_SODIUM_RETRY=1');
    passthru(escapeshellarg(PHP_BINARY) . ' -d ' . escapeshellarg("extension_dir=$ext") . ' -d extension=sodium '
        . escapeshellarg(__FILE__), $code);
    exit($code);
}
$kp = sodium_crypto_sign_keypair();
define('LUMEN_INSTALL_TEST_PUBKEY', bin2hex(sodium_crypto_sign_publickey($kp)));
function sign_sums(string $body): string {
    global $kp;
    return bin2hex(sodium_crypto_sign_detached($body, sodium_crypto_sign_secretkey($kp))) . "
";
}

define('LUMEN_INSTALL_LIB', true);
require __DIR__ . '/../install.php';

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}

$zip  = 'lumen3d-web-9.9.9.zip';
$sha  = str_repeat('ab', 32);
$base = 'https://github.com/nutchaxo/lumen3D/releases/download/v9.9.9/';

/** A fake http_get_small: $routes maps URL → body (string) or null (404). */
function fake_get(array $routes): callable {
    return function (string $url, array $headers = []) use ($routes) {
        if (!array_key_exists($url, $routes) || $routes[$url] === null) {
            return ['ok' => false, 'status' => 404, 'headers' => [], 'body' => '', 'error' => 'http_404'];
        }
        return ['ok' => true, 'status' => 200, 'headers' => [], 'body' => $routes[$url], 'error' => null];
    };
}
function release(array $assets, bool $zipball = true): string {
    $rel = ['tag_name' => 'v9.9.9', 'published_at' => '2026-10-05T00:00:00Z', 'assets' => $assets];
    if ($zipball) $rel['zipball_url'] = 'https://api.github.com/repos/nutchaxo/lumen3D/zipball/v9.9.9';
    return (string)json_encode($rel);
}
$zipAsset  = ['name' => $zip, 'browser_download_url' => $base . $zip, 'size' => 1000];
$sumsAsset = ['name' => 'SHA256SUMS', 'browser_download_url' => $base . 'SHA256SUMS'];
$sigAsset  = ['name' => 'SHA256SUMS.sig', 'browser_download_url' => $base . 'SHA256SUMS.sig'];
$sums      = "$sha  $zip
";

echo "release verification
";
$r = fetch_release_info(fake_get([GITHUB_API_LATEST => release([$zipAsset, $sumsAsset, $sigAsset]),
                                  $base . 'SHA256SUMS' => $sums, $base . 'SHA256SUMS.sig' => sign_sums($sums)]));
check('a signed, listed archive is accepted with its digest', $r['ok'] && ($r['release']['sha256'] ?? null) === $sha
    && ($r['release']['sigVerified'] ?? false) === true);

$r = fetch_release_info(fake_get([GITHUB_API_LATEST => release([$zipAsset, $sumsAsset]),
                                  $base . 'SHA256SUMS' => $sums]));
check('no signature asset → refused (signature_missing)', !$r['ok'] && $r['error'] === 'signature_missing');

$r = fetch_release_info(fake_get([GITHUB_API_LATEST => release([$zipAsset, $sumsAsset, $sigAsset]),
                                  $base . 'SHA256SUMS' => $sums, $base . 'SHA256SUMS.sig' => sign_sums("$sha  other.zip
")]));
check('a signature over other bytes → refused (signature_invalid)', !$r['ok'] && $r['error'] === 'signature_invalid');

$r = fetch_release_info(fake_get([GITHUB_API_LATEST => release([$zipAsset])]));
check('no SHA256SUMS asset → refused', !$r['ok'] && in_array($r['error'], ['checksum_missing', 'signature_missing'], true));

$other = "$sha  something-else.zip
";
$r = fetch_release_info(fake_get([GITHUB_API_LATEST => release([$zipAsset, $sumsAsset, $sigAsset]),
                                  $base . 'SHA256SUMS' => $other, $base . 'SHA256SUMS.sig' => sign_sums($other)]));
check('archive missing from a signed SHA256SUMS → refused', !$r['ok'] && $r['error'] === 'checksum_missing');

$r = fetch_release_info(fake_get([GITHUB_API_LATEST => release([$zipAsset, $sumsAsset, $sigAsset]),
                                  $base . 'SHA256SUMS' => null]));
check('SHA256SUMS unreachable → refused', !$r['ok'] && in_array($r['error'], ['checksum_missing', 'signature_invalid'], true));

$stray = ['name' => 'lumen3d-web-9.9.8.zip', 'browser_download_url' => $base . 'lumen3d-web-9.9.8.zip', 'size' => 1000];
$sums2 = "$sha  lumen3d-web-9.9.8.zip
";
$r = fetch_release_info(fake_get([GITHUB_API_LATEST => release([$stray, $sumsAsset, $sigAsset]),
                                  $base . 'SHA256SUMS' => $sums2, $base . 'SHA256SUMS.sig' => sign_sums($sums2)]));
check('an archive not named after the tag is never installed', !$r['ok']);

$r = fetch_release_info(fake_get([GITHUB_API_LATEST => release([], true)]));
check('only the zipball (no named asset) → refused, never installed unverified', !$r['ok'] && $r['error'] === 'checksum_missing');

echo "\nroot .htaccess merge\n";
$shipped = "# header\n# BEGIN LUMEN3D\nRewriteEngine On\n# END LUMEN3D\n";
$host = "AddHandler application/x-httpd-php83 .php\n<IfModule mod_rewrite.c>\n    RewriteEngine On\n    RewriteRule ^old$ x [L]\n</IfModule>\nphp_value upload_max_filesize 64M\n";
$m = merge_htaccess($host, $shipped);
check('a host AddHandler is kept, above the block', strpos($m, 'AddHandler application/x-httpd-php83 .php') !== false
    && strpos($m, 'AddHandler') < strpos($m, '# BEGIN LUMEN3D'));
check('a host php_value is kept', strpos($m, 'php_value upload_max_filesize 64M') !== false);
check('lines inside a container (old shipped rules) are dropped', strpos($m, 'RewriteRule ^old$') === false);
$m2 = merge_htaccess("# mine\nRewriteBase /lab/\n" . $m . "\n# trailing operator note\n", "# BEGIN LUMEN3D\nNEW\n# END LUMEN3D\n");
check('with markers: everything outside them is kept verbatim', strpos($m2, "RewriteBase /lab/") !== false && strpos($m2, '# trailing operator note') !== false);
check('with markers: the block is replaced', strpos($m2, "NEW") !== false && strpos($m2, 'RewriteEngine On') === false);
check('merging twice is stable', merge_htaccess($m2, "# BEGIN LUMEN3D\nNEW\n# END LUMEN3D\n") === $m2);

echo "\nDATA_WEB guard\n";
$g = data_web_guard();
check('carries the guard marker', strpos($g, 'lumen-guard v2') !== false);
check('no unguarded Options directive', !preg_match('/^\s*Options\b/m', $g));
check('download/ files are attachments', strpos($g, 'Content-Disposition "attachment" env=LUMEN_DOWNLOAD') !== false);
check('nosniff', strpos($g, 'X-Content-Type-Options "nosniff"') !== false);
// The platform's own generator, run in a child (it shares constant names with install.php).
$lib = str_replace('\\', '/', (string)realpath(__DIR__ . '/../api/_admin_lib.php'));
$platform = shell_exec(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg("require '$lib'; echo lumen_data_web_guard();"));
check('byte-identical to the text the platform writes (lumen_data_web_guard)', $platform === $g);

echo "\ncode is never widened\n";
check('a .php file mode is never world-writable', (code_file_mode() & 0002) === 0);
check('a code directory is never world-writable', (code_dir_mode() & 0002) === 0);
check('.htaccess counts as code', is_code_file('/x/DATA_WEB/.htaccess') && is_code_file('/x/api/auth.php'));

echo $fails ? "\n$fails FAILED\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
