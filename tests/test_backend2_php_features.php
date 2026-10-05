<?php
/* PHP-side features the admin client relies on (the HTTP-level Python twin is
   tests/test_backend2_server_api.py; the shared rules are compared answer for answer
   by tests/test_backend2_twins_parity.php):
     * site.php save_draft writes the draft (and title) alone and refuses a stale
       revision; a merge save replaces only the listed paths;
     * gallery_add stores a raw image body (magic bytes decide) and the ceiling the
       `list` answer advertises never exceeds post_max_size;
     * the updater applies only the archive named after the tag, with a SHA256SUMS;
     * a publish interrupted between its renames is settled (old copy restored, or
       leftovers removed);
     * a plan that cannot fit on the disk is refused with the sizes, a file over the
       per-file ceiling is rejected as too_large.
     php tests/test_backend2_php_features.php                                       */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-b2php-' . bin2hex(random_bytes(4));
@mkdir($root, 0777, true);
define('LUMEN_PRIVATE_DIR', $root);
define('LUMEN_DATA_WEB', $root . '/DATA_WEB');
define('LUMEN_UPLOADS_DIR', $root . '/uploads');   // journals of the plan checks stay in the temp root
define('LUMEN_CONFIG_DIR', $root . '/config');
define('LUMEN_PAGE_DRAFTS_DIR', $root . '/drafts');
define('LUMEN_SITE_LIB', true);
define('LUMEN_DATASETS_LIB', true);
require_once __DIR__ . '/../api/datasets.php';
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

echo "site.php\n";
@mkdir(LUMEN_CONFIG_DIR . '/pages', 0777, true);
[$st] = site_save_checked('pages/news', ['title' => ['en' => 'News'], 'published' => ['sections' => [['id' => 'p1']]],
                                         'draft' => ['sections' => [['id' => 'd1']]]], null, null);
check('a full save works', $st === 200);
$rev = site_rev('pages/news');
// Another editor publishes something else.
site_save_checked('pages/news', ['title' => ['en' => 'News'], 'published' => ['sections' => [['id' => 'p9']]],
                                 'draft' => ['sections' => [['id' => 'x']]]], null, null);
[$st, $pl] = site_save_draft('pages/news', ['draft' => ['sections' => [['id' => 'd2']]]], $rev);
check('a stale revision is a 409 with the current one', $st === 409 && ($pl['error'] ?? '') === 'stale' && ($pl['rev'] ?? '') === site_rev('pages/news'));
check('and nothing is written', (site_load_admin('pages/news')['draft']['sections'][0]['id'] ?? '') === 'x');
[$st, $pl] = site_save_draft('pages/news', ['draft' => ['sections' => [['id' => 'd3']]], 'title' => ['en' => 'Renamed']], site_rev('pages/news'));
$doc = site_load_admin('pages/news');
check('save_draft writes the draft and the title', $st === 200 && $doc['draft']['sections'][0]['id'] === 'd3' && $doc['title'] === ['en' => 'Renamed']);
check('save_draft never touches published', $doc['published']['sections'][0]['id'] === 'p9');
check('the returned revision is the current one', ($pl['rev'] ?? null) === site_rev('pages/news'));
check('the public file carries no draft', strpos((string)file_get_contents(LUMEN_CONFIG_DIR . '/pages/news.json'), 'd3') === false);
check('save_draft refuses a non-page doc', site_save_draft('instance', ['draft' => []], null)[0] === 400);
check('save_draft refuses a draft that is not an object', site_save_draft('pages/news', ['draft' => [1, 2]], null)[0] === 400);

site_save_checked('instance', ['brand' => ['name' => 'Old', 'accent' => 'keep'], 'variables' => ['v' => 1]], null, null);
[$st] = site_save_checked('instance', ['brand' => ['name' => 'New'], 'variables' => ['v' => 9]], null, site_parse_merge('brand.name'));
$inst = site_load_doc('instance');
check('merge: the listed leaf is written, the rest kept', $st === 200 && $inst['brand'] === ['name' => 'New', 'accent' => 'keep'] && $inst['variables'] === ['v' => 1]);
check('merge: a bad path list is refused', site_parse_merge('../x') === null && site_parse_merge('') === null);
check('merge: not for pages', site_save_checked('pages/news', [], null, ['title'])[0] === 400);

echo "\ngallery (raw body)\n";
$ds = LUMEN_DATA_WEB . '/3d/G';
@mkdir($ds, 0777, true);
file_put_contents("$ds/metadata.json", '{"name":"G"}');
$png = "\x89PNG\r\n\x1a\n" . str_repeat("\0", 64);
[$st, $pl] = gallery_add('3d/G', $ds, ['raw' => $png, 'filename' => 'fig 1.png', 'caption' => 'hello']);
check('a raw PNG is stored under its magic-byte extension', $st === 200 && substr($pl['item']['file'], -4) === '.png'
    && is_file("$ds/gallery/" . $pl['item']['file']));
[$st] = gallery_add('3d/G', $ds, ['raw' => '<?php echo 1;', 'filename' => 'x.png']);
check('bytes that are not an image are refused', $st === 400);
check('the advertised ceiling never exceeds post_max_size',
    gallery_max_bytes() <= MAX_GALLERY_BYTES
    && (lumen_up_ini_bytes((string)ini_get('post_max_size')) === 0 || gallery_max_bytes() <= lumen_up_ini_bytes((string)ini_get('post_max_size'))));

echo "\nrelease assets\n";
$a = fn(string $n) => ['name' => $n, 'browser_download_url' => "https://x/$n", 'size' => 10];
$r = admin_release_assets(['assets' => [$a('lumen3d-web-2.0.0.zip'), $a('SHA256SUMS'), $a('SHA256SUMS.sig')]], '2.0.0');
check('the archive named after the tag is chosen', $r['error'] === null && $r['assetName'] === 'lumen3d-web-2.0.0.zip' && $r['sigUrl'] !== null);
$r = admin_release_assets(['assets' => [$a('lumen3d-web-1.9.9.zip'), $a('SHA256SUMS')]], '2.0.0');
check('another version\'s archive is refused', $r['error'] === 'asset_name_mismatch');
$r = admin_release_assets(['assets' => [$a('lumen3d-web-2.0.0.zip'), $a('LUMEN3D-WEB-2.0.0.ZIP'), $a('SHA256SUMS')]], '2.0.0');
check('two archives of that name make the release ambiguous', $r['error'] === 'ambiguous_asset');
$r = admin_release_assets(['assets' => [$a('lumen3d-web-2.0.0.zip')]], '2.0.0');
check('no SHA256SUMS: unverifiable', $r['error'] === 'no_checksums');
$r = admin_release_assets(['assets' => [], 'zipball_url' => 'https://api/zipball'], '2.0.0');
check('the source zipball is never a candidate', $r['error'] === 'no_release_asset');

echo "\ninterrupted publish\n";
$base = LUMEN_DATA_WEB . '/3d';
@mkdir("$base/.replaced-Lost-1700000000", 0777, true);
file_put_contents("$base/.replaced-Lost-1700000000/metadata.json", '{}');
@mkdir("$base/Kept", 0777, true);
@mkdir("$base/.replaced-Kept-1700000000", 0777, true);
@mkdir("$base/.incoming-Kept-1700000001", 0777, true);
$log = lumen_up_recover_publish_leftovers();
check('a dataset whose live copy is missing is restored', is_file("$base/Lost/metadata.json") && !is_dir("$base/.replaced-Lost-1700000000"));
check('a parked copy beside a live one is removed', is_dir("$base/Kept") && !is_dir("$base/.replaced-Kept-1700000000"));
check('a partial cross-volume copy is removed', !is_dir("$base/.incoming-Kept-1700000001"));
check('every action is logged', count($log) === 3);
check('a second pass has nothing to do', lumen_up_recover_publish_leftovers() === []);

echo "\nplan limits\n";
$budget = 1000;
$p = lumen_up_plan_one('3d', 'Big', [['path' => 'metadata.json', 'size' => 600], ['path' => 'bricks/manifest.json', 'size' => 600]],
                       LUMEN_UP_DEFAULT_CHUNK, $budget);
check('a drop larger than the free space is refused with the sizes',
    ($p['error'] ?? '') === 'insufficient_disk' && $p['neededBytes'] === 1200 && $p['freeBytes'] === 1000);
$p = lumen_up_plan_one('3d', 'Huge', [['path' => 'metadata.json', 'size' => LUMEN_UP_MAX_FILE_SIZE + 1]], LUMEN_UP_DEFAULT_CHUNK);
check('a file over the per-file ceiling is rejected as too_large', ($p['rejected'][0]['reason'] ?? '') === 'too_large');

echo $fails ? "\n$fails FAILED\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
