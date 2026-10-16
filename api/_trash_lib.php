<?php
/**
 * Lumen3D — dataset trash (PHP twin of dataset_trash.py)
 *
 * Deleting a published dataset MOVES its folder to uploads/trash/<trashId>/data and
 * writes uploads/trash/<trashId>/entry.json beside it. uploads/ is never web-served
 * and never touched by an update. Same layout, same entry.json, same rules as the
 * Python side, so a host can move between the two backends and keep its trash.
 *
 *  - trashId = <type>__<folder>__<UTC stamp>-<random>: unique per deletion, so the
 *    same dataset name can be deleted any number of times (delete, re-upload, delete
 *    again ...) and every copy stays in the trash side by side.
 *  - an entry is kept LUMEN_TRASH_RETENTION_DAYS days, then reclaimed (on every list).
 *  - restoring answers 409 `exists` + a free `suggested` folder when a dataset of that
 *    name exists meanwhile.
 *
 * Every function returns [HTTP status, JSON payload].
 */

declare(strict_types=1);

require_once __DIR__ . '/_admin_lib.php';
require_once __DIR__ . '/_upload_lib.php';

const LUMEN_TRASH_RETENTION_DAYS = 60;
const LUMEN_TRASH_ORPHAN_GRACE_S = 3600;

function lumen_trash_root(): string { return lumen_up_root() . '/trash'; }

function lumen_trash_safe_folder($folder): bool {
    return is_string($folder) && $folder !== '.' && $folder !== '..'
        && preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/D', $folder) === 1;
}

function lumen_trash_entry_dir($trashId): ?string {
    if (!is_string($trashId) || !preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/D', $trashId)) return null;
    return lumen_trash_root() . '/' . $trashId;
}

function lumen_trash_read_entry(string $edir): ?array {
    $p = $edir . '/entry.json';
    if (!is_file($p)) return null;
    $raw = @file_get_contents($p);
    $d = is_string($raw) ? json_decode($raw, true) : null;
    return is_array($d) ? $d : null;
}

function lumen_trash_write_entry(string $edir, array $entry): bool {
    $json = json_encode($entry, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    return $json !== false && lumen_write_file_atomic($edir . '/entry.json', $json);
}

function lumen_trash_tree_bytes(string $dir): ?int {
    if (!is_dir($dir)) return null;
    $total = 0;
    try {
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) { if ($f->isFile()) $total += (int)$f->getSize(); }
    } catch (Throwable $e) {
        return null;
    }
    return $total;
}

function lumen_trash_iso(int $ts): string { return gmdate('Y-m-d\TH:i:s\Z', $ts); }

function lumen_trash_parse_iso($v): ?int {
    if (!is_string($v)) return null;
    $d = DateTime::createFromFormat('Y-m-d\TH:i:s\Z', $v, new DateTimeZone('UTC'));
    return $d ? $d->getTimestamp() : null;
}

/** rename(), falling back to copy + remove when the two folders are on different volumes. */
function lumen_trash_move_dir(string $src, string $dst): bool {
    if (@rename($src, $dst)) return true;
    if (is_dir($dst)) return false;   // rename failed for a reason other than the volume
    if (!lumen_up_rcopy($src, $dst)) { lumen_up_rrmdir($dst); return false; }
    lumen_up_rrmdir($src);
    return !is_dir($src);
}

function lumen_trash_public(array $e, int $now): array {
    $exp = lumen_trash_parse_iso($e['expiresAt'] ?? null);
    $left = $exp === null ? null : max(0, (int)ceil(($exp - $now) / 86400));
    $out = [];
    foreach (['trashId', 'id', 'type', 'folder', 'name', 'stage', 'embryo', 'deletedAt', 'expiresAt', 'bytes'] as $k) {
        $out[$k] = $e[$k] ?? null;
    }
    $out['daysLeft'] = $left;
    return $out;
}

function lumen_trash_move(string $datasetId): array {
    $safe = admin_safe_dataset($datasetId);
    if ($safe === null) return [400, ['error' => 'Invalid dataset ID']];
    [$type, $folder] = $safe;
    $src = data_web() . '/' . $type . '/' . $folder;
    if (!is_dir($src) || is_link($src)) return [404, ['error' => 'Dataset not found']];

    $meta = lumen_read_json_doc($src . '/metadata.json') ?: [];
    $now = time();
    $trashId = $type . '__' . $folder . '__' . gmdate('Ymd\THis\Z', $now) . '-' . bin2hex(random_bytes(3));
    lumen_up_ensure_dirs();   // asserts uploads/.htaccess (deny-all) before anything lands there
    $edir = lumen_trash_root() . '/' . $trashId;
    if (!admin_make_dir($edir)) return [500, ['error' => 'trash_unavailable']];

    $entry = [
        'trashId'   => $trashId,
        'id'        => $type . '/' . $folder,
        'type'      => $type,
        'folder'    => $folder,
        'name'      => (isset($meta['name']) && is_string($meta['name']) && $meta['name'] !== '') ? $meta['name'] : $folder,
        'stage'     => (isset($meta['stage']) && is_string($meta['stage'])) ? $meta['stage'] : null,
        'embryo'    => (isset($meta['embryo']) && is_string($meta['embryo'])) ? $meta['embryo'] : null,
        'deletedAt' => lumen_trash_iso($now),
        'expiresAt' => lumen_trash_iso($now + LUMEN_TRASH_RETENTION_DAYS * 86400),
        'bytes'     => null,
    ];
    if (!lumen_trash_write_entry($edir, $entry) || !lumen_trash_move_dir($src, $edir . '/data')) {
        lumen_up_rrmdir($edir);
        return [409, ['error' => 'busy']];
    }
    $entry['bytes'] = lumen_trash_tree_bytes($edir . '/data');
    lumen_trash_write_entry($edir, $entry);
    return [200, ['ok' => true, 'trashId' => $trashId, 'expiresAt' => $entry['expiresAt']]];
}

/** Reclaim every entry past its expiry and every orphaned half entry. */
function lumen_trash_purge_expired(?int $now = null): array {
    $now = $now ?? time();
    $removed = [];
    $root = lumen_trash_root();
    if (!is_dir($root)) return $removed;
    foreach ((array)scandir($root) as $name) {
        if ($name === '.' || $name === '..') continue;
        $edir = lumen_trash_entry_dir($name);
        if ($edir === null || !is_dir($edir)) continue;
        $entry = lumen_trash_read_entry($edir);
        if ($entry === null || !is_dir($edir . '/data')) {
            $mt = @filemtime($edir);
            if ($mt !== false && $now - $mt > LUMEN_TRASH_ORPHAN_GRACE_S) {
                lumen_up_rrmdir($edir);
                $removed[] = $name;
            }
            continue;
        }
        $exp = lumen_trash_parse_iso($entry['expiresAt'] ?? null);
        if ($exp !== null && $exp <= $now) {
            lumen_up_rrmdir($edir);
            $removed[] = $name;
        }
    }
    return $removed;
}

function lumen_trash_list(): array {
    $now = time();
    try { lumen_trash_purge_expired($now); } catch (Throwable $e) { error_log('trash purge: ' . $e->getMessage()); }
    $rows = [];
    $root = lumen_trash_root();
    if (is_dir($root)) {
        foreach ((array)scandir($root) as $name) {
            if ($name === '.' || $name === '..') continue;
            $edir = lumen_trash_entry_dir($name);
            if ($edir === null || !is_dir($edir . '/data')) continue;
            $entry = lumen_trash_read_entry($edir);
            if ($entry === null || ($entry['trashId'] ?? null) !== $name) continue;
            $rows[] = lumen_trash_public($entry, $now);
        }
    }
    usort($rows, fn($a, $b) => strcmp((string)($b['deletedAt'] ?? ''), (string)($a['deletedAt'] ?? '')));
    return [200, ['entries' => $rows, 'retentionDays' => LUMEN_TRASH_RETENTION_DAYS]];
}

function lumen_trash_free_folder(string $type, string $folder): string {
    $cand = $folder . '-restored';
    $n = 2;
    while (file_exists(data_web() . '/' . $type . '/' . $cand)) { $cand = $folder . '-restored-' . $n; $n++; }
    return $cand;
}

function lumen_trash_restore($trashId, $folder = null): array {
    $edir = lumen_trash_entry_dir($trashId);
    $entry = ($edir !== null && is_dir($edir)) ? lumen_trash_read_entry($edir) : null;
    if ($entry === null || !is_dir($edir . '/data')) return [404, ['error' => 'Not in trash']];
    $type = $entry['type'] ?? null;
    $orig = $entry['folder'] ?? null;
    if (!in_array($type, LUMEN_DATASET_TYPES, true) || !lumen_trash_safe_folder($orig)) {
        return [500, ['error' => 'corrupt_entry']];
    }
    $target = $orig;
    if ($folder !== null && $folder !== '') {
        if (!lumen_trash_safe_folder($folder)) return [400, ['error' => 'Invalid folder name']];
        $target = $folder;
    }
    $base = data_web() . '/' . $type;
    $dest = $base . '/' . $target;
    if (file_exists($dest)) {
        return [409, ['error' => 'exists', 'folder' => $target, 'suggested' => lumen_trash_free_folder($type, $target)]];
    }
    admin_make_dir($base);
    if (!lumen_trash_move_dir($edir . '/data', $dest)) return [409, ['error' => 'busy']];

    $newId = $type . '/' . $target;
    $metaPath = $dest . '/metadata.json';
    lumen_with_lock($metaPath, function () use ($metaPath, $newId, $type) {
        $meta = lumen_read_json_doc($metaPath);
        if ($meta && (($meta['id'] ?? null) !== $newId || ($meta['type'] ?? null) !== $type)) {
            $meta['id'] = $newId;
            $meta['type'] = $type;
            lumen_write_json_doc($metaPath, $meta);
        }
    });
    lumen_up_rrmdir($edir);
    return [200, ['ok' => true, 'id' => $newId]];
}

function lumen_trash_purge($trashId): array {
    $edir = lumen_trash_entry_dir($trashId);
    if ($edir === null || !is_dir($edir)) return [404, ['error' => 'Not in trash']];
    lumen_up_rrmdir($edir);
    return is_dir($edir) ? [500, ['error' => 'purge_incomplete']] : [200, ['ok' => true]];
}

function lumen_trash_empty(): array {
    $count = 0;
    $root = lumen_trash_root();
    if (is_dir($root)) {
        foreach ((array)scandir($root) as $name) {
            if ($name === '.' || $name === '..') continue;
            $edir = lumen_trash_entry_dir($name);
            if ($edir === null || !is_dir($edir)) continue;
            lumen_up_rrmdir($edir);
            if (!is_dir($edir)) $count++;
        }
    }
    return [200, ['ok' => true, 'removed' => $count]];
}
