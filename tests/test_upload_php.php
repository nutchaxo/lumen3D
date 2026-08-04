<?php
/* PHP twin of tests/test_upload_staging.py — asserts api/_upload_lib.php agrees
   with upload_staging.py on the path allowlist, the resume bitmap, the chunk
   integrity checks, whole-dataset validation and publish.

   The two backends share ONE journal format on purpose: a store written by the
   Python dev server must resume unchanged under a PHP host and vice versa (an
   operator who moves a deployment mid-import should not lose the transfer). The
   cross-backend fixture at the end pins that.

   admin_root() is dirname(__DIR__) of the library, so both libraries are
   exercised from a COPY inside a throwaway web root.
     php tests/test_upload_php.php                                              */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-upload-' . bin2hex(random_bytes(4));
@mkdir($root . '/api', 0777, true);
@mkdir($root . '/DATA_WEB/fixed', 0777, true);
@mkdir($root . '/changelog', 0777, true);
copy(__DIR__ . '/../api/_admin_lib.php',  $root . '/api/_admin_lib.php');
copy(__DIR__ . '/../api/_upload_lib.php', $root . '/api/_upload_lib.php');
file_put_contents($root . '/changelog/changelog_1.42.0.md', 'x');
require_once $root . '/api/_upload_lib.php';

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

// ── 1. Path allowlist ────────────────────────────────────────────────────────
echo "path allowlist\n";
$allowed = [
    ['fixed', 'metadata.json'], ['fixed', 'thumbnail.webp'], ['fixed', 'bricks/manifest.json'],
    ['fixed', 'bricks/lod0/c0/pack_00.bin'], ['fixed', 'bricks/lod3/rgba/pack_12.bin'],
    ['fixed', 'download/orig.ims'], ['live', 'bricks/t000/lod2/c0/pack_00.bin'],
    ['live', 'model.glb'], ['live', 'tracks.json.gz'],
];
foreach ($allowed as [$t, $p]) check("allow  $t/$p", lumen_up_classify($t, $p) !== null);

$refused = [
    ['fixed', 'evil.php'], ['fixed', '.htaccess'], ['fixed', 'index.html'],
    ['fixed', '../../api/admin_credential.json'], ['fixed', 'bricks/../../evil.js'],
    ['fixed', 'download/evil.php'], ['fixed', 'download/sub/dir.ims'],
    ['fixed', 'bricks/t000/lod0/c0/pack_00.bin'],       // timepoints are live/tracking only
    ['fixed', 'bricks/lod0/c0/pack_00.bin.php'], ['fixed', 'bricks/lod0/../../../x.php'],
    ['fixed', '/etc/passwd'], ['fixed', 'bricks/lod0/c0/.hidden.bin'],
];
foreach ($refused as [$t, $p]) check("refuse $t/$p", lumen_up_classify($t, $p) === null);

// ── 2. Tiering: the coarsest LOD is what makes a dataset openable ────────────
echo "tiering\n";
$files = [
    ['path' => 'metadata.json', 'size' => 1, 'kind' => 'metadata', 'tier' => 0],
    ['path' => 'bricks/lod0/c0/pack_00.bin', 'size' => 1, 'kind' => 'pack', 'tier' => 3],
    ['path' => 'bricks/lod2/c0/pack_00.bin', 'size' => 1, 'kind' => 'pack', 'tier' => 2],
    ['path' => 'bricks/lod4/c0/pack_00.bin', 'size' => 1, 'kind' => 'pack', 'tier' => 2],
];
lumen_up_assign_tiers($files);
$tierOf = [];
foreach ($files as $f) $tierOf[$f['path']] = $f['tier'];
check('coarsest lod4 -> preview tier', $tierOf['bricks/lod4/c0/pack_00.bin'] === LUMEN_UP_TIER_PREVIEW);
check('lod2 -> mid tier',              $tierOf['bricks/lod2/c0/pack_00.bin'] === LUMEN_UP_TIER_MID);
check('lod0 -> full tier',             $tierOf['bricks/lod0/c0/pack_00.bin'] === LUMEN_UP_TIER_FULL);

// ── 3. Full lifecycle ────────────────────────────────────────────────────────
echo "lifecycle\n";
lumen_up_ensure_dirs();
check('staging root carries its deny-all guard', is_file(lumen_up_root() . '/.htaccess')
    && strpos((string)file_get_contents(lumen_up_root() . '/.htaccess'), 'Require all denied') !== false);

$meta = ['id' => 'DS', 'name' => 'DS', 'type' => 'fixed',
         'dimensions' => ['x' => 64, 'y' => 64, 'z' => 64, 'c' => 1],
         'channels' => [['name' => 'c0']]];
$mb = json_encode($meta);
$manifest = ['version' => 2, 'levels' => [['level' => 0]],
             'brickTransport' => ['brickToPack' => ['b' => ['url' => 'lod0/c0/pack_00.bin', 'offset' => 0, 'length' => 10]]]];
$nb = json_encode($manifest);
$pack  = str_repeat('X', 10);
$thumb = 'RIFF' . str_repeat('0', 20);

$plan = lumen_up_plan([['type' => 'fixed', 'folder' => 'DS', 'files' => [
    ['path' => 'metadata.json', 'size' => strlen($mb)],
    ['path' => 'bricks/manifest.json', 'size' => strlen($nb)],
    ['path' => 'bricks/lod0/c0/pack_00.bin', 'size' => strlen($pack)],
    ['path' => 'thumbnail.webp', 'size' => strlen($thumb)],
    ['path' => 'evil.php', 'size' => 5],
]]], LUMEN_UP_DEFAULT_CHUNK);
$d = $plan['datasets'][0];
check('plan rejects evil.php', count($d['rejected']) === 1 && $d['rejected'][0]['path'] === 'evil.php');
check('plan accepts 4 files',  count($d['files']) === 4);
check('plan state = uploading', $d['state'] === LUMEN_UP_STATE_UPLOADING);

$blobs = ['metadata.json' => $mb, 'bricks/manifest.json' => $nb,
          'bricks/lod0/c0/pack_00.bin' => $pack, 'thumbnail.webp' => $thumb];
foreach ($blobs as $rel => $data) {
    [$st, ] = lumen_up_write_chunk('fixed', 'DS', $rel, 0, $data, hash('sha256', $data));
    check("chunk $rel", $st === 200);
    [$st, ] = lumen_up_finalize('fixed', 'DS', $rel, null);
    check("finalize $rel", $st === 200);
}
$v = lumen_up_validate_dataset('fixed', 'DS');
check('validate ok', !empty($v['ok']));
check('state = staged', lumen_up_state_of('fixed', 'DS') === LUMEN_UP_STATE_STAGED);

// ── 4. Integrity gates ───────────────────────────────────────────────────────
echo "integrity\n";
// A requested chunk size below the 256 KiB floor is clamped, so the fixture is
// sized off the real floor: 2.5 chunks -> a partial tail, which is the case that
// exercises the last-chunk length arithmetic.
$CS = LUMEN_UP_MIN_CHUNK;
$bigLen = (int)($CS * 2.5);
lumen_up_plan([['type' => 'fixed', 'folder' => 'DS2', 'files' => [
    ['path' => 'bricks/lod0/c0/pack_00.bin', 'size' => $bigLen],
]]], $CS);
$whole = str_repeat('B', $bigLen);
$c0 = substr($whole, 0, $CS);
[$st, $pl] = lumen_up_write_chunk('fixed', 'DS2', 'bricks/lod0/c0/pack_00.bin', 0, $c0, str_repeat('0', 64));
check('tampered chunk refused (422)', $st === 422 && $pl['error'] === 'checksum_mismatch');
[$st, $pl] = lumen_up_write_chunk('fixed', 'DS2', 'bricks/lod0/c0/pack_00.bin', 0, 'AAA', hash('sha256', 'AAA'));
check('short chunk refused (400)', $st === 400 && $pl['error'] === 'bad_chunk_length');
[$st, ] = lumen_up_write_chunk('fixed', 'DS2', '../../api/admin_credential.json', 0, 'x', hash('sha256', 'x'));
check('traversal refused (400)', $st === 400);
[$st, ] = lumen_up_finalize('fixed', 'DS2', 'bricks/lod0/c0/pack_00.bin', null);
check('finalize incomplete refused (409)', $st === 409);

// Out-of-order + resume: send the tail and the head, leave the middle for later.
foreach ([2, 0] as $i) {
    $part = substr($whole, $i * $CS, $CS);
    [$st, ] = lumen_up_write_chunk('fixed', 'DS2', 'bricks/lod0/c0/pack_00.bin', $i, $part, hash('sha256', $part));
    check("out-of-order chunk $i", $st === 200);
}
$replan = lumen_up_plan([['type' => 'fixed', 'folder' => 'DS2', 'files' => [
    ['path' => 'bricks/lod0/c0/pack_00.bin', 'size' => $bigLen]]]], $CS);
check('resume reports only chunk 1 missing', $replan['datasets'][0]['files'][0]['missing'] === [1]);
check('resume reports head+tail received',   $replan['datasets'][0]['files'][0]['received'] === $CS + ($bigLen - 2 * $CS));
$part = substr($whole, $CS, $CS);
lumen_up_write_chunk('fixed', 'DS2', 'bricks/lod0/c0/pack_00.bin', 1, $part, hash('sha256', $part));
[$st, ] = lumen_up_finalize('fixed', 'DS2', 'bricks/lod0/c0/pack_00.bin', null);
check('finalize after resume', $st === 200);
check('bytes on disk match', file_get_contents(lumen_up_dataset_dir('fixed', 'DS2') . '/bricks/lod0/c0/pack_00.bin') === $whole);

// A pack shorter than the manifest claims must block the publish.
$v2 = lumen_up_validate_dataset('fixed', 'DS2');
check('DS2 fails validation (no metadata/manifest)', empty($v2['ok']) && in_array('missing_metadata', $v2['errors'], true));

// ── 5. Operator edits survive a re-drop ──────────────────────────────────────
echo "metadata lock\n";
[$st, ] = lumen_up_write_metadata('fixed', 'DS', ['name' => 'Renamed by operator']);
check('save metadata', $st === 200);
check('name persisted', (lumen_up_read_metadata('fixed', 'DS')['name'] ?? '') === 'Renamed by operator');
$replan = lumen_up_plan([['type' => 'fixed', 'folder' => 'DS', 'files' => [
    ['path' => 'metadata.json', 'size' => strlen($mb)]]]], LUMEN_UP_DEFAULT_CHUNK);
check('re-drop skips the edited metadata', ($replan['datasets'][0]['files'][0]['skip'] ?? '') === 'locked');
[$st, $pl] = lumen_up_write_chunk('fixed', 'DS', 'metadata.json', 0, $mb, hash('sha256', $mb));
check('a re-sent metadata chunk is a no-op', $st === 200 && ($pl['skipped'] ?? '') === 'locked');
check('operator name still intact', (lumen_up_read_metadata('fixed', 'DS')['name'] ?? '') === 'Renamed by operator');

// The editor round-trips whatever `get` handed it, computed view fields included.
// Persisting those would leave a PUBLISHED dataset permanently flagged "staging".
lumen_up_write_metadata('fixed', 'DS', [
    'name' => 'Renamed by operator', 'staging' => true, 'stagingState' => 'editable',
    'stagingEditable' => true, 'path' => 'staging:fixed/DS', 'totalBytes' => 999,
    'receivedBytes' => 999, 'publishedExists' => false, 'expiresInS' => 42, 'key' => 'fixed/DS',
]);
$onDisk = lumen_up_read_json(lumen_up_dataset_dir('fixed', 'DS') . '/metadata.json');
$leaked = array_intersect(LUMEN_UP_COMPUTED, array_keys($onDisk));
check('computed view fields never reach metadata.json', $leaked === []);

// ── 6. Publish ───────────────────────────────────────────────────────────────
echo "publish\n";
[$st, $pl] = lumen_up_publish('fixed', 'DS', false, true);
check('publish ok', $st === 200);
check('landed in DATA_WEB', is_file($root . '/DATA_WEB/fixed/DS/metadata.json'));
check('published hidden by default', !empty(json_decode((string)file_get_contents($root . '/DATA_WEB/fixed/DS/metadata.json'), true)['hidden']));
check('staging dir cleared', !is_dir(lumen_up_staging() . '/fixed/DS'));
check('journal cleared', !is_file(lumen_up_journal_path('fixed', 'DS')));
[$st, $pl] = lumen_up_publish('fixed', 'DS2', false, true);
check('publish refuses an unvalidated dataset', $st === 409 && $pl['error'] === 'validation_failed');

// ── 7. datasets.php must load the staging symbols for EVERY action ───────────
// ?action=list calls lumen_staged_rows() and the id branch needs the
// LUMEN_STAGING_PREFIX constant. Requiring _upload_lib.php only inside that
// branch made a plain ?action=list a PHP fatal — invisible to `php -l`, and
// invisible to any test that only reads the file. Loading datasets.php in library
// mode (as api/catalog.php does) proves the symbols are there before the router runs.
echo "datasets.php symbol loading\n";
copy(__DIR__ . '/../api/datasets.php', $root . '/api/datasets.php');
define('LUMEN_DATASETS_LIB', 1);
require_once $root . '/api/datasets.php';
check('LUMEN_STAGING_PREFIX defined', defined('LUMEN_STAGING_PREFIX'));
check('lumen_staged_rows() available', function_exists('lumen_staged_rows'));
check('lumen_staged_dataset() available', function_exists('lumen_staged_dataset'));
check('lumen_staged_rows() runs', is_array(lumen_staged_rows()));

// ── 8. Journal interop with the Python backend ───────────────────────────────
// A journal written by upload_staging.py must resume verbatim here. The fixture
// below is the exact shape that module emits (base64 bitmap, one bit per chunk).
echo "cross-backend journal\n";
lumen_up_ensure_dirs();
@mkdir(lumen_up_staging() . '/fixed/PY/bricks/lod0/c0', 0777, true);
file_put_contents(lumen_up_staging() . '/fixed/PY/bricks/lod0/c0/pack_00.bin', str_repeat("\0", 24));
file_put_contents(lumen_up_journal_path('fixed', 'PY'), json_encode([
    'version' => 1, 'type' => 'fixed', 'folder' => 'PY',
    'createdAt' => gmdate('Y-m-d\TH:i:s+00:00'), 'updatedAt' => gmdate('Y-m-d\TH:i:s+00:00'),
    'files' => ['bricks/lod0/c0/pack_00.bin' => [
        'size' => 24, 'chunkSize' => 8, 'kind' => 'pack', 'tier' => 3,
        'bits' => base64_encode(chr(0b101)),   // chunks 0 and 2 received, 1 missing
        'done' => false, 'sha' => null,
    ]],
    'rejected' => [], 'metaLocked' => false, 'publishedAt' => null,
]));
$e = lumen_up_load_journal('fixed', 'PY')['files']['bricks/lod0/c0/pack_00.bin'];
check('reads a python bitmap: 16 bytes received', lumen_up_received($e) === 16);
check('reads a python bitmap: chunk 1 missing',   lumen_up_missing($e) === [1]);

echo $fails === 0 ? "\nALL PASS\n" : "\n$fails FAILURE(S)\n";
exit($fails === 0 ? 0 : 1);
