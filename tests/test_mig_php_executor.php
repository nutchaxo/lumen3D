<?php
/* Dataset migrations — the PHP server executor and job journal (SPEC §3–§5).
   Synthetic published datasets (a '3d' one crossing two tile columns and rows, a
   two-timepoint 'live' one) go through plan → unit_run / unit_put → finalize, and
   every plane tile is decoded and compared with the source voxels. Also: the probe,
   blob validation, executor switch, source-change detection, repair detection, the
   crash between swap and version bump, the resumable finalize, cancel, bench.
     php tests/test_mig_php_executor.php                                         */
declare(strict_types=1);

require __DIR__ . '/mig_php_fixture.inc.php';
mig_require_gd();

$root = mig_tmpdir('php');
define('LUMEN_DATA_WEB', "$root/DATA_WEB");
define('LUMEN_UPLOADS_DIR', "$root/uploads");
define('LUMEN_PRIVATE_DIR', "$root/private");
define('LUMEN_MIG_BUDGET_FLOOR', 0);
@mkdir("$root/private", 0777, true);
require __DIR__ . '/../api/_migrations_lib.php';

$fails = 0;
function check(string $name, $cond, string $detail = ''): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . $name . ($cond || $detail === '' ? '' : "  -- $detail") . "\n";
    if (!$cond) $fails++;
}
function api(string $action, array $body = [], array $params = [], ?string $raw = null): array {
    return lumen_mig_handle($action, $params, $body, $raw);
}
function journal(string $type, string $folder): ?array {
    $p = lumen_mig_journal_path($type, $folder, 'm002-planes');
    return is_file($p) ? json_decode((string)file_get_contents($p), true) : null;
}
function blob_of(array $tiles): string {
    $b = pack('V', count($tiles));
    foreach ($tiles as $z => $png) $b .= pack('VV', $z, strlen($png)) . $png;
    return $b;
}
function rows_by_id(): array {
    $rows = [];
    foreach (api('status')[1]['datasets'] as $r) $rows[$r['id']] = $r;
    return $rows;
}

try {
    // ── Probe ──────────────────────────────────────────────────────────────
    $cap = lumen_mig_capabilities();
    check('probe: GD decodes the embedded lossless WebP exactly', $cap['webpDecode'] === true);
    check('probe: PNG encoder round-trips', $cap['pngEncode'] === true);
    check('probe: server executor available', $cap['available'] === true && $cap['backend'] === 'php', json_encode($cap));

    // ── PNG codec ──────────────────────────────────────────────────────────
    $px = ''; for ($i = 0; $i < 37 * 11; $i++) $px .= chr(($i * 97 + 13) & 255);
    $png = lumen_mig_png_encode($px, 37, 11);
    [$w, $h, $back] = mig_png_decode($png);
    check('png: greyscale 8-bit round trip', $w === 37 && $h === 11 && $back === $px);
    check('png: validator accepts it (not zero)', lumen_mig_png_validate($png, 37, 11) === false);
    check('png: validator flags an all-zero tile', lumen_mig_png_validate(lumen_mig_png_encode(str_repeat("\0", 64), 8, 8), 8, 8) === true);
    $gd = imagecreatefromstring($png);
    check('png: a third-party decoder (GD) reads the same pixels', $gd !== false && (imagecolorat($gd, 5, 3) & 255) === ord($px[3 * 37 + 5]));
    $withText = substr($png, 0, 33) . lumen_mig_png_chunk('tEXt', "a\0b") . substr($png, 33);
    $refused = function (string $p, int $w, int $h): bool { try { lumen_mig_png_validate($p, $w, $h); return false; } catch (InvalidArgumentException $e) { return true; } };
    check('png: validator refuses an ancillary chunk', $refused($withText, 37, 11));
    check('png: validator refuses a bad CRC', $refused(substr_replace($png, 'X', 40, 1), 37, 11));
    check('png: validator refuses a wrong size', $refused($png, 36, 11));

    // ── Fixtures ───────────────────────────────────────────────────────────
    $t0 = microtime(true);
    $vol3d = new MigVolume(520, 515, 70, 2, 11);           // TX=2, TY=2, two brick layers (64 + 6)
    $dir3d = mig_build_dataset(LUMEN_DATA_WEB, '3d', 'synthA', [0 => $vol3d]);
    $volsLive = [0 => new MigVolume(130, 70, 66, 2, 21), 1 => new MigVolume(130, 70, 66, 2, 22)];
    $dirLive = mig_build_dataset(LUMEN_DATA_WEB, 'live', 'synthL', $volsLive);
    mig_build_dataset(LUMEN_DATA_WEB, '2d', 'photo', [0 => new MigVolume(10, 10, 1, 1, 3)]);
    echo sprintf("  ..   fixtures built in %.1f s\n", microtime(true) - $t0);

    // ── Status before ──────────────────────────────────────────────────────
    [$code, $st] = api('status');
    $rows = rows_by_id();
    check('status: latest 2 + registry', $code === 200 && $st['latest'] === 2 && ($st['migrations'][0]['id'] ?? '') === 'm002-planes' && count($st['migrations'][0]['title']) === 4);
    check('status: 3d dataset at v1 needs m002-planes', ($rows['3d/synthA']['pending'] ?? null) === ['m002-planes'] && $rows['3d/synthA']['formatVersion'] === 1 && $rows['3d/synthA']['name'] === 'synthA');
    check('status: live dataset has 2 trees', ($rows['live/synthL']['trees'] ?? 0) === 2);
    check('status: 2d dataset has nothing pending', ($rows['2d/photo']['pending'] ?? null) === []);
    $est = $rows['3d/synthA']['estimate'];
    check('status: estimate counts non-empty units', $est['units'] === 14 && $est['unitsTotal'] === 14 && $est['bytes'] > 0 && $est['bytes'] === $est['bytesTotal']);

    // ── 3d: plan → unit_run → finalize ────────────────────────────────────
    [$code, $plan] = api('plan', ['dataset' => '3d/synthA', 'migration' => 'm002-planes']);
    // 2 layers × 2 channels × 2 × 2 tiles = 16 units; c1 tile column 1 of layer 0 is empty (2 units)
    check('plan: 16 units, 2 empty, counted as done', $code === 200 && $plan['total'] === 16 && $plan['empty'] === 2 && $plan['done'] === 2 && $plan['pending'] === 14 && count($plan['units']) === 14, json_encode($plan));
    check('plan: unit keys in tuple order', $plan['units'][0] === 't0.z0.c0.y0.x0' && $plan['units'][13] === 't0.z1.c1.y1.x1');
    $j = journal('3d', 'synthA');
    check('journal: spec + twin fields', array_keys($j) === ['migration', 'dataset', 'createdAt', 'sourceManifests', 'units', 'done', 'executors', 'state', 'updatedAt'] && $j['done'] === []);
    check('journal: source manifest sha', $j['sourceManifests'] === ['0' => hash_file('sha256', "$dir3d/bricks/manifest.json")]);
    check('journal: lock file named after the job', is_file(lumen_mig_root() . '/3d__synthA__m002-planes.lock'));
    [$code2, $plan2] = api('plan', ['dataset' => '3d/synthA', 'migration' => 'm002-planes', 'offset' => 3, 'limit' => 2]);
    check('plan: idempotent and paged', $code2 === 200 && $plan2['units'] === array_slice($plan['units'], 3, 2) && $plan2['total'] === 16);
    [$c, $r] = api('unit_put', [], ['dataset' => '3d/synthA', 'migration' => 'm002-planes', 'unit' => 't0.z0.c1.y0.x1'], pack('V', 0));
    check('unit_put refuses an empty unit', $c === 409 && $r['error'] === 'empty_unit');

    [$c, $fin] = api('finalize', ['dataset' => '3d/synthA', 'migration' => 'm002-planes']);
    check('finalize: refused while units are pending', $c === 409 && $fin['error'] === 'units_pending');

    $t0 = microtime(true); $nProc = 0; $loops = 0;
    do {
        [$c, $run] = api('unit_run', ['dataset' => '3d/synthA', 'migration' => 'm002-planes', 'maxSeconds' => 20]);
        $loops++; $nProc += count($run['processed'] ?? []);
    } while ($c === 200 && $run['done'] < $run['total'] && $loops < 50);
    $dt = microtime(true) - $t0;
    check('unit_run: every unit done', $c === 200 && $run['done'] === 16 && $run['bytesWritten'] > 0, json_encode($run));
    echo sprintf("  ..   server executor: %d units in %.2f s (%.3f s/unit, random voxels: worst case for deflate)\n", $nProc, $dt, $dt / max(1, $nProc));
    $j = journal('3d', 'synthA');
    check('journal: done lists the 14 processed units, server counted', count($j['done']) === 14 && $j['executors'] === ['browser' => 0, 'server' => 14]);
    check('tile store: layout t{t}/z{z}/c{c}.y{ty}.x{tx}.png', is_file(lumen_mig_store_dir('3d', 'synthA', 'm002-planes') . '/t0/z0/c0.y0.x0.png'));

    $metaBefore = json_decode((string)file_get_contents("$dir3d/metadata.json"), true);
    [$c, $fin] = api('finalize', ['dataset' => '3d/synthA', 'migration' => 'm002-planes']);
    check('finalize: complete + formatVersion 2', $c === 200 && $fin['complete'] === true && $fin['formatVersion'] === 2, json_encode($fin));
    $errs = mig_verify_planes("$dir3d/planes", $vol3d, 0, hash_file('sha256', "$dir3d/bricks/manifest.json"));
    check('planes 3d: every tile equals the source voxels', !$errs, implode('; ', array_slice($errs, 0, 5)));
    $pm = json_decode((string)file_get_contents("$dir3d/planes/manifest.json"), true);
    check('planes 3d: producer migration-server', $pm['producer'] === 'migration-server');
    check('planes 3d: compact JSON', strpos((string)file_get_contents("$dir3d/planes/manifest.json"), ', ') === false);
    $meta = json_decode((string)file_get_contents("$dir3d/metadata.json"), true);
    check('metadata: formatVersion bumped, other keys kept', $meta['formatVersion'] === 2 && $meta['curatedNote'] === 'keep me' && count($meta) === count($metaBefore) + 1);
    check('finalize: journal and tile store deleted', journal('3d', 'synthA') === null && !is_dir(lumen_mig_store_dir('3d', 'synthA', 'm002-planes')));
    check('finalize: no leftover dot-folder', !is_dir("$dir3d/.planes-incoming") && !is_dir("$dir3d/.planes-old"));
    $rows = rows_by_id();
    check('status: 3d now up to date', $rows['3d/synthA']['pending'] === [] && $rows['3d/synthA']['formatVersion'] === 2 && !$rows['3d/synthA']['repair']);
    [$c] = api('plan', ['dataset' => '3d/synthA', 'migration' => 'm002-planes']);
    check('plan: refused on an up-to-date dataset', $c === 409);

    // ── Repair detection ───────────────────────────────────────────────────
    rename("$dir3d/planes/z00069.bin", "$root/z69.bak");
    $rows = rows_by_id();
    check('repair: a missing plane pack is detected at v2', $rows['3d/synthA']['repair'] === true && $rows['3d/synthA']['pending'] === ['m002-planes']);
    [$c] = api('plan', ['dataset' => '3d/synthA', 'migration' => 'm002-planes']);
    check('repair: plan accepted at version 2', $c === 200);
    api('cancel', ['dataset' => '3d/synthA', 'migration' => 'm002-planes']);
    rename("$root/z69.bak", "$dir3d/planes/z00069.bin");
    $pmRaw = (string)file_get_contents("$dir3d/planes/manifest.json");
    file_put_contents("$dir3d/planes/manifest.json", str_replace('"manifestSha256":"', '"manifestSha256":"0', $pmRaw));
    check('repair: a stale source sha is detected', rows_by_id()['3d/synthA']['repair'] === true);
    file_put_contents("$dir3d/planes/manifest.json", $pmRaw);

    // ── Crash between swap and version bump ────────────────────────────────
    $m = json_decode((string)file_get_contents("$dir3d/metadata.json"), true); unset($m['formatVersion']);
    file_put_contents("$dir3d/metadata.json", json_encode($m));
    $rows = rows_by_id();
    check('crash: valid planes + v1 shows as needing the update', $rows['3d/synthA']['pending'] === ['m002-planes'] && !$rows['3d/synthA']['repair']);
    [$c, $fin] = api('finalize', ['dataset' => '3d/synthA', 'migration' => 'm002-planes']);
    check('crash: finalize without a job only bumps the version', $c === 200 && $fin['formatVersion'] === 2
        && json_decode((string)file_get_contents("$dir3d/metadata.json"), true)['formatVersion'] === 2);

    // ── live: half the units by the "browser" (unit_put), the rest by the server ──
    [$c, $plan] = api('plan', ['dataset' => 'live/synthL', 'migration' => 'm002-planes']);
    check('live plan: 2 trees × 2 layers × 2 channels', $c === 200 && $plan['total'] === 8, json_encode($plan));
    $planL = lumen_mig_plan_for('live/synthL');
    $half = array_slice($plan['units'], 0, intdiv(count($plan['units']), 2));
    foreach ($half as $key) {
        [$tiles] = lumen_mig_process_unit($planL, lumen_mig_parse_key($key));
        [$c, $put] = api('unit_put', [], ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'unit' => $key], blob_of($tiles));
        if ($c !== 200) break;
    }
    check('unit_put: accepted', $c === 200 && $put['ok'] === true, json_encode($put));
    [$c, $dry] = api('unit_put', [], ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'unit' => $half[0], 'dry' => '1'], str_repeat('x', 1000));
    check('unit_put dry: body discarded, progress reported', $c === 200 && $dry['dry'] === true && $dry['bytes'] === 1000 && isset($dry['done']));

    // blob validation (unit t1.z1.c0.y0.x0: 130×70 tiles, planes 64..65)
    $good = lumen_mig_png_encode(str_repeat("\x07", 130 * 70), 130, 70);
    $bad = [
        'z outside the layer' => [pack('V', 1) . pack('VV', 0, strlen($good)) . $good, 'bad_blob'],
        'wrong tile size'     => [(function () { $p = lumen_mig_png_encode(str_repeat("\1", 64 * 70), 64, 70); return blob_of([64 => $p]); })(), 'bad_png'],
        'not a png'           => [pack('V', 1) . pack('VV', 64, 12) . 'GIF89a......', 'bad_png'],
        'truncated'           => [pack('V', 2) . pack('VV', 64, strlen($good)) . $good, 'bad_blob'],
        'duplicate z'         => [pack('V', 2) . pack('VV', 64, strlen($good)) . $good . pack('VV', 64, strlen($good)) . $good, 'bad_blob'],
        'trailing bytes'      => [blob_of([64 => $good]) . 'xx', 'bad_blob'],
        'tEXt chunk'          => [blob_of([64 => substr($good, 0, 33) . lumen_mig_png_chunk('tEXt', "a\0b") . substr($good, 33)]), 'bad_png'],
    ];
    foreach ($bad as $why => [$blob, $code]) {
        [$c, $r] = api('unit_put', [], ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'unit' => 't1.z1.c0.y0.x0'], $blob);
        check("unit_put refuses: $why", $c === 400 && $r['error'] === $code, json_encode($r));
    }
    [$c, $r] = api('unit_put', [], ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'unit' => 't9.z0.c0.y0.x0'], pack('V', 0));
    check('unit_put refuses a unit outside the plan', $c === 400 && $r['error'] === 'bad_unit');
    [$c, $r] = api('unit_put', [], ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'unit' => 't0.z0.c0.y0.x0'], str_repeat("\0", LUMEN_MIG_MAX_BODY + 1));
    check('unit_put refuses a body over 32 MiB', $c === 413);
    // An all-zero PNG is accepted and never stored.
    $zeroUnit = $plan['units'][count($plan['units']) - 1];
    [$tr, , , $z0, $depth] = lumen_mig_unit_geometry($planL, lumen_mig_parse_key($zeroUnit));
    [, $wz, $hz] = lumen_mig_unit_geometry($planL, lumen_mig_parse_key($zeroUnit));
    [$c] = api('unit_put', [], ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'unit' => $zeroUnit],
               blob_of([$z0 => lumen_mig_png_encode(str_repeat("\0", $wz * $hz), $wz, $hz)]));
    [$ut, , $uc, $uty, $utx] = lumen_mig_parse_key($zeroUnit);
    check('unit_put: an all-zero tile is accepted and dropped',
          $c === 200 && !is_file(lumen_mig_tile_path(lumen_mig_store_dir('live', 'synthL', 'm002-planes'), $ut, $z0, $uc, $uty, $utx)));

    do { [$c, $run] = api('unit_run', ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'maxSeconds' => 20]); } while ($c === 200 && $run['done'] < $run['total'] && $run['processed']);
    check('live unit_run: finishes the rest', $c === 200 && $run['done'] === 8, json_encode($run));
    // The zero-only upload of the last unit was the browser's; the server skips done units.
    // Re-do it properly through the browser path so the planes are right (a retry is harmless).
    [$tiles] = lumen_mig_process_unit($planL, lumen_mig_parse_key($zeroUnit));
    [$c] = api('unit_put', [], ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'unit' => $zeroUnit], blob_of($tiles));
    [$tiles] = lumen_mig_process_unit($planL, lumen_mig_parse_key($half[0]));
    [$c2] = api('unit_put', [], ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'unit' => $half[0]], blob_of($tiles));
    $j = journal('live', 'synthL');
    check('unit_put: a repeated unit is idempotent', $c === 200 && $c2 === 200 && count($j['done']) === 8 && $j['executors']['browser'] === count($half) + 1);

    // resumable finalize: a 0 s budget stops before any pack, the next call completes
    [$c, $fin] = api('finalize', ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'maxSeconds' => 0]);
    check('finalize: complete:false + assembly under a zero budget', $c === 200 && $fin['complete'] === false && $fin['assembly'] === ['planes' => 132, 'written' => 0], json_encode($fin));
    $j = journal('live', 'synthL');
    check('journal: assembling with producer + assembledAt', $j['state'] === 'assembling' && $j['producer'] === 'mixed' && isset($j['assembledAt']));
    [$c, $r] = api('unit_run', ['dataset' => 'live/synthL', 'migration' => 'm002-planes']);
    check('unit_run refused while assembling', $c === 409 && $r['error'] === 'job_not_running');
    [$c, $fin] = api('finalize', ['dataset' => 'live/synthL', 'migration' => 'm002-planes', 'maxSeconds' => 20]);
    check('finalize live: complete', $c === 200 && $fin['complete'] === true && $fin['formatVersion'] === 2, json_encode($fin));
    $sha = hash_file('sha256', "$dirLive/bricks/manifest.json");
    foreach ($volsLive as $t => $vol) {
        $errs = mig_verify_planes(sprintf('%s/planes/t%03d', $dirLive, $t), $vol, $t, $sha);
        check("planes live t$t: every tile equals the source voxels", !$errs, implode('; ', array_slice($errs, 0, 5)));
    }
    $pm = json_decode((string)file_get_contents("$dirLive/planes/t000/manifest.json"), true);
    check('planes live: producer mixed', $pm['producer'] === 'mixed');

    // ── Source change invalidates a job ────────────────────────────────────
    $vol2 = new MigVolume(70, 70, 10, 1, 5);
    $dirB = mig_build_dataset(LUMEN_DATA_WEB, '3d', 'synthB', [0 => $vol2]);
    api('plan', ['dataset' => '3d/synthB', 'migration' => 'm002-planes']);
    file_put_contents("$dirB/bricks/manifest.json", file_get_contents("$dirB/bricks/manifest.json") . "\n");
    [$c, $run] = api('unit_run', ['dataset' => '3d/synthB', 'migration' => 'm002-planes', 'maxSeconds' => 5]);
    $j = journal('3d', 'synthB');
    check('source change: job failed with source_changed', $c === 409 && $run['error'] === 'source_changed' && $j['state'] === 'failed' && $j['error'] === 'source_changed', json_encode([$run, $j]));
    [$c, $p] = api('plan', ['dataset' => '3d/synthB', 'migration' => 'm002-planes']);
    $j = journal('3d', 'synthB');
    check('source change: plan starts a fresh job', $c === 200 && $j['state'] === 'running' && $j['sourceManifests']['0'] === hash_file('sha256', "$dirB/bricks/manifest.json"));

    // ── bench + dry run + cancel ───────────────────────────────────────────
    [$c, $b] = api('bench', ['dataset' => '3d/synthA', 'units' => 3]);
    check('bench: 3 sample units, bytes in/out', $c === 200 && $b['units'] === 3 && count($b['sample']) === 3 && $b['bytesRead'] > 0 && $b['bytesWritten'] > 0 && $b['secondsPerUnit'] > 0, json_encode($b));
    [$c, $run] = api('unit_run', ['dataset' => '3d/synthB', 'migration' => 'm002-planes', 'maxSeconds' => 5, 'dry' => true]);
    $j = journal('3d', 'synthB');
    check('unit_run dry: nothing recorded', $c === 200 && count($run['processed']) > 0 && $j['done'] === []);
    [$c, $r] = api('cancel', ['dataset' => '3d/synthB', 'migration' => 'm002-planes']);
    check('cancel: journal, store and lock removed', $c === 200 && journal('3d', 'synthB') === null
        && !is_dir(lumen_mig_store_dir('3d', 'synthB', 'm002-planes')) && !is_file(lumen_mig_root() . '/3d__synthB__m002-planes.lock'));

    // ── Manifest decode within 128 MiB (chunks + brickToPack lifted out) ─────
    $man = ['brickSize' => 64, 'levels' => [['level' => 0, 'dimensions' => ['x' => 70, 'y' => 70, 'z' => 10],
                'chunks' => [['id' => '0_0_0', 'min' => [0, 0, 0], 'max' => [64, 64, 64], 'nonEmpty' => true]]]],
            'brickTransport' => ['encoding' => 'webp-lossless', 'brickToPack' => [
                'lod0/c0/x000_y000_z000.webp' => ['url' => 'lod0/c0/pack_00.bin', 'offset' => 5, 'length' => 7],
                '/lod0/c1/x001_y000_z000.webp' => ['url' => 'lod0/c1/pack_00.bin', 'offset' => 0, 'length' => 3],
                'lod1/c0/x000_y000_z000.webp' => ['url' => 'lod1/c0/pack_00.bin', 'offset' => 0, 'length' => 9]]],
            'note' => 'a "chunks": [1] lookalike inside a string'];
    foreach ([JSON_UNESCAPED_SLASHES, 0, JSON_PRETTY_PRINT] as $flags) {   // 0: PHP's own `\/` escaping
        [$dec, $maps] = lumen_mig_decode_manifest(json_encode($man, $flags));
        $marker = $dec['brickTransport']['brickToPack'] ?? null;
        check("decode_manifest (flags $flags): chunks dropped, LOD0 entries lifted, the rest intact",
            $dec['levels'][0]['chunks'] === [] && $dec['note'] === $man['note'] && is_string($marker)
            && $maps[$marker] === [[0, 0, 0, 0, 'lod0/c0/pack_00.bin', 5, 7], [1, 1, 0, 0, 'lod0/c1/pack_00.bin', 0, 3]],
            json_encode([$dec, $maps]));
    }
    $odd = $man;
    $odd['brickTransport']['brickToPack']['lod0/c0/x002_y000_z000.webp'] = ['url' => 'p.bin', 'nested' => ['x' => 1], 'offset' => 1, 'length' => 1];
    [$dec, $maps] = lumen_mig_decode_manifest(json_encode($odd));
    check('decode_manifest: an unexpected shape is decoded normally, not lifted',
        $maps === [] && count($dec['brickTransport']['brickToPack']) === 4);

    // ── Disk budget, lock key, deleted dataset ─────────────────────────────
    $huge = ['dir' => $dir3d, 'unitBytes' => ['t0.z0.c0.y0.x0' => intdiv(PHP_INT_MAX, 8)]];
    try { lumen_mig_check_disk($huge); $e507 = null; } catch (LumenMigError $e) { $e507 = $e; }
    check('plan: a job the disk cannot hold is refused (507 insufficient_disk)',
        $e507 !== null && $e507->status === 507 && $e507->codeName === 'insufficient_disk' && isset($e507->extra['neededBytes'], $e507->extra['freeBytes']));
    [$c, $r] = lumen_mig_handle('plan', [], ['dataset' => '3d/synthA', 'migration' => 'm002-planes']);
    check('plan: the disk check lets a small job through', $c === 200 || ($r['error'] ?? '') === 'not_applicable', json_encode($r));
    check('resolve: the metadata lock key is the one datasets.php takes',
        lumen_mig_resolve('3d/synthA')[2] === admin_safe_dataset('3d/synthA')[2]);
    $volC = new MigVolume(70, 70, 10, 1, 9);
    $dirC = mig_build_dataset(LUMEN_DATA_WEB, '3d', 'synthC', [0 => $volC]);
    api('plan', ['dataset' => '3d/synthC', 'migration' => 'm002-planes']);
    api('unit_run', ['dataset' => '3d/synthC', 'migration' => 'm002-planes', 'maxSeconds' => 5]);
    mig_rrmdir($dirC);
    [$c1] = api('finalize', ['dataset' => '3d/synthC', 'migration' => 'm002-planes']);
    [$c2] = api('cancel', ['dataset' => '3d/synthC', 'migration' => 'm002-planes']);
    check('deleted dataset: finalize 404, cancel still drops journal and tiles, folder not re-created',
        $c1 === 404 && $c2 === 200 && journal('3d', 'synthC') === null
        && !is_dir(lumen_mig_store_dir('3d', 'synthC', 'm002-planes')) && !is_dir($dirC));

    // ── Request shape ──────────────────────────────────────────────────────
    [$c, $r] = api('plan', ['dataset' => '3d/../3d/synthA', 'migration' => 'm002-planes']);
    check('plan refuses a traversal id', $c === 400 && $r['error'] === 'bad_dataset');
    [$c] = api('plan', ['dataset' => '2d/photo', 'migration' => 'm002-planes']);
    check('plan refuses a 2d dataset', $c === 409);
    [$c, $r] = api('plan', ['dataset' => '3d/synthA', 'migration' => 'm999']);
    check('plan refuses an unknown migration', $c === 400 && $r['error'] === 'unknown_migration');
    $src = (string)file_get_contents(__DIR__ . '/../api/migrations.php');
    check('endpoint: session released after auth, before dispatch',
        strpos($src, 'admin_session_start();') < strpos($src, 'session_write_close();') && strpos($src, 'session_write_close();') < strpos($src, 'switch ($action)'));
    check('endpoint: every write action is POST + CSRF', LUMEN_MIG_WRITE_ACTIONS === ['plan', 'unit_put', 'unit_run', 'finalize', 'cancel', 'bench']
        && strpos($src, "in_array(\$action, LUMEN_MIG_WRITE_ACTIONS, true)") !== false && strpos($src, '$csrfOk') !== false);
} catch (Throwable $e) {
    check('no exception', false, get_class($e) . ': ' . $e->getMessage() . ' @' . $e->getFile() . ':' . $e->getLine());
} finally {
    mig_rrmdir($root);
}

echo $fails ? "FAILED ($fails)\n" : "OK\n";
exit($fails ? 1 : 0);
