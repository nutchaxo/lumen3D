<?php
/* PHP twin of tests/test_dataset_gallery.py — asserts api/datasets.php agrees with
   dev_server.py on the per-dataset image gallery: what lands on disk, what the
   `file` field may look like (it becomes a URL in the viewer), and how a Save
   reconciles metadata.json against the gallery/ folder.

   The two backends must produce the SAME folder for the same input: an operator who
   moves a deployment from the Python dev server to a PHP host — or the other way —
   must find the same images with the same names and captions.

   datasets.php is loaded in library mode (LUMEN_DATASETS_LIB), so it defines its
   helpers without emitting headers, starting a session, or running the router.
     php tests/test_dataset_gallery.php                                          */
declare(strict_types=1);

define('LUMEN_DATASETS_LIB', true);
require_once __DIR__ . '/../api/datasets.php';

$root = sys_get_temp_dir() . '/lumen-gallery-' . bin2hex(random_bytes(4));
$ds   = $root . '/DATA_WEB/fixed/demo';
@mkdir($ds, 0777, true);

function rrm(string $d): void {
    if (!is_dir($d)) return;
    foreach (scandir($d) ?: [] as $f) {
        if ($f === '.' || $f === '..') continue;
        $p = "$d/$f";
        is_dir($p) ? rrm($p) : @unlink($p);
    }
    @rmdir($d);
}
register_shutdown_function(function () use ($root) { rrm($root); });

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}
function section(string $s): void { echo "\n$s\n"; }

$PNG  = hex2bin('89504e470d0a1a0a') . str_repeat("\x00", 40);
$JPEG = "\xff\xd8\xff" . str_repeat("\x00", 40);
$GIF  = 'GIF89a' . str_repeat("\x00", 40);
$WEBP = 'RIFF' . "\x00\x00\x00\x00" . 'WEBP' . str_repeat("\x00", 40);
$durl = fn(string $b) => 'data:image/png;base64,' . base64_encode($b);

$writeMeta = function (array $doc) use ($ds) {
    file_put_contents($ds . '/metadata.json', json_encode($doc));
};
$meta  = fn() => json_decode(file_get_contents($ds . '/metadata.json'), true);
$files = function () use ($ds) {
    $g = $ds . '/gallery';
    if (!is_dir($g)) return [];
    $f = array_values(array_diff(scandir($g), ['.', '..']));
    sort($f);
    return $f;
};
$reset = function () use ($ds, $writeMeta) {
    rrm($ds . '/gallery');
    $writeMeta(['name' => 'Demo', 'type' => 'fixed']);
};

// ── Upload ───────────────────────────────────────────────────────────────────
section('Upload');
$reset();
[$st, $pl] = gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => 'shot.png', 'caption' => 'Vue sagittale']);
check('writes the file', $st === 200 && $files() === ['shot.png']);
check('records the entry', ($meta()['gallery'][0]['file'] ?? '') === 'shot.png');
check('keeps the caption', ($meta()['gallery'][0]['caption'] ?? '') === 'Vue sagittale');
check('returns a public url', ($pl['url'] ?? '') === 'DATA_WEB/fixed/demo/gallery/shot.png');

$reset();
$okAll = true;
foreach ([[$PNG, 'png'], [$JPEG, 'jpg'], [$GIF, 'gif'], [$WEBP, 'webp']] as [$raw, $ext]) {
    [$s, ] = gallery_add('fixed/demo', $ds, ['image' => $durl($raw), 'filename' => "f-$ext.bin"]);
    if ($s !== 200) $okAll = false;
}
check('accepts png/jpeg/gif/webp', $okAll && count($files()) === 4);

$reset();
[$st, $pl] = gallery_add('fixed/demo', $ds, ['image' => $durl($JPEG), 'filename' => 'liar.png']);
check('magic bytes decide the extension, not the name', ($pl['item']['file'] ?? '') === 'liar.jpg');

$reset();
[$st, ] = gallery_add('fixed/demo', $ds, ['image' => $durl('<?php system($_GET["c"]); ?>'), 'filename' => 'evil.png']);
check('non-image refused before any write', $st === 400 && $files() === [] && !isset($meta()['gallery']));

$reset();
[$st, ] = gallery_add('fixed/demo', $ds, ['image' => $durl($PNG . str_repeat("\x00", MAX_GALLERY_BYTES))]);
check('oversized payload refused', $st === 400 && $files() === []);

$reset();
[$st, ] = gallery_add('fixed/demo', $ds, ['image' => 'https://evil.example/x.png']);
check('non-data URL refused', $st === 400);

$reset();
gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => 'Coupe Annotée !.png']);
gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => 'Coupe Annotée !.png']);
check('name slugged and de-duplicated (same slug as Python)',
      $files() === ['coupe-annot-e-1.png', 'coupe-annot-e.png']);

$reset();
[$st, $pl] = gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => '../../../../evil.png']);
check('traversal in the name cannot escape gallery/',
      $st === 200 && ($pl['item']['file'] ?? '') === 'evil.png'
      && $files() === ['evil.png'] && !is_file($root . '/evil.png'));

$reset();
for ($i = 0; $i < MAX_GALLERY_ITEMS; $i++) gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => "i$i.png"]);
[$st, ] = gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => 'overflow.png']);
check('count capped at ' . MAX_GALLERY_ITEMS, $st === 409 && count($files()) === MAX_GALLERY_ITEMS);

// Character count without relying on mbstring — this suite must run on a host that
// does not load it, which is exactly the configuration gallery_clean_text guards for.
$ulen = fn(string $s) => count(preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY) ?: []);

$reset();
[, $pl] = gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'caption' => "ligne 1\nligne 2\r\n" . str_repeat('x', 900)]);
$cap = $pl['item']['caption'] ?? '';
check('caption flattened and clamped to 400', strpos($cap, "\n") === false && $ulen($cap) === 400);

$reset();
// An accented caption cut on BYTES would produce invalid UTF-8 and json_encode would
// return false, blanking metadata.json. Clamp on characters, and prove the file survives.
[, $pl] = gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'caption' => str_repeat('é', 900)]);
$cap = $pl['item']['caption'] ?? '';
check('accented caption clamped on characters, not bytes', $ulen($cap) === 400);
check('clamped caption is valid UTF-8', $cap === (string)@iconv('UTF-8', 'UTF-8//IGNORE', $cap));
check('metadata.json survives an accented caption',
      is_array($meta()) && ($meta()['gallery'][0]['caption'] ?? '') === $cap);

// ── Delete ───────────────────────────────────────────────────────────────────
section('Delete');
$reset();
gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => 'a.png']);
gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => 'b.png']);
[$st, $pl] = gallery_delete($ds, 'a.png');
check('removes file and entry', $st === 200 && $files() === ['b.png']
      && array_column($pl['gallery'], 'file') === ['b.png']);

$bad = true;
foreach (['../metadata.json', '../../fixed/demo/metadata.json', 'sub/a.png', 'a.php'] as $t) {
    [$s, ] = gallery_delete($ds, $t);
    if ($s !== 400) $bad = false;
}
check('traversal targets refused', $bad && is_file($ds . '/metadata.json'));

$reset();
gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => 'a.png']);
[$st, ] = gallery_delete($ds, 'gallery/a.png');
check('"gallery/x.png" form accepted', $st === 200 && $files() === []);

// ── Reconciliation on save ───────────────────────────────────────────────────
section('Reconciliation on save');
$reset();
gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => 'a.png', 'caption' => 'Vue A']);
gallery_add('fixed/demo', $ds, ['image' => $durl($PNG), 'filename' => 'b.png', 'caption' => 'Vue B']);
$stored = $meta()['gallery'];
$g = gallery_reconcile(['gallery' => [['file' => 'a.png', 'caption' => 'Vue A']]], $ds, $stored);
check('stale draft cannot drop a concurrent upload', array_column($g, 'file') === ['a.png', 'b.png']);
check('re-appended image keeps its stored caption', ($g[1]['caption'] ?? '') === 'Vue B');

$g = gallery_reconcile(['gallery' => [
    ['file' => 'a.png'], ['file' => 'ghost.png'],
    ['file' => '../../../etc/passwd'], ['file' => 'x.php'], 'not-an-object',
]], $ds, null);
check('entries with no file on disk are dropped', array_column($g, 'file') === ['a.png', 'b.png']);

$g = gallery_reconcile(['gallery' => [
    ['file' => 'b.png', 'caption' => 'second devient premier'], ['file' => 'a.png'],
]], $ds, null);
check('draft order and captions win', array_column($g, 'file') === ['b.png', 'a.png']
      && ($g[0]['caption'] ?? '') === 'second devient premier');

$g = gallery_reconcile(['gallery' => [['file' => 'a.png'], ['file' => 'a.png']]], $ds, null);
check('duplicates collapse', count(array_filter($g, fn($e) => $e['file'] === 'a.png')) === 1);

$reset();
check('no gallery folder yields an empty list', gallery_reconcile(['name' => 'Demo'], $ds, null) === []);

// ── Cross-backend agreement ──────────────────────────────────────────────────
// A folder written by the Python engine must be read identically here. The Python
// side produced these names/captions in tests/test_dataset_gallery.py.
section('Cross-backend');
$reset();
@mkdir($ds . '/gallery', 0777, true);
file_put_contents($ds . '/gallery/coupe-annot-e.png', $PNG);
file_put_contents($ds . '/gallery/liar.jpg', $JPEG);
$writeMeta(['name' => 'Demo', 'gallery' => [
    ['file' => 'coupe-annot-e.png', 'caption' => 'Vue sagittale', 'added' => '2026-08-08T12:00:00'],
    ['file' => 'liar.jpg'],
]]);
$g = gallery_reconcile($meta(), $ds, null);
check('reads a Python-written gallery unchanged',
      array_column($g, 'file') === ['coupe-annot-e.png', 'liar.jpg']
      && ($g[0]['caption'] ?? '') === 'Vue sagittale'
      && ($g[0]['added'] ?? '') === '2026-08-08T12:00:00');

echo "\n" . ($fails === 0 ? "ALL PASS\n" : "$fails FAILURE(S)\n");
exit($fails === 0 ? 0 : 1);
