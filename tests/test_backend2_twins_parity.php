<?php
/* The two backends must answer alike: the PHP twin (the production host is a shared
   PHP host) and the Python server (development, self-hosted). Each rule below is run
   by api/*.php AND by dev_server.py / upload_staging.py over the same vectors and
   compared answer for answer:
     * the .htaccess guards written into DATA_WEB/, uploads/, config/uploads/ (same
       bytes, so the backends stop rewriting each other's file) and the copies
       shipped in the repository (DATA_WEB/.htaccess, js/.htaccess);
     * one byte range (200 / 206 / 416);
     * the brick-manifest rule a publish enforces (brick size 64, levels in order…);
     * the site-doc revision and the field merge of api/site.php;
     * the client address behind declared proxies (right-to-left X-Forwarded-For);
     * the login throttle (10 per address then locked, 200 per window overall);
     * the file types a marketplace plugin package may carry into js/modules/.
   The Python half is skipped (not failed) when no interpreter can import the server.
     php tests/test_backend2_twins_parity.php                                        */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-twins-' . bin2hex(random_bytes(4));
@mkdir($root, 0777, true);
define('LUMEN_PRIVATE_DIR', $root);
define('LUMEN_DATA_WEB', $root . '/DATA_WEB');
define('LUMEN_UPLOADS_DIR', $root . '/uploads');
define('LUMEN_CONFIG_DIR', $root . '/config');
define('LUMEN_PAGE_DRAFTS_DIR', $root . '/drafts');
define('LUMEN_SITE_LIB', true);
putenv('LUMEN_TRUSTED_PROXIES=10.0.0.1 192.168.0.0/16');
require_once __DIR__ . '/../api/_upload_lib.php';
require_once __DIR__ . '/../api/site.php';

function rrm(string $d): void {
    if (!is_dir($d)) { @unlink($d); return; }
    foreach (scandir($d) ?: [] as $f) { if ($f !== '.' && $f !== '..') rrm("$d/$f"); }
    @rmdir($d);
}
register_shutdown_function(function () use ($root) { rrm($root); });

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}
$repo = realpath(__DIR__ . '/..');
$norm = fn(string $s) => str_replace("\r\n", "\n", $s);

// ── Vectors ─────────────────────────────────────────────────────────────────
$ranges = [['bytes=10-19', 100], ['bytes=90-', 100], ['bytes=-30', 100], ['bytes=-500', 100],
           ['bytes=50-1000', 100], ['bytes=200-300', 100], ['bytes=100-', 100], ['bytes=-0', 100],
           ['bytes=0-0', 0], ['bytes=abc', 100], ['items=1-2', 100], ['bytes=0-1,5-6', 100],
           ['bytes=9-3', 100], [' bytes = 5 - 9 ', 100], ['', 100]];
$level = fn(int $i, array $extra = []) => array_merge(['level' => $i, 'dimensions' => ['x' => 64, 'y' => 64, 'z' => 32]], $extra);
$good = ['brickSize' => 64, 'channels' => 2, 'levels' => [$level(0), $level(1)],
         'brickPacking' => ['mode' => 'grid', 'cols' => 8, 'rows' => 8],
         'brickTransport' => ['encoding' => 'webp-lossless']];
$manifests = [
    $good,
    array_merge($good, ['brickSize' => 128]),
    array_merge($good, ['levels' => [$level(1), $level(0)]]),
    array_merge($good, ['levels' => [$level(0, ['brickSize' => 32])]]),
    array_merge($good, ['channels' => 0]),
    array_merge($good, ['brickPacking' => ['mode' => 'diagonal']]),
    array_merge($good, ['brickPacking' => ['mode' => 'grid', 'cols' => 0]]),
    array_merge($good, ['brickPacking' => ['mode' => 'vertical']]),
    array_merge($good, ['brickTransport' => ['encoding' => 'jpeg']]),
    ['levels' => []],
    ['levels' => [['level' => 0]]],
    ['levels' => [$level(0, ['dimensions' => ['x' => 64, 'y' => 0, 'z' => 64]])]],
];
$merges = [
    [['brand' => ['name' => 'A', 'accent' => 'keep'], 'nav' => ['showAbout' => true, 'customPages' => [1]]],
     ['brand' => ['name' => 'B'], 'nav' => ['showAbout' => false]], ['brand.name', 'nav.showAbout']],
    [['variables' => ['v' => 1], 'editor' => ['x' => 1], 'brand' => ['name' => 'A']],
     ['variables' => ['v' => 2]], ['variables', 'editor']],
    [['a' => 1], ['b' => ['c' => ['d' => 5]]], ['b.c.d', 'z.y']],
    [['a' => ['b' => 'scalar']], ['a' => ['b' => ['c' => 1]]], ['a.b.c']],
];
$ips = [
    ['203.0.113.5', '198.51.100.7', ''],                       // untrusted peer: header ignored
    ['10.0.0.1', '198.51.100.7', ''],                          // trusted proxy
    ['10.0.0.1', '6.6.6.6, 198.51.100.7', ''],                 // spoofed left-most hop
    ['10.0.0.1', '198.51.100.7, 192.168.4.4', ''],             // two declared proxies
    ['10.0.0.1', '192.168.4.4', '198.51.100.9'],               // all hops trusted → X-Real-IP
    ['10.0.0.1', 'garbage, 192.168.4.4', ''],                  // malformed hop ends the walk
    ['10.0.0.1', '', ''],                                      // nothing forwarded
    ['10.0.0.1', '2001:db8::1', 'not-an-ip'],
];

$entries = ['tools/x/index.js', 'tools/x/plugin.json', 'tools/x/LICENSE', 'tools/x/lang/en.json', 'x/icon.SVG',
            'x/shell.php', 'x/.htaccess', 'x/run.py', 'x/a.phtml', 'x/.hidden.js', 'x/data.bin', 'x/shader.glsl'];

// Site docs: a page with a draft, an instance doc, a page with no files at all.
@mkdir(LUMEN_CONFIG_DIR . '/pages', 0777, true);
@mkdir(LUMEN_PAGE_DRAFTS_DIR, 0777, true);
file_put_contents(LUMEN_CONFIG_DIR . '/instance.json', "{\n  \"brand\": {\"name\": \"Lab\"}\n}");
file_put_contents(LUMEN_CONFIG_DIR . '/pages/news.json', '{"title":{"en":"News"},"published":{"sections":[]}}');
file_put_contents(LUMEN_PAGE_DRAFTS_DIR . '/news.json', '{"sections":[{"id":"s1"}]}');
$docs = ['instance', 'pages/news', 'pages/empty', 'theme'];

// ── PHP answers ──────────────────────────────────────────────────────────────
$php = ['guards' => [lumen_data_web_guard(), lumen_staging_guard(), lumen_media_guard()]];
$php['ranges'] = array_map(fn($r) => lumen_up_parse_range($r[0], $r[1]), $ranges);
$php['manifests'] = array_map(fn($m) => lumen_up_validate_manifest($m), $manifests);
$php['revs'] = array_map(fn($d) => site_rev($d), $docs);
$php['entries'] = array_map(fn($n) => mkt_plugin_entry_allowed($n), $entries);
$php['merges'] = array_map(fn($m) => site_merge_paths($m[0], $m[1], $m[2]), $merges);
$php['ips'] = array_map(function ($v) {
    $_SERVER['REMOTE_ADDR'] = $v[0];
    $_SERVER['HTTP_X_FORWARDED_FOR'] = $v[1];
    $_SERVER['HTTP_X_REAL_IP'] = $v[2];
    return admin_client_ip();
}, $ips);
// Throttle: 11 attempts from one address, then 200 more spread over other addresses.
unset($_SERVER['HTTP_X_FORWARDED_FOR'], $_SERVER['HTTP_X_REAL_IP']);
$seq = [];
$_SERVER['REMOTE_ADDR'] = '203.0.113.1';
for ($i = 0; $i < 11; $i++) { [$ok, , $why] = admin_bf_reserve(); $seq[] = $ok ? 'ok' : $why; }
for ($i = 0; $i < 200; $i++) {
    $_SERVER['REMOTE_ADDR'] = '198.18.' . intdiv($i, 250) . '.' . ($i % 250 + 1);
    [$ok, , $why] = admin_bf_reserve(); $seq[] = $ok ? 'ok' : $why;
}
$php['throttle'] = $seq;

echo "PHP rules\n";
check('the repository copy of DATA_WEB/.htaccess is the text both backends write',
    $norm((string)file_get_contents("$repo/DATA_WEB/.htaccess")) === $php['guards'][0]);
$js = $norm((string)file_get_contents("$repo/js/.htaccess"));
check('js/.htaccess carries the execution ban', strpos($js, lumen_exec_ban_rules()) !== false && strpos($js, LUMEN_GUARD_MARKER) !== false);
check('no unguarded Options in any guard', !preg_match('/^\s*Options\b/m', implode("\n", $php['guards']) . $js));
check('a range past the end is 416, a suffix range the last bytes',
    $php['ranges'][5] === false && $php['ranges'][2] === [70, 99] && $php['ranges'][9] === null);
check('manifest: brick size 64 and levels in order are enforced',
    $php['manifests'][0] === [true, null] && $php['manifests'][1][1] === 'manifest_bad_brick_size'
    && $php['manifests'][2][1] === 'manifest_level_0_out_of_order' && $php['manifests'][3][1] === 'manifest_level_0_bad_brick_size');
check('merge replaces the listed leaves only', $php['merges'][0]['brand'] === ['name' => 'B', 'accent' => 'keep']
    && $php['merges'][0]['nav']['customPages'] === [1] && $php['merges'][0]['nav']['showAbout'] === false);
check('merge removes a listed path the body lacks', !isset($php['merges'][1]['editor']) && $php['merges'][1]['brand'] === ['name' => 'A']);
check('plugin packages: scripts and dotfiles never land in js/modules',
    $php['entries'] === [true, true, true, true, true, false, false, false, false, false, false, true]);
check('client address: right-most untrusted hop', $php['ips'][2] === '198.51.100.7' && $php['ips'][3] === '198.51.100.7'
    && $php['ips'][0] === '203.0.113.5' && $php['ips'][4] === '198.51.100.9');
check('throttle: ten attempts, then locked', array_slice($seq, 0, 11) === array_merge(array_fill(0, 10, 'ok'), ['locked']));
check('throttle: the 201st attempt of a window is refused whatever the address',
    count(array_filter($seq, fn($s) => $s === 'ok')) === 200 && end($seq) === 'global');

// ── Python answers ───────────────────────────────────────────────────────────
$vecFile = "$root/vectors.json";
file_put_contents($vecFile, json_encode(['ranges' => $ranges, 'manifests' => $manifests, 'merges' => $merges,
    'ips' => $ips, 'docs' => $docs, 'entries' => $entries, 'config' => LUMEN_CONFIG_DIR, 'drafts' => LUMEN_PAGE_DRAFTS_DIR]));
$code = <<<'PY'
import sys, json, os
sys.path.insert(0, sys.argv[1])
os.environ["LUMEN_TRUSTED_PROXIES"] = ""
import dev_server as d, upload_staging as u
from pathlib import Path
v = json.load(open(sys.argv[2], encoding="utf-8"))
out = {"guards": [u.DATA_WEB_GUARD, u.STAGING_GUARD, u.MEDIA_GUARD]}
def rng(h, n):
    r = d._parse_byte_range(h, n)
    return False if r is d._RANGE_UNSATISFIABLE else (list(r) if r else None)
out["ranges"] = [rng(h, n) for h, n in v["ranges"]]
out["manifests"] = [list(u._validate_manifest(m)) for m in v["manifests"]]
d.CONFIG_DIR = Path(v["config"]); d.CONFIG_DEFAULTS_DIR = d.CONFIG_DIR / "defaults" / "neutral"
d.PAGE_DRAFTS_DIR = Path(v["drafts"])
out["revs"] = [d._site_rev(x) for x in v["docs"]]
out["merges"] = [d._merge_paths(c, i, p) for c, i, p in v["merges"]]
out["entries"] = [d._plugin_entry_allowed(n) for n in v["entries"]]
d.TRUSTED_PROXIES.clear(); d.TRUSTED_PROXIES.update(d._parse_proxy_list("10.0.0.1 192.168.0.0/16"))
class H:
    def __init__(self, peer, xff, xri):
        self.client_address = (peer, 0)
        self.headers = {k: val for k, val in (("X-Forwarded-For", xff), ("X-Real-IP", xri)) if val}
out["ips"] = [d._client_ip(H(*x)) for x in v["ips"]]
d._BRUTE.clear(); d._BRUTE_GLOBAL.update(start=0.0, count=0)
seq = []
for _ in range(11):
    ok, _r, why = d._bf_reserve("203.0.113.1"); seq.append("ok" if ok else why)
for i in range(200):
    ok, _r, why = d._bf_reserve(f"198.18.{i // 250}.{i % 250 + 1}"); seq.append("ok" if ok else why)
out["throttle"] = seq
sys.stdout.write(json.dumps(out))
PY;
// Run from a file: on Windows escapeshellarg() blanks every double quote of a -c
// program.
$script = "$root/parity.py";
file_put_contents($script, $code);
$py = null;
foreach (['python', 'python3', 'py'] as $exe) {
    $cmd = escapeshellarg($exe) . ' ' . escapeshellarg($script) . ' ' . escapeshellarg($repo) . ' '
         . escapeshellarg($vecFile) . ' 2>' . (DIRECTORY_SEPARATOR === '\\' ? 'NUL' : '/dev/null');
    $out = shell_exec($cmd);
    if (is_string($out) && $out !== '' && is_array(json_decode($out, true))) { $py = json_decode($out, true); break; }
}

echo "\nPHP ↔ Python parity\n";
if ($py === null) {
    echo "  SKIP no Python interpreter could import dev_server.py\n";
} else {
    $same = function (string $what) use ($php, $py) {
        $a = json_decode(json_encode($php[$what]), true);
        $b = $py[$what];
        if ($a == $b) return true;
        echo "    php: " . json_encode($a) . "\n    py:  " . json_encode($b) . "\n";
        return false;
    };
    check('the three directory guards are byte-identical', $php['guards'] === $py['guards']);
    check('byte ranges: same answer for every header', $same('ranges'));
    check('brick manifests: same verdict and same reason', $same('manifests'));
    check('site docs: same revision for the same files', $same('revs'));
    check('field merge: same document', $same('merges'));
    check('client address behind proxies: same key', $same('ips'));
    check('plugin package entries: same verdict', $same('entries'));
    check('login throttle: same sequence of answers', $same('throttle'));
}

echo $fails ? "\n$fails FAILED\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
