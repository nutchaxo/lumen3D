<?php
/**
 * Lumen3D — dataset integrity check-up (PHP twin of dataset_integrity.py)
 * ======================================================================
 * Read-only. Same finding codes and levels as the Python engine: missing pieces,
 * extra files, not the latest format, and for a staged dataset the import's own
 * validation. Reuses the validators of the import (_upload_lib.php) and of the
 * migrations (_migrations_lib.php), so a verdict here cannot disagree with them.
 */
declare(strict_types=1);

require_once __DIR__ . '/_migrations_lib.php';

const LUMEN_INT_MAX_LISTED = 20;
const LUMEN_INT_PIPELINE_TREES = ['bricks', 'planes', 'mips'];

function lumen_int_finding(string $level, string $code, $detail = null, ?array $files = null): array {
    $f = ['level' => $level, 'code' => $code];
    if ($detail !== null) $f['detail'] = substr((string)$detail, 0, 300);
    if ($files) $f['files'] = array_slice(array_values($files), 0, LUMEN_INT_MAX_LISTED);
    return $f;
}

function lumen_int_dir_bytes(string $dir): int {
    $total = 0;
    try {
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) if ($f->isFile()) $total += (int)@$f->getSize();
    } catch (Throwable $e) { /* unreadable subtree: size is informational */ }
    return $total;
}

function lumen_int_status(array $findings): string {
    $levels = array_column($findings, 'level');
    return in_array('error', $levels, true) ? 'error' : (in_array('warn', $levels, true) ? 'warn' : 'ok');
}

/** `code` / `code:detail` strings of the import validators → findings. */
function lumen_int_split_errors(array $codes): array {
    $out = [];
    foreach ($codes as $c) {
        $c = (string)$c;
        $p = strpos($c, ':');
        $out[] = $p === false ? lumen_int_finding('error', $c) : lumen_int_finding('error', substr($c, 0, $p), substr($c, $p + 1) ?: null);
    }
    return $out;
}

function lumen_int_gallery(string $dir, array $meta): array {
    $out = [];
    $listed = [];
    foreach ((is_array($meta['gallery'] ?? null) ? $meta['gallery'] : []) as $g) {
        if (is_array($g) && is_string($g['file'] ?? null)) $listed[$g['file']] = true;
    }
    $present = [];
    if (is_dir("$dir/gallery")) {
        foreach (scandir("$dir/gallery") ?: [] as $n) {
            if ($n !== '' && $n[0] !== '.' && is_file("$dir/gallery/$n")) $present[$n] = true;
        }
    }
    $missing = array_keys(array_diff_key($listed, $present)); sort($missing);
    $extra = array_keys(array_diff_key($present, $listed)); sort($extra);
    if ($missing) $out[] = lumen_int_finding('error', 'gallery_missing', null, $missing);
    if ($extra) $out[] = lumen_int_finding('warn', 'gallery_unlisted', null, $extra);
    return $out;
}

function lumen_int_tracking(string $dir, array $meta): array {
    $tracking = $meta['tracking'] ?? null;
    if (!is_array($tracking)) return [];
    $missing = [];
    foreach (['tracksPath', 'surfacePath'] as $key) {
        $v = $tracking[$key] ?? null;
        if (!is_string($v) || $v === '' || in_array('..', explode('/', $v), true) || preg_match('#^(https?:|/)#', $v)) continue;
        if (!is_file("$dir/$v") && !is_file("$dir/$v.gz")) $missing[] = $v;
    }
    return $missing ? [lumen_int_finding('error', 'tracking_file_missing', null, $missing)] : [];
}

function lumen_int_leftovers(string $dir): array {
    $out = [];
    $names = [];
    foreach (scandir($dir) ?: [] as $n) {
        if ($n === '.' || $n === '..') continue;
        if (substr($n, -9) === '.pre-swap' || substr($n, -11) === '.lumen-new' || $n === '.swap-in-progress') $names[] = $n;
    }
    sort($names);
    if ($names) $out[] = lumen_int_finding('warn', 'interrupted_swap', null, $names);
    if (is_dir("$dir/bricks.previous")) {
        $f = lumen_int_finding('info', 'previous_tree_kept', 'bricks.previous', ['bricks.previous']);
        $f['bytes'] = lumen_int_dir_bytes("$dir/bricks.previous");
        $out[] = $f;
    }
    return $out;
}

function lumen_int_unexpected(string $dir, string $type): array {
    $stray = [];
    foreach (LUMEN_INT_PIPELINE_TREES as $tree) {
        if (!is_dir("$dir/$tree")) continue;
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$dir/$tree", FilesystemIterator::SKIP_DOTS));
        foreach ($it as $file) {
            if (!$file->isFile()) continue;
            $rel = str_replace('\\', '/', substr($file->getPathname(), strlen($dir) + 1));
            $parts = explode('/', $rel);
            $hidden = false;
            foreach (array_slice($parts, 0, -1) as $seg) if ($seg !== '' && $seg[0] === '.') $hidden = true;
            if ($hidden || strncmp($file->getFilename(), '.lumen-tmp-', 11) === 0) continue;
            if (lumen_up_classify($type, $rel) === null) {
                $stray[] = $rel;
                if (count($stray) >= LUMEN_INT_MAX_LISTED) return $stray;
            }
        }
    }
    return $stray;
}

function lumen_int_check_published(string $type, string $folder): array {
    $dir = data_web() . "/$type/$folder";
    $row = ['id' => "$type/$folder", 'type' => $type, 'folder' => $folder, 'name' => $folder,
            'staged' => false, 'latest' => LUMEN_MIG_LATEST];
    if (!is_dir($dir)) {
        $row['status'] = 'error'; $row['findings'] = [lumen_int_finding('error', 'dataset_missing')];
        return $row;
    }
    $findings = [];
    $meta = [];
    if (!is_file("$dir/metadata.json")) {
        $findings[] = lumen_int_finding('error', 'missing_metadata');
    } else {
        $m = lumen_up_read_json("$dir/metadata.json");
        if ($m === null) {
            $findings[] = lumen_int_finding('error', 'metadata_not_json');
        } else {
            $meta = $m;
            if (is_string($meta['name'] ?? null) && $meta['name'] !== '') $row['name'] = $meta['name'];
            [$ok, $reason] = lumen_up_validate_metadata($meta, $type);
            if (!$ok) $findings[] = lumen_int_finding('error', $reason ?: 'metadata_invalid');
            if (($meta['type'] ?? null) !== $type || ($meta['id'] ?? null) !== "$type/$folder") {
                $findings[] = lumen_int_finding('error', 'metadata_identity',
                    'type=' . json_encode($meta['type'] ?? null) . ' id=' . json_encode($meta['id'] ?? null));
            }
        }
    }
    if (!is_file("$dir/thumbnail.webp")) $findings[] = lumen_int_finding('warn', 'missing_thumbnail');

    if (in_array($type, LUMEN_UP_VOLUME_TYPES, true)) {
        $st = lumen_mig_dataset_status($type, $folder, $dir);
        $row['format'] = ['version' => $st['formatVersion'] ?? null, 'schema' => $st['bricksSchema'] ?? null];
        if (!empty($st['problem'])) $findings[] = lumen_int_finding('error', (string)$st['problem'], $st['problemDetail'] ?? null);
        if (!empty($st['pending'])) {
            $findings[] = lumen_int_finding('warn', !empty($st['repair']) ? 'needs_repair' : 'not_latest_format', implode(',', $st['pending']));
        }
        $findings = array_merge($findings, lumen_int_split_errors(lumen_up_check_bricks($dir)));
        $stray = lumen_int_unexpected($dir, $type);
        if ($stray) $findings[] = lumen_int_finding('warn', 'unexpected_files', null, $stray);
    } else {
        $findings = array_merge($findings, lumen_int_split_errors(lumen_up_check_2d_files($dir)));
    }
    $findings = array_merge($findings, lumen_int_gallery($dir, $meta), lumen_int_tracking($dir, $meta), lumen_int_leftovers($dir));
    $row['status'] = lumen_int_status($findings);
    $row['findings'] = array_values($findings);
    return $row;
}

function lumen_int_check_staged(string $type, string $folder): array {
    $info = lumen_up_describe($type, $folder);
    $row = ['id' => "$type/$folder", 'type' => $type, 'folder' => $folder, 'name' => $folder,
            'staged' => true, 'latest' => LUMEN_MIG_LATEST];
    if (!$info) {
        $row['status'] = 'error'; $row['findings'] = [lumen_int_finding('error', 'not_staged')];
        return $row;
    }
    $row['name'] = $info['name'] ?? $folder;
    $row['state'] = $info['state'] ?? null;
    $v = lumen_up_validate_dataset($type, $folder);
    $findings = lumen_int_split_errors($v['errors'] ?? []);
    $detail = array_slice($v['warnings'] ?? [], 0, LUMEN_INT_MAX_LISTED);
    foreach ($findings as &$f) if (in_array($f['code'], ['incomplete_files', 'stray_files'], true)) $f['files'] = $detail;
    unset($f);
    if (($info['state'] ?? null) === LUMEN_UP_STATE_UPLOADING) {
        $findings = array_merge([lumen_int_finding('info', 'import_running')],
            array_values(array_filter($findings, fn($f) => $f['code'] !== 'incomplete_files')));
    }
    if (is_dir(data_web() . "/$type/$folder")) $findings[] = lumen_int_finding('warn', 'published_exists');
    $row['status'] = lumen_int_status($findings);
    $row['findings'] = array_values($findings);
    return $row;
}

function lumen_int_list(): array {
    $published = [];
    foreach (['3d', '2d', 'live'] as $type) {
        $base = data_web() . "/$type";
        if (!is_dir($base)) continue;
        $names = array_values(array_filter(@scandir($base) ?: [], fn($n) => $n !== '' && $n[0] !== '.'
            && preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/D', $n) && is_dir("$base/$n")));
        usort($names, fn($a, $b) => strcmp(strtolower($a), strtolower($b)));
        foreach ($names as $n) $published[] = ['id' => "$type/$n", 'type' => $type, 'folder' => $n, 'staged' => false];
    }
    $staged = [];
    foreach (lumen_up_list() as $info) {
        if (is_string($info['type'] ?? null) && is_string($info['folder'] ?? null)) {
            $staged[] = ['id' => $info['type'] . '/' . $info['folder'], 'type' => $info['type'], 'folder' => $info['folder'], 'staged' => true];
        }
    }
    return ['ok' => true, 'latest' => LUMEN_MIG_LATEST, 'datasets' => array_merge($published, $staged)];
}

function lumen_int_handle(string $action, array $params): array {
    if ($action === 'list') return [200, lumen_int_list()];
    if ($action === 'check') {
        $ds = (string)($params['dataset'] ?? '');
        $staged = strncmp($ds, 'staging:', 8) === 0;
        if ($staged) $ds = substr($ds, 8);
        if (!preg_match('#^(3d|2d|live)/([A-Za-z0-9_][A-Za-z0-9._-]*)$#D', $ds, $m)) return [400, ['error' => 'invalid_dataset']];
        [, $type, $folder] = $m;
        try {
            $r = $staged ? lumen_int_check_staged($type, $folder) : lumen_int_check_published($type, $folder);
            return [200, ['ok' => true, 'result' => $r]];
        } catch (Throwable $e) {
            return [200, ['ok' => true, 'result' => ['id' => "$type/$folder", 'type' => $type, 'folder' => $folder, 'name' => $folder,
                'staged' => $staged, 'latest' => LUMEN_MIG_LATEST, 'status' => 'error',
                'findings' => [lumen_int_finding('error', 'check_failed', get_class($e) . ': ' . $e->getMessage())]]]];
        }
    }
    return [400, ['error' => 'Unknown action']];
}
