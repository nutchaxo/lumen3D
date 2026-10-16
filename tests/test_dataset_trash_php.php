<?php
/* PHP twin of tests/test_dataset_trash.py — asserts api/_trash_lib.php agrees with
   dataset_trash.py: a delete moves the folder to uploads/trash/ for 60 days, the same
   name can be deleted any number of times, a restore over a re-uploaded dataset is
   refused with a free suggestion, expiry and purge reclaim the bytes.
     php tests/test_dataset_trash_php.php                                         */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-trash-' . bin2hex(random_bytes(4));
mkdir($root, 0777, true);
define('LUMEN_PRIVATE_DIR', $root);
define('LUMEN_DATA_WEB', $root . '/DATA_WEB');
define('LUMEN_UPLOADS_DIR', $root . '/uploads');
require_once __DIR__ . '/../api/_trash_lib.php';

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

function make(string $type, string $folder, string $name, string $payload = 'xxxxxxxxxx'): string {
    $d = LUMEN_DATA_WEB . "/$type/$folder";
    @mkdir($d . '/bricks', 0777, true);
    file_put_contents($d . '/bricks/p.bin', $payload);
    file_put_contents($d . '/metadata.json', json_encode(['name' => $name, 'type' => $type, 'id' => "$type/$folder"]));
    return $d;
}

section('Delete');
$d = make('3d', 'demo', 'Demo', str_repeat('x', 123));
[$st, $pl] = lumen_trash_move('3d/demo');
check('200 and the folder left DATA_WEB', $st === 200 && !is_dir($d));
[, $list] = lumen_trash_list();
$rows = $list['entries'];
check('one entry with name, id, 60 days, size', count($rows) === 1 && $rows[0]['id'] === '3d/demo'
    && $rows[0]['name'] === 'Demo' && $rows[0]['daysLeft'] === 60 && $rows[0]['bytes'] >= 123);
check('trash lives under the never-served uploads/', strpos(lumen_trash_root(), LUMEN_UPLOADS_DIR) === 0);

section('Same name, several deletions');
$ids = [];
foreach ([0, 1, 2] as $i) {
    make('3d', 'demo', "v$i", str_repeat((string)$i, 4));
    [$st, $pl] = lumen_trash_move('3d/demo');
    $ids[] = $pl['trashId'] ?? '';
}
check('three distinct trash ids', $st === 200 && count(array_unique($ids)) === 3);
[, $list] = lumen_trash_list();
check('four entries listed (the first one included)', count($list['entries']) === 4);
[$st, $pl] = lumen_trash_restore($ids[1]);
check('restores its own bytes', $st === 200 && $pl['id'] === '3d/demo'
    && file_get_contents(LUMEN_DATA_WEB . '/3d/demo/bricks/p.bin') === '1111');

section('Restore over a re-uploaded dataset');
[$st, $err] = lumen_trash_restore($ids[2]);
check('409 exists + suggestion', $st === 409 && $err['error'] === 'exists' && $err['suggested'] === 'demo-restored');
[$st, $pl] = lumen_trash_restore($ids[2], 'demo-restored');
check('restored under the suggested name', $st === 200 && $pl['id'] === '3d/demo-restored');
$meta = json_decode(file_get_contents(LUMEN_DATA_WEB . '/3d/demo-restored/metadata.json'), true);
check('metadata id follows the folder', $meta['id'] === '3d/demo-restored');
check('the untouched dataset keeps its own metadata', json_decode(file_get_contents(LUMEN_DATA_WEB . '/3d/demo/metadata.json'), true)['name'] === 'v1');

section('Bad input');
check('traversal id refused', lumen_trash_move('../x')[0] === 400);
check('unknown dataset', lumen_trash_move('3d/missing')[0] === 404);
check('bad trash id', lumen_trash_restore('../x')[0] === 404 && lumen_trash_purge('a/b')[0] === 404);
check('bad target folder', lumen_trash_restore($ids[0], '../evil')[0] === 400);

section('Expiry, purge, empty');
$edir = lumen_trash_root() . '/' . $ids[0];
check('kept at day 59', lumen_trash_purge_expired(time() + 59 * 86400) === [] || !in_array($ids[0], lumen_trash_purge_expired(time() + 59 * 86400), true));
check('reclaimed past day 60', in_array($ids[0], lumen_trash_purge_expired(time() + 61 * 86400), true) && !is_dir($edir));
make('3d', 'a', 'A');
[, $pa] = [0, lumen_trash_move('3d/a')[1]];
check('purge one', lumen_trash_purge($pa['trashId'])[0] === 200 && lumen_trash_purge($pa['trashId'])[0] === 404);
make('3d', 'b', 'B');
lumen_trash_move('3d/b');
[, $e] = lumen_trash_empty();
check('empty removes the rest', $e['removed'] >= 1 && count(lumen_trash_list()[1]['entries']) === 0);

echo $fails ? "\n$fails FAILED\n" : "\nall ok\n";
exit($fails ? 1 : 0);
