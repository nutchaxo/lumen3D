<?php
/**
 * Lumen3D — format 6 and the migration m006-q30 (PHP twin, SPEC §15).
 * ====================================================================
 * Twin of the "Format 6 — m006-q30" section of dataset_migrations.py. A format-5 tree keeps
 * its `ll` column, its stores and its levels; its four other columns are replaced by one,
 * `q30` (WebP lossy at quality 30 + dead-zone trailer τ, or the `ll` image + 0xFF). A PHP host
 * has no lossy WebP encoder worth matching: the browser encodes every unit from what
 * `unit_inputs` names (the `ll` bricks of one 4×4×4 super-block) and posts it through
 * `unit_put`; this file plans the units, checks and stores what comes back, and assembles the
 * tree IN PLACE at finalize, byte for byte the Python assembly of the same store: the q30
 * packs and index beside the format-5 columns, the v6 manifest (the commit point), then the
 * format-5 columns deleted, planes/ and mips/ re-stamped, metadata bumped to 6.
 *
 * Units (key → tuple [t, k, c, BZ, BY, BX]): t{t}.k{k}.c{c}.z{BZ}.y{BY}.x{BX}; empty iff no `ll`
 * brick of the super-block is stored; every unit runnable at once; coarsest level first.
 *
 * Included by _migrations_lib.php (leading underscore ⇒ denied over HTTP).
 */
declare(strict_types=1);

const LUMEN_M006 = 'm006-q30';
const LUMEN_M006_DROPPED = ['b2', 'b4', 'q80', 'q50'];
// q30 bytes per byte of the ll bricks it is made from (dataset_migrations.M006_SIZE_RATIO).
const LUMEN_M006_SIZE_RATIO = 0.35;

function lumen_m006_key(array $u): string {
    return vsprintf('t%d.k%d.c%d.z%d.y%d.x%d', $u);
}

function lumen_m006_parse($key): array {
    if (!is_string($key) || !preg_match('/^t(\d{1,6})\.k(\d{1,2})\.c(\d{1,3})\.z(\d{1,5})\.y(\d{1,5})\.x(\d{1,5})$/D', $key, $m)) {
        throw new LumenMigError('bad_unit');
    }
    return array_map('intval', array_slice($m, 1));
}

/** [blob, parsed] of a tree's index/ll.bin, cached per request. */
function lumen_m006_tree_index(array $plan, array $tree): array {
    static $cache = [];
    $ck = $plan['dir'] . '|' . $plan['sig'] . '|' . $tree['t'];
    if (!isset($cache[$ck])) {
        $p = "{$tree['bricksDir']}/" . lumen_v5_index_rel('ll');
        $blob = is_file($p) ? @file_get_contents($p) : false;
        if (!is_string($blob)) throw new LumenMigError('bricks_v5_invalid', 409, 'index/ll.bin unreadable');
        try {
            $cache = [$ck => [$blob, lumen_v3_parse_index($blob)]] + array_slice($cache, 0, 7, true);
        } catch (InvalidArgumentException $e) {
            throw new LumenMigError('bricks_v5_invalid', 409, $e->getMessage());
        }
    }
    return $cache[$ck];
}

/** The plan's bricks manifest, decoded (assoc), cached per request. */
function lumen_m006_manifest_levels(array $plan): array {
    static $cache = [];
    $ck = $plan['dir'] . '|' . $plan['sig'];
    if (!isset($cache[$ck])) {
        $man = admin_read_json($plan['manifestPath']);
        $levels = is_array($man) && is_array($man['levels'] ?? null) ? $man['levels'] : [];
        $cache = [$ck => $levels];
    }
    return $cache[$ck];
}

/** Every unit of m006 (dataset_migrations._m006_unitset). */
function lumen_m006_unitset(array $plan): array {
    static $cache = [];
    $ck = $plan['dir'] . '|' . $plan['sig'];
    if (isset($cache[$ck])) return $cache[$ck];
    if (!empty($plan['v6'])) throw new LumenMigError('already_v6', 409);
    if (empty($plan['v5'])) throw new LumenMigError('needs_format5', 409);
    if ($plan['v5Problem'] !== null) throw new LumenMigError('bricks_v5_invalid', 409, $plan['v5Problem']);
    $levels = lumen_m006_manifest_levels($plan);
    $ts = array_keys($plan['trees']);
    sort($ts);
    $rows = []; $unitBytes = []; $total = 0;
    foreach ($ts as $t) {
        $tree = $plan['trees'][$t];
        [$blob, $idx] = lumen_m006_tree_index($plan, $tree);
        foreach ($idx['levels'] as $k => [$gx, $gy, $gz]) {
            $n = $gx * $gy * $gz;
            $sx = intdiv($gx + 3, 4); $sy = intdiv($gy + 3, 4); $sz = intdiv($gz + 3, 4);
            for ($c = 0; $c < $tree['C']; $c++) {
                $total += $sx * $sy * $sz;
                $at = $idx['entriesAt'][$k] + $c * $n * LUMEN_V3_INDEX_ENTRY;
                $sums = [];
                for ($i = 0; $i < $n; $i++) {
                    $l = unpack('V', $blob, $at + LUMEN_V3_INDEX_ENTRY * $i + 6)[1];
                    if (!$l) continue;
                    $bx = $i % $gx; $r = intdiv($i, $gx); $by = $r % $gy; $bz = intdiv($r, $gy);
                    $s = (intdiv($bz, 4) * $sy + intdiv($by, 4)) * $sx + intdiv($bx, 4);
                    $sums[$s] = ($sums[$s] ?? 0) + $l;
                }
                foreach ($sums as $s => $bytes) {
                    $BX = $s % $sx; $r = intdiv($s, $sx); $BY = $r % $sy; $BZ = intdiv($r, $sy);
                    $u = [$t, $k, $c, $BZ, $BY, $BX];
                    $rows[] = $u;
                    $unitBytes[lumen_m006_key($u)] = $bytes;
                }
            }
        }
    }
    // Coarsest level first: the light levels are converted (and visible) early.
    usort($rows, fn($a, $b) => [-$a[1], $a[0], $a[2], $a[3], $a[4], $a[5]] <=> [-$b[1], $b[0], $b[2], $b[3], $b[4], $b[5]]);
    $units = [];
    foreach ($rows as $u) $units[lumen_m006_key($u)] = $u;
    $us = ['mid' => LUMEN_M006, 'units' => $units, 'unitBytes' => $unitBytes, 'total' => $total,
           'empty' => $total - count($units), 'inputs' => [], 'refs' => null, 'levels' => $levels];
    $cache = [$ck => $us];
    return $us;
}

/** [[bz, by, bx, path, offset, length]] of the unit's stored `ll` bricks, (bz, by, bx) order. */
function lumen_m006_bricks(array $plan, array $us, array $unit): array {
    [$t, $k, $c, $BZ, $BY, $BX] = $unit;
    $tree = $plan['trees'][$t] ?? null;
    if ($tree === null || $c >= $tree['C'] || $k >= count($us['levels'])) throw new LumenMigError('bad_unit');
    [$blob, $idx] = lumen_m006_tree_index($plan, $tree);
    if (!isset($idx['levels'][$k])) throw new LumenMigError('bad_unit');
    [$gx, $gy, $gz] = $idx['levels'][$k];
    $at = $idx['entriesAt'][$k] + $c * $gx * $gy * $gz * LUMEN_V3_INDEX_ENTRY;
    $out = [];
    for ($bz = 4 * $BZ; $bz < min($gz, 4 * $BZ + 4); $bz++) {
        for ($by = 4 * $BY; $by < min($gy, 4 * $BY + 4); $by++) {
            for ($bx = 4 * $BX; $bx < min($gx, 4 * $BX + 4); $bx++) {
                $e = unpack('vp/Vo/Vl', $blob, $at + LUMEN_V3_INDEX_ENTRY * (($bz * $gy + $by) * $gx + $bx));
                if ($e['l']) $out[] = [$bz, $by, $bx, "{$tree['bricksDir']}/" . lumen_v5_brick_pack_rel($k, 'll', $c, $e['p']), $e['o'], $e['l']];
            }
        }
    }
    return $out;
}

function lumen_m006_store_path(string $store, array $unit): string {
    [$t, $k, $c, $BZ, $BY, $BX] = $unit;
    return "$store/t$t/k$k/c$c/z$BZ.y$BY.x$BX.bin";
}

function lumen_m006_entries_path(string $store, int $t, int $k, int $c): string {
    return "$store/entries/t$t.k$k.c$c.bin";
}

/** What a browser m006 unit reads (dataset_migrations._unit_inputs_m006). */
function lumen_m006_unit_inputs(array $plan, $key): array {
    $us = lumen_mig_unitset($plan, LUMEN_M006);
    $unit = lumen_m006_parse($key);
    [$t, $k, $c] = $unit;
    $tree = $plan['trees'][$t] ?? null;
    if ($tree === null || $c >= $tree['C'] || $k >= count($us['levels'])) throw new LumenMigError('bad_unit');
    $ukey = lumen_m006_key($unit);
    if (!isset($us['unitBytes'][$ukey])) return ['ok' => true, 'migration' => LUMEN_M006, 'unit' => $ukey, 'empty' => true];
    $dsLen = strlen($plan['dir']);
    $bricks = [];
    foreach (lumen_m006_bricks($plan, $us, $unit) as [$bz, $by, $bx, $p, $o, $ln]) {
        $bricks[] = ['rel' => ltrim(str_replace('\\', '/', substr($p, $dsLen)), '/'), 'start' => $o, 'end' => $o + $ln,
                     'bz' => $bz, 'by' => $by, 'bx' => $bx];
    }
    return ['ok' => true, 'migration' => LUMEN_M006, 'unit' => $ukey, 'empty' => false,
            'tree' => $tree['rel'], 't' => $t, 'level' => $k, 'channel' => $c, 'bricks' => $bricks];
}

/** A stored q30 image (SPEC §15.2): lossy 720×640 + τ ≤ 12, or the ll image + 0xFF (dataset_migrations._m006_check_q30). */
function lumen_m006_check_q30(string $data): void {
    if (strlen($data) < 2) throw new InvalidArgumentException('no trailer byte');
    $tag = ord($data[strlen($data) - 1]);
    [$w, $h, $lossless] = lumen_v5_webp_size(substr($data, 0, -1));
    if ($tag === LUMEN_V5_TAG_LL) {
        if ([$w, $h, $lossless] !== [LUMEN_V3_MOSAIC_W, LUMEN_V3_MOSAIC_H, true]) throw new InvalidArgumentException("fallback image {$w}x{$h}");
    } elseif ($tag <= LUMEN_V5_DEAD_ZONE_MAX) {
        if ([$w, $h] !== [LUMEN_V5_MOSAIC80_W, LUMEN_V5_MOSAIC80_H] || $lossless) throw new InvalidArgumentException("lossy image {$w}x{$h}");
    } else {
        throw new InvalidArgumentException("trailer byte $tag");
    }
}

/** The body, checked (bad_blob): exactly the super-block's stored ll bricks, each a q30 image. */
function lumen_m006_validate_put(array $plan, array $us, array $unit, string $body): string {
    try {
        $bricks = lumen_m005_parse_brick_blob($body, ['q30']);
    } catch (InvalidArgumentException | ValueError $e) {
        throw new LumenMigError('bad_blob', 400, 'm006 blob: ' . $e->getMessage());
    }
    $want = [];
    foreach (lumen_m006_bricks($plan, $us, $unit) as [$bz, $by, $bx]) $want["$bz.$by.$bx"] = true;
    $have = array_keys($bricks);
    $wk = array_keys($want);
    sort($have, SORT_STRING); sort($wk, SORT_STRING);
    if ($have !== $wk) throw new LumenMigError('bad_blob', 400, count($bricks) . ' brick(s), the super-block holds ' . count($want));
    try {
        foreach ($bricks as $per) lumen_m006_check_q30($per['q30']);
    } catch (InvalidArgumentException | ValueError $e) {
        throw new LumenMigError('bad_blob', 400, $e->getMessage());
    }
    return $body;
}

function lumen_m006_store(string $store, array $unit, string $body): void {
    if (!lumen_write_file_atomic(lumen_m006_store_path($store, $unit), $body)) throw new LumenMigError('store_write_failed', 500);
}

function lumen_m006_unit_put(array $plan, array $m, string $path, $key, string $body): array {
    $us = lumen_mig_unitset($plan, LUMEN_M006);
    $unit = lumen_m006_parse($key);
    $ukey = lumen_m006_key($unit);
    if (!isset($us['unitBytes'][$ukey])) throw new LumenMigError('empty_unit', 409);
    $j = lumen_mig_load_journal($path);
    if ($j === null) throw new LumenMigError('no_job', 404);
    lumen_mig_check_source($plan, $j, $path, false);
    if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
    lumen_m006_store(lumen_mig_store_dir($plan['type'], $plan['folder'], LUMEN_M006), $unit, lumen_m006_validate_put($plan, $us, $unit, $body));
    unset($body);
    $j = lumen_mig_mark_done($plan, $m, $path, [$ukey], 'browser');
    $sm = lumen_mig_summary($j);
    return ['ok' => true, 'done' => $sm['done'], 'total' => $sm['total']];
}

/** Several m006 unit results, journaled at once (dataset_migrations.unit_put_many, m006 branch). */
function lumen_m006_unit_put_many(array $plan, array $m, string $path, string $body): array {
    $entries = lumen_m005_parse_put_many($body);
    unset($body);
    $us = lumen_mig_unitset($plan, LUMEN_M006);
    $j = lumen_mig_load_journal($path);
    if ($j === null) throw new LumenMigError('no_job', 404);
    lumen_mig_check_source($plan, $j, $path, false);
    if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
    $store = lumen_mig_store_dir($plan['type'], $plan['folder'], LUMEN_M006);
    $results = []; $accepted = [];
    foreach ($entries as $i => [$key, $data]) {
        $entries[$i] = null;
        try {
            $unit = lumen_m006_parse($key);
            $ukey = lumen_m006_key($unit);
            if (!isset($us['unitBytes'][$ukey])) throw new LumenMigError('empty_unit', 409);
            lumen_m006_store($store, $unit, lumen_m006_validate_put($plan, $us, $unit, $data));
            $accepted[] = $ukey;
            $results[] = ['ok' => true, 'unit' => $key];
        } catch (LumenMigError $e) {
            $results[] = lumen_m005_unit_error($key, $e);
        }
        unset($data);
    }
    if ($accepted) $j = lumen_mig_mark_done($plan, $m, $path, $accepted, 'browser');
    $sm = lumen_mig_summary($j);
    return ['ok' => true, 'results' => $results, 'done' => $sm['done'], 'total' => $sm['total']];
}

// ── m006 finalize (dataset_migrations._finalize_m006) ────────────────────────

/** Deletes columns $cids (index/{cid}.bin and l{k}/{cid}/) of every tree of the plan. */
function lumen_m006_drop_columns(array $plan, array $cids): void {
    foreach ($plan['trees'] as $tree) {
        $dir = $tree['bricksDir'];
        foreach ($cids as $cid) {
            $p = "$dir/" . lumen_v5_index_rel($cid);
            if (is_file($p)) @unlink($p);
            foreach (glob("$dir/l*", GLOB_ONLYDIR) ?: [] as $lv) {
                if (preg_match('/^l\d{1,2}$/D', basename($lv))) lumen_mig_rrmdir("$lv/$cid");
            }
        }
    }
}

/**
 * The v6 manifest of the plan's v5 one (dataset_migrations._m006_manifest): the same levels,
 * stores, `ll` index and cut indexes; columns ll + q30; bytes {ll, q30}. Decoded as objects so
 * every {} of the source stays an object. $refs[t] = [bytes, sha256] of index/q30.bin;
 * $nbytes[t][k] = per-channel q30 bytes.
 */
function lumen_m006_manifest(array $plan, array $refs, array $nbytes, string $producer): object {
    $doc = json_decode((string)@file_get_contents($plan['manifestPath']));
    if (!is_object($doc)) throw new LumenMigError('manifest_invalid', 409);
    $doc->schema = LUMEN_V6_SCHEMA;
    $doc->version = 6;
    $doc->formatVersion = 6;
    $doc->columns = lumen_v5_manifest_columns(6);
    $doc->producer = $producer;
    $doc->migratedAt = lumen_mig_now();
    $fix = function (object $indexDoc, string $rel, int $t, $bytesDoc) use ($refs, $nbytes): object {
        $cols = is_object($indexDoc->columns ?? null) ? $indexDoc->columns : new stdClass();
        $pre = $rel === '' ? '' : "$rel/";
        $indexDoc->columns = (object)['ll' => $cols->ll ?? null,
                                      'q30' => (object)(['url' => $pre . lumen_v5_index_rel('q30')] + $refs[$t])];
        $out = new stdClass();
        foreach (is_object($bytesDoc) ? get_object_vars($bytesDoc) : [] as $kk => $perCol) {
            $ll = is_object($perCol) ? ($perCol->ll ?? null) : null;
            $out->{(string)$kk} = (object)['ll' => $ll, 'q30' => $nbytes[$t][(int)$kk] ?? array_fill(0, is_array($ll) ? count($ll) : 0, 0)];
        }
        return $out;
    };
    $tps = $doc->timepoints ?? null;
    if (is_array($tps) && $tps) {
        $byRel = [];
        foreach ($plan['trees'] as $t => $tree) $byRel[$tree['rel']] = $t;
        $worst = [];
        foreach ($tps as $row) {
            $t = $byRel[$row->path];
            $row->bytes = $fix($row->index, $row->path, $t, $row->bytes ?? null);
            foreach (get_object_vars($row->bytes) as $kk => $perCol) {
                foreach (get_object_vars($perCol) as $cid => $perC) {
                    $perC = is_array($perC) ? $perC : [];
                    $cur = $worst[$kk][$cid] ?? array_fill(0, count($perC), 0);
                    $nn = min(count($cur), count($perC));
                    $m = [];
                    for ($i = 0; $i < $nn; $i++) $m[] = max($cur[$i], $perC[$i]);
                    $worst[$kk][$cid] = $m;
                }
            }
        }
        $o = new stdClass();
        foreach ($worst as $kk => $perCol) $o->{(string)$kk} = (object)$perCol;
        $doc->bytes = $o;
    } else {
        $ts = array_keys($plan['trees']);
        $doc->bytes = $fix($doc->index, '', min($ts), $doc->bytes ?? null);
    }
    return $doc;
}

/**
 * Write the q30 packs and index of every tree in place, then the v6 manifest (commit), then
 * delete the format-5 columns, re-stamp planes/ and mips/, bump to 6. Re-entrant; a deadline
 * pauses the pack step (`complete: false`).
 */
function lumen_m006_finalize(array $m, $datasetId, float $deadline): array {
    [$type, $folder, $ds] = lumen_mig_resolve($datasetId);
    $path = lumen_mig_journal_path($type, $folder, LUMEN_M006);
    $base = lumen_mig_job_base($type, $folder, LUMEN_M006);
    $store = lumen_mig_store_dir($type, $folder, LUMEN_M006);
    return lumen_mig_with_job_lock($base, function () use ($m, $datasetId, $ds, $path, $deadline, $store) {
        $j = lumen_mig_load_journal($path);
        $plan = lumen_mig_plan_for($datasetId);
        if ($j === null) {
            if (in_array($plan['type'], $m['types'], true) && !empty($plan['v6']) && $plan['v5Problem'] === null) {
                lumen_m006_drop_columns($plan, LUMEN_M006_DROPPED);
                $fv = lumen_mig_bump_metadata($ds, $m['to']);
                return ['ok' => true, 'complete' => true, 'formatVersion' => $fv];
            }
            throw new LumenMigError('no_job', 404);
        }
        $state = $j['state'] ?? null;
        if ($state === 'assembling' && !empty($plan['v6'])) $state = 'swapped';
        if ($state === 'running' || $state === 'assembling') lumen_mig_check_source($plan, $j, $path);
        if ($state === 'running') {
            $us = lumen_mig_unitset($plan, LUMEN_M006);
            $done = array_flip($j['done'] ?? []);
            $missing = 0;
            foreach ($us['units'] as $k => $_u) if (!isset($done[$k])) $missing++;
            if ($missing) throw new LumenMigError('units_pending', 409, "$missing unit(s) not done");
            lumen_m006_drop_columns($plan, ['q30']);
            lumen_mig_rrmdir("$store/entries");
            $j['state'] = 'assembling';
            $j['producer'] = lumen_mig_producer($j);
            $j['assembledAt'] = lumen_mig_now();
            lumen_mig_save_journal($path, $j);
            $state = 'assembling';
        }
        if ($state === 'assembling') {
            $us = lumen_mig_unitset($plan, LUMEN_M006);
            $ts = array_keys($plan['trees']);
            sort($ts);
            $steps = [];
            foreach ($ts as $t) for ($k = 0, $nl = count($us['levels']); $k < $nl; $k++) for ($c = 0; $c < $plan['trees'][$t]['C']; $c++) $steps[] = [$t, $k, $c];
            $doneN = 0; $wrote = false;
            foreach ($steps as [$t, $k, $c]) {
                $marker = lumen_m006_entries_path($store, $t, $k, $c);
                clearstatcache(true, $marker);
                if (is_file($marker)) { $doneN++; continue; }
                if ($wrote && microtime(true) > $deadline) {
                    $j['assembly'] = ['steps' => count($steps), 'written' => $doneN];
                    lumen_mig_save_journal($path, $j);
                    return ['ok' => true, 'complete' => false, 'assembly' => $j['assembly']];
                }
                $tree = $plan['trees'][$t];
                [, $idx] = lumen_m006_tree_index($plan, $tree);
                [$gx, $gy, $gz] = $idx['levels'][$k];
                $ents = [];
                $dir = $tree['bricksDir'];
                $writer = new LumenV5PackWriter(fn($pk) => "$dir/" . lumen_v5_brick_pack_rel($k, 'q30', $c, $pk));
                try {
                    for ($BZ = 0; $BZ < intdiv($gz + 3, 4); $BZ++) for ($BY = 0; $BY < intdiv($gy + 3, 4); $BY++) for ($BX = 0; $BX < intdiv($gx + 3, 4); $BX++) {
                        $u = [$t, $k, $c, $BZ, $BY, $BX];
                        if (!isset($us['unitBytes'][lumen_m006_key($u)])) continue;
                        $blob = @file_get_contents(lumen_m006_store_path($store, $u));
                        if (!is_string($blob)) throw new LumenMigError('bad_tile', 500, 'm006 unit ' . lumen_m006_key($u) . ' missing from the store');
                        try {
                            $bricks = lumen_m005_parse_brick_blob($blob, ['q30']);
                        } catch (InvalidArgumentException $e) {
                            throw new LumenMigError('bad_tile', 500, 'm006 blob: ' . $e->getMessage());
                        }
                        unset($blob);
                        uasort($bricks, fn($x, $y) => $x['key'] <=> $y['key']);
                        $placed = $writer->addGroup(array_values(array_map(fn($r) => $r['q30'], $bricks)));
                        $i = 0;
                        foreach ($bricks as $r) {
                            [$bz, $by, $bx] = $r['key'];
                            $ents[($bz * $gy + $by) * $gx + $bx] = $placed[$i++];
                        }
                    }
                } finally {
                    $writer->close();
                }
                $s = pack('V', $writer->index + 1);
                for ($i = 0, $n = $gx * $gy * $gz; $i < $n; $i++) {
                    $e = $ents[$i] ?? null;
                    $s .= $e === null ? "\0\0\0\0\0\0\0\0\0\0" : pack('vVV', $e[0], $e[1], $e[2]);
                }
                if (!lumen_write_file_atomic($marker, $s)) throw new LumenMigError('assembly_write_failed', 500, $marker);
                $doneN++;
                $wrote = true;
            }
            // Indexes, then the manifest (the commit point).
            $refs = []; $nbytes = [];
            foreach ($ts as $t) {
                $tree = $plan['trees'][$t];
                [, $idx] = lumen_m006_tree_index($plan, $tree);
                $levelsRows = []; $entries = []; $nbytes[$t] = [];
                foreach ($idx['levels'] as $k => [$gx, $gy, $gz]) {
                    $npacks = 0; $per = []; $perB = [];
                    for ($c = 0; $c < $tree['C']; $c++) {
                        $raw = (string)@file_get_contents(lumen_m006_entries_path($store, $t, $k, $c));
                        if (strlen($raw) !== 4 + $gx * $gy * $gz * LUMEN_V3_INDEX_ENTRY) throw new LumenMigError('assembly_invalid', 500, "entries t$t k$k c$c");
                        $npacks += unpack('V', $raw, 0)[1];
                        $per[$c] = substr($raw, 4);
                        $perB[] = lumen_v5_entries_stats($per[$c])[1];
                    }
                    $nbytes[$t][$k] = $perB;
                    $levelsRows[] = [$gx, $gy, $gz, $npacks];
                    $entries[] = $per;
                }
                $blob = lumen_v5_index_bytes($levelsRows, $tree['C'], $entries);
                if (!lumen_write_file_atomic("{$tree['bricksDir']}/" . lumen_v5_index_rel('q30'), $blob)) throw new LumenMigError('assembly_write_failed', 500);
                $refs[$t] = ['bytes' => strlen($blob), 'sha256' => hash('sha256', $blob)];
            }
            $doc = lumen_m006_manifest($plan, $refs, $nbytes, (string)($j['producer'] ?? lumen_mig_producer($j)));
            $bytes = json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
            if ($bytes === false) throw new LumenMigError('assembly_write_failed', 500, 'manifest json');
            $assoc = json_decode($bytes, true);
            foreach (lumen_v5_tree_rels($assoc) as $rel) {
                $problem = lumen_v5_tree_problem("$ds/bricks", $assoc, is_string($rel) ? $rel : '');
                if ($problem !== null) throw new LumenMigError('assembly_invalid', 500, $problem);
            }
            lumen_mig_check_source($plan, $j, $path);
            $j['oldManifestSha'] = $plan['sha'];
            lumen_mig_save_journal($path, $j);
            if (!lumen_write_file_atomic("$ds/bricks/manifest.json", $bytes)) throw new LumenMigError('assembly_write_failed', 500);
            $j['state'] = 'swapped';
            unset($j['assembly']);
            lumen_mig_save_journal($path, $j);
            $state = 'swapped';
        }
        if ($state === 'swapped') {
            $plan = lumen_mig_plan_for($datasetId);
            if (empty($plan['v6']) || $plan['v5Problem'] !== null) {
                $j['state'] = 'failed';
                $j['error'] = 'assembly_invalid';
                lumen_mig_save_journal($path, $j);
                throw new LumenMigError('assembly_invalid', 500, $plan['v5Problem'] ?? 'not a v6 manifest');
            }
            lumen_m006_drop_columns($plan, LUMEN_M006_DROPPED);
            lumen_mig_restamp_derived($plan, $j['oldManifestSha'] ?? null);
            $fv = lumen_mig_bump_metadata($ds, $m['to']);
            lumen_mig_rrmdir($store);
            @unlink($path);
            return ['ok' => true, 'complete' => true, 'formatVersion' => $fv];
        }
        throw new LumenMigError('job_failed', 409, (string)($j['error'] ?? $state));
    });
}
