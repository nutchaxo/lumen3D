<?php
/**
 * Lumen3D — dataset upload staging store (PHP twin of upload_staging.py)
 * =====================================================================
 * Byte-for-byte the same contract as the Python engine: the same closed path
 * allowlist, the same journal shape (so a store written by one backend resumes
 * under the other), the same tiering, the same validation and the same publish
 * semantics. Read upload_staging.py for the rationale — this file only restates
 * the rules in PHP, and every divergence would be a bug.
 *
 * Two PHP-specific hazards are handled here rather than in upload.php:
 *
 *   * **Session locking.** PHP's file-backed sessions hold an exclusive lock for
 *     the whole request, which would serialise the parallel chunk POSTs that the
 *     import relies on for throughput. upload.php calls session_write_close()
 *     the moment auth is decided — before any of this runs.
 *   * **Concurrent journal writes.** Several chunks of one dataset are in flight
 *     by design, and each acknowledges itself into the same journal file.
 *     Every read-modify-write goes through lumen_up_journal_locked() (flock,
 *     LOCK_EX) so an acknowledgement is never lost.
 *
 * This file is named with a leading underscore so api/.htaccess denies it over
 * HTTP (`^_[A-Za-z0-9_]+\.php$`) — it is an include, never an entry point.
 */
declare(strict_types=1);

require_once __DIR__ . '/_admin_lib.php';

const LUMEN_UP_DEFAULT_CHUNK = 8388608;      // 8 MiB
const LUMEN_UP_MAX_CHUNK     = 16777216;     // 16 MiB
const LUMEN_UP_MIN_CHUNK     = 262144;       // 256 KiB
const LUMEN_UP_STALE_AFTER   = 604800;       // 7 days
const LUMEN_UP_MAX_JSON      = 268435456;
const LUMEN_UP_MAX_FILES     = 200000;
const LUMEN_UP_MAX_DATASETS  = 200;
// Largest single file a plan accepts (a raw .ims original is tens of GB); also bounds
// the received-chunk bitmap a client-declared size can make us allocate. Twin of
// upload_staging.MAX_FILE_SIZE.
const LUMEN_UP_MAX_FILE_SIZE = 1099511627776;   // 1 TiB
// Free space a plan must leave on the staging volume (the same disk usually holds
// DATA_WEB, the credential and the logs). Twin of upload_staging.DISK_RESERVE_BYTES.
const LUMEN_UP_DISK_RESERVE  = 536870912;       // 512 MiB

const LUMEN_UP_TIER_CORE = 0, LUMEN_UP_TIER_PREVIEW = 1, LUMEN_UP_TIER_MID = 2,
      LUMEN_UP_TIER_FULL = 3, LUMEN_UP_TIER_EXTRA = 4;

const LUMEN_UP_STATE_UPLOADING = 'uploading';
const LUMEN_UP_STATE_EDITABLE  = 'editable';
const LUMEN_UP_STATE_STAGED    = 'staged';
const LUMEN_UP_STATE_STALLED   = 'stalled';

function lumen_up_root(): string     { return defined('LUMEN_UPLOADS_DIR') ? (string)LUMEN_UPLOADS_DIR : admin_root() . '/uploads'; }
function lumen_up_staging(): string  { return lumen_up_root() . '/staging'; }
function lumen_up_state(): string    { return lumen_up_root() . '/state'; }

/**
 * Largest chunk this host can actually accept in one POST.
 *
 * post_max_size caps the request body; exceeding it makes PHP discard the body
 * entirely (php://input reads empty) with no useful error, which would look like
 * a mysterious stall to the operator. Staying at 80% of the smaller of
 * post_max_size and a quarter of memory_limit leaves room for headers and for the
 * in-memory copy the hash check needs.
 */
function lumen_up_chunk_limit(): int {
    $post = lumen_up_ini_bytes(ini_get('post_max_size') ?: '8M');
    $mem  = lumen_up_ini_bytes(ini_get('memory_limit') ?: '128M');
    $cap  = LUMEN_UP_MAX_CHUNK;
    if ($post > 0) $cap = min($cap, (int)($post * 0.8));
    if ($mem  > 0) $cap = min($cap, (int)($mem / 4));
    return max(LUMEN_UP_MIN_CHUNK, min(LUMEN_UP_MAX_CHUNK, $cap));
}

function lumen_up_ini_bytes(string $v): int {
    $v = trim($v);
    if ($v === '' || $v === '-1') return 0;              // unlimited
    $unit = strtolower(substr($v, -1));
    $n = (int)$v;
    if ($unit === 'g') return $n * 1073741824;
    if ($unit === 'm') return $n * 1048576;
    if ($unit === 'k') return $n * 1024;
    return $n;
}

// ── Path shape ───────────────────────────────────────────────────────────────

// No markup format (xml, html, svg, xhtml): DATA_WEB is served from this origin,
// and a document there would run beside the admin session.
const LUMEN_UP_DOWNLOAD_EXT = ['ims','tif','tiff','png','jpg','jpeg','webp','gif',
                               'zip','txt','md','csv','json','pdf','gz','h5','hdf5'];

// Dataset roots — derived from the platform-wide vocabulary so this file cannot
// drift from datasets.php / downloads.php / admin_safe_dataset(). Only the volume
// types carry a brick pyramid; a '2d' dataset is one photograph whose display
// copies sit at the dataset root — the preview travels with the mount
// prerequisites, the native image follows (twin of upload_staging.ALLOWED_TYPE_DIRS
// / VOLUME_TYPE_DIRS / _IMAGE_2D_FILES).
const LUMEN_UP_TYPES        = LUMEN_DATASET_TYPES;
const LUMEN_UP_VOLUME_TYPES = LUMEN_VOLUME_DATASET_TYPES;
const LUMEN_UP_2D_FILES = ['preview.webp' => [LUMEN_UP_TIER_PREVIEW, 'preview'],
                           'image.webp'   => [LUMEN_UP_TIER_MID, 'image']];

/** Twin of upload_staging._safe_rel. Returns the normalised path or null. */
function lumen_up_safe_rel($rel): ?string {
    if (!is_string($rel) || strpos($rel, "\0") !== false) return null;
    $rel = trim(str_replace('\\', '/', $rel), '/');
    if ($rel === '' || strlen($rel) > 1024) return null;
    $segments = explode('/', $rel);
    if (count($segments) > 12) return null;
    foreach ($segments as $seg) {
        if ($seg === '' || $seg === '.' || $seg === '..') return null;
        if ($seg[0] === '.') return null;
        if (strlen($seg) > 200) return null;
    }
    return implode('/', $segments);
}

/** Twin of upload_staging.classify_path. Returns [tier, kind] or null. */
function lumen_up_classify(string $type, $rel): ?array {
    $rel = lumen_up_safe_rel($rel);
    if ($rel === null) return null;
    // An unknown dataset root has no allowlist of its own, so nothing under it can
    // be allowed. lumen_up_safe_dataset re-checks this on every path that touches
    // disk; rejecting here too keeps lumen_up_classify usable as a standalone verdict.
    if (!in_array($type, LUMEN_UP_TYPES, true)) return null;

    if ($rel === 'metadata.json')  return [LUMEN_UP_TIER_CORE, 'metadata'];
    if ($rel === 'thumbnail.webp') return [LUMEN_UP_TIER_CORE, 'thumbnail'];
    $rootExtra = ['model.glb' => LUMEN_UP_TIER_FULL, 'tracks.json' => LUMEN_UP_TIER_PREVIEW,
                  'tracks.json.gz' => LUMEN_UP_TIER_PREVIEW, 'meta.json' => LUMEN_UP_TIER_CORE];
    if (isset($rootExtra[$rel])) return in_array($type, LUMEN_UP_VOLUME_TYPES, true) ? [$rootExtra[$rel], 'extra'] : null;
    if (isset(LUMEN_UP_2D_FILES[$rel])) return $type === '2d' ? LUMEN_UP_2D_FILES[$rel] : null;

    if (strncmp($rel, 'download/', 9) === 0) {
        $name = substr($rel, 9);
        if (strpos($name, '/') !== false) return null;
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,180}$/D', $name)) return null;
        $dot = strrpos($name, '.');
        $ext = $dot === false ? '' : strtolower(substr($name, $dot + 1));
        if (!in_array($ext, LUMEN_UP_DOWNLOAD_EXT, true)) return null;
        return [LUMEN_UP_TIER_EXTRA, 'download'];
    }

    if (strncmp($rel, 'planes/', 7) === 0) {
        // Format-2 plane copy of the native level (DOCS/dataset-migrations/SPEC.md §3):
        // planes/ for one tree, planes/tNNN/ per frame of a timelapse. It never gates
        // opening a dataset (the bricks serve every cut until it arrives): last tier.
        if (!preg_match('#^planes/(?:(t[0-9]{3,6})/)?(manifest\.json|z[0-9]{5,7}\.bin)$#D', $rel, $m)) return null;
        if (!in_array($type, LUMEN_UP_VOLUME_TYPES, true) || ($m[1] !== '' && $type !== 'live')) return null;
        return [LUMEN_UP_TIER_EXTRA, $m[2] === 'manifest.json' ? 'planes_manifest' : 'planes_pack'];
    }

    if (strncmp($rel, 'mips/', 5) === 0) {
        // Format-3 layer MIPs (SPEC §12): only speed up whole-stack figures — last tier.
        if (!preg_match('#^mips/(?:(t[0-9]{3,6})/)?(manifest\.json|l[0-9]{5,7}\.bin)$#D', $rel, $m)) return null;
        if (!in_array($type, LUMEN_UP_VOLUME_TYPES, true) || ($m[1] !== '' && $type !== 'live')) return null;
        return [LUMEN_UP_TIER_EXTRA, $m[2] === 'manifest.json' ? 'mips_manifest' : 'mips_pack'];
    }

    if (strncmp($rel, 'bricks/', 7) !== 0 || !in_array($type, LUMEN_UP_VOLUME_TYPES, true)) return null;
    $inner = substr($rel, 7);
    if ($inner === 'manifest.json') return [LUMEN_UP_TIER_CORE, 'manifest'];

    $timepoint = null;
    if (preg_match('#^t(\d{1,6})/(.+)$#', $inner, $m)) {
        if ($type !== 'live') return null;
        $timepoint = (int)$m[1];
        $inner = $m[2];
        if ($inner === 'manifest.json') return [LUMEN_UP_TIER_CORE, 'manifest'];
    }
    // Format 4 (SPEC §13): the v3 binary index mounts a tree like the v2 manifest;
    // packs are l{k}/c{c}/pNNNNN.bin.
    if ($inner === 'index.bin') return [LUMEN_UP_TIER_CORE, 'index'];
    if (!preg_match('#^lod(\d{1,2})/(c\d{1,2}|rgba)/pack_\d{1,6}\.bin$#D', $inner, $m)
        && !preg_match('#^l(\d{1,2})/c\d{1,2}/p\d{5}\.bin$#D', $inner, $m)) return null;
    $lod  = (int)$m[1];
    $tier = $lod === 0 ? LUMEN_UP_TIER_FULL : LUMEN_UP_TIER_MID;
    if ($timepoint !== null && $timepoint !== 0 && $tier < LUMEN_UP_TIER_FULL) $tier = LUMEN_UP_TIER_FULL;
    return [$tier, 'pack'];
}

/** [lod, timepoint] for a pack path, or null. */
function lumen_up_pack_lod(string $rel): ?array {
    $inner = strncmp($rel, 'bricks/', 7) === 0 ? substr($rel, 7) : $rel;
    $tp = 0;
    if (preg_match('#^t(\d{1,6})/(.+)$#', $inner, $m)) { $tp = (int)$m[1]; $inner = $m[2]; }
    if (!preg_match('#^lod(\d{1,2})/#', $inner, $m) && !preg_match('#^l(\d{1,2})/c\d{1,2}/p\d{5}\.bin$#D', $inner, $m)) return null;
    return [(int)$m[1], $tp];
}

/** Twin of upload_staging.assign_tiers — promotes the coarsest LOD to the preview tier. */
function lumen_up_assign_tiers(array &$files): void {
    $lods = [];
    foreach ($files as $f) {
        if ($f['kind'] !== 'pack') continue;
        $pl = lumen_up_pack_lod($f['path']);
        if ($pl) $lods[$pl[0]] = true;
    }
    if (!$lods) return;
    $coarsest = max(array_keys($lods));
    foreach ($files as &$f) {
        if ($f['kind'] !== 'pack') continue;
        $pl = lumen_up_pack_lod($f['path']);
        if (!$pl) continue;
        [$lod, $tp] = $pl;
        if ($tp > 0)                 $f['tier'] = LUMEN_UP_TIER_FULL;
        elseif ($lod === $coarsest)  $f['tier'] = LUMEN_UP_TIER_PREVIEW;
        elseif ($lod === 0)          $f['tier'] = LUMEN_UP_TIER_FULL;
        else                         $f['tier'] = LUMEN_UP_TIER_MID;
    }
    unset($f);
}

// ── Dataset / file paths ─────────────────────────────────────────────────────

function lumen_up_safe_dataset($type, $folder): ?array {
    if (!is_string($type) || !is_string($folder)) return null;
    $type = trim($type); $folder = trim($folder);
    if (!in_array($type, LUMEN_UP_TYPES, true)) return null;
    if ($folder === '.' || $folder === '..' || strlen($folder) > 180) return null;
    if (!preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/D', $folder)) return null;
    return [$type, $folder];
}

function lumen_up_dataset_dir($type, $folder): ?string {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return null;
    return lumen_up_staging() . '/' . $safe[0] . '/' . $safe[1];
}

/**
 * Absolute path of a staged file, or null.
 *
 * Shape first (lumen_up_safe_rel), allowlist second (lumen_up_classify), then a
 * literal prefix check on the normalised strings. realpath() is unusable here —
 * the file usually does not exist yet — so containment is proved on the path
 * text, which is safe because every '..' and absolute form was already refused.
 */
function lumen_up_file_path($type, $folder, $rel): ?string {
    $dir = lumen_up_dataset_dir($type, $folder);
    if ($dir === null) return null;
    $rel = lumen_up_safe_rel($rel);
    if ($rel === null || lumen_up_classify($type, $rel) === null) return null;
    $full = $dir . '/' . $rel;
    if (strncmp($full, $dir . '/', strlen($dir) + 1) !== 0) return null;
    return $full;
}

function lumen_up_journal_path($type, $folder): ?string {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return null;
    return lumen_up_state() . '/' . $safe[0] . '__' . $safe[1] . '.json';
}

/**
 * Create the staging root and (re)assert both directory guards.
 *
 * Written at runtime rather than relying on the shipped files: DATA_WEB is in the
 * updater's protect list, so a deployed host would otherwise never receive its
 * execution ban through an update, and a staging root created at runtime would
 * have no deny rule at all until the next release. The rule texts live in
 * _admin_lib.php (lumen_staging_guard / lumen_data_web_guard).
 */
function lumen_up_ensure_dirs(): void {
    admin_make_dir(lumen_up_staging());
    admin_make_dir(lumen_up_state());
    lumen_write_guard(lumen_up_root() . '/.htaccess', lumen_staging_guard());
    // Execution ban for the PUBLISHED tree. DATA_WEB is web-served by construction,
    // so it is the one directory that is both operator-writable and reachable. The
    // import allowlist already refuses anything the pipeline does not emit, but a
    // dataset can also arrive by SFTP or rsync, which bypasses it entirely.
    admin_make_dir(data_web());
    lumen_write_guard(data_web() . '/.htaccess', lumen_data_web_guard());
}

// ── Journal ──────────────────────────────────────────────────────────────────

function lumen_up_now(): string { return gmdate('Y-m-d\TH:i:s+00:00'); }

function lumen_up_new_journal(string $type, string $folder): array {
    return ['version' => 1, 'type' => $type, 'folder' => $folder,
            'createdAt' => lumen_up_now(), 'updatedAt' => lumen_up_now(),
            'files' => [], 'rejected' => [], 'metaLocked' => false, 'publishedAt' => null,
            'nextId' => 0];
}

/** The journal with the chunk log folded in (in memory). A caller that saves must
 *  have loaded under the dataset lock — appends take the same lock. */
function lumen_up_load_journal($type, $folder): ?array {
    $p = lumen_up_journal_path($type, $folder);
    if ($p === null || !is_file($p)) return null;
    $raw = @file_get_contents($p);
    if ($raw === false) return null;
    $d = json_decode($raw, true);
    if (!is_array($d)) return null;
    lumen_up_fold_log($d, (string)$type, (string)$folder);
    return $d;
}

// ── Chunk log + file table ───────────────────────────────────────────────────
// Shared format with upload_staging.py (the full description is there). Per
// dataset, beside the journal <type>__<folder>.json in uploads/state/:
//   .files  16-byte header "LUFT" | u32 version=1 | u32 count | u32 0, then 32-byte
//           records at 16 + id*32: u64 size | u32 chunkSize | u32 flags (1 = live) |
//           sha256(path)[:16]  — rewritten whenever file ids change;
//   .log    append-only 16-byte records: u32 id | u32 chunkIndex | "LUC1" |
//           u32 crc32(bytes 0..11) — one per received chunk, appended only after
//           the chunk's bytes were fsync'ed; torn or bad records are ignored; the
//           log is fsync'ed every 32nd record and deleted at compaction.
// All integers little-endian. A journal file entry carries an "id" (never reused,
// "nextId" counts up), replaced whenever its bitmap is reset or its size changes.

const LUMEN_UP_LOG_MAGIC = 'LUC1';
const LUMEN_UP_LOG_SYNC_EVERY = 32;
const LUMEN_UP_TABLE_MAGIC = 'LUFT';

function lumen_up_log_path($type, $folder): ?string {
    $safe = lumen_up_safe_dataset($type, $folder);
    return $safe === null ? null : lumen_up_state() . '/' . $safe[0] . '__' . $safe[1] . '.log';
}

function lumen_up_table_path($type, $folder): ?string {
    $safe = lumen_up_safe_dataset($type, $folder);
    return $safe === null ? null : lumen_up_state() . '/' . $safe[0] . '__' . $safe[1] . '.files';
}

function lumen_up_path_tag(string $rel): string {
    return substr(hash('sha256', $rel, true), 0, 16);
}

function lumen_up_log_record(int $id, int $index): string {
    $head = pack('VV', $id, $index) . LUMEN_UP_LOG_MAGIC;
    return $head . pack('V', crc32($head));
}

/** Every intact [file id, chunk index] record of the dataset's chunk log. */
function lumen_up_read_log($type, $folder): array {
    $lp = lumen_up_log_path($type, $folder);
    if ($lp === null || !is_file($lp)) return [];
    $data = @file_get_contents($lp);
    if ($data === false) return [];
    $out = [];
    $n = intdiv(strlen($data), 16);
    for ($i = 0; $i < $n; $i++) {
        $rec = substr($data, $i * 16, 16);
        if (substr($rec, 8, 4) !== LUMEN_UP_LOG_MAGIC) continue;
        $u = unpack('Vid/Vindex/x4/Vcrc', $rec);
        if ($u['crc'] !== crc32(substr($rec, 0, 12))) continue;
        $out[] = [$u['id'], $u['index']];
    }
    return $out;
}

/** Twin of upload_staging._fold_log. Returns the records applied. */
function lumen_up_fold_log(array &$journal, string $type, string $folder): int {
    $records = lumen_up_read_log($type, $folder);
    if (!$records || !is_array($journal['files'] ?? null)) return 0;
    $byId = [];
    foreach ($journal['files'] as $rel => $e) {
        if (is_array($e) && is_int($e['id'] ?? null)) $byId[$e['id']] = $rel;
    }
    $maps = [];
    $applied = 0;
    foreach ($records as [$fid, $index]) {
        if (!isset($byId[$fid])) continue;
        if (!isset($maps[$fid])) {
            $e = $journal['files'][$byId[$fid]];
            $size  = (int)($e['size'] ?? 0);
            $chunk = (int)($e['chunkSize'] ?? LUMEN_UP_DEFAULT_CHUNK) ?: LUMEN_UP_DEFAULT_CHUNK;
            $nbits = lumen_up_bits_len($size, $chunk);
            $maps[$fid] = [lumen_up_bitmap_decode($e['bits'] ?? '', $nbits), $nbits];
        }
        if ($index < $maps[$fid][1]) {
            $maps[$fid][0] = lumen_up_bit_set($maps[$fid][0], $index);
            $applied++;
        }
    }
    foreach ($maps as $fid => [$bits, $nbits]) {
        $rel = $byId[$fid];
        $journal['files'][$rel]['bits'] = lumen_up_bitmap_encode($bits);
        // Same rule as the per-chunk journal write it replaces: a file whose every
        // chunk is in reads done; only lumen_up_finalize ever takes that back.
        if ($nbits > 0 && lumen_up_bit_count($bits) === $nbits) $journal['files'][$rel]['done'] = true;
    }
    if ($applied) {
        $lp = lumen_up_log_path($type, $folder);
        clearstatcache(true, $lp);
        $mtime = @filemtime($lp);
        if ($mtime !== false) $journal['lastChunkAt'] = gmdate('Y-m-d\TH:i:s+00:00', $mtime);
    }
    return $applied;
}

/** Twin of upload_staging._ensure_ids. */
function lumen_up_ensure_ids(array &$journal): bool {
    $changed = false;
    if (!is_array($journal['files'] ?? null)) $journal['files'] = [];
    $used = [];
    foreach ($journal['files'] as $e) if (is_array($e) && is_int($e['id'] ?? null)) $used[] = $e['id'];
    $next = $journal['nextId'] ?? null;
    if (!is_int($next) || ($used && $next <= max($used))) {
        $next = $used ? max($used) + 1 : 0;
        $changed = true;
    }
    foreach ($journal['files'] as $rel => $e) {
        if (is_array($e) && !is_int($e['id'] ?? null)) {
            $journal['files'][$rel]['id'] = $next++;
            $changed = true;
        }
    }
    $journal['nextId'] = $next;
    return $changed;
}

/** A fresh incarnation of a file: its old id (and every record naming it) no longer applies. */
function lumen_up_new_id(array &$journal, array &$entry): void {
    lumen_up_ensure_ids($journal);
    $entry['id'] = $journal['nextId'];
    $journal['nextId']++;
}

function lumen_up_write_table(array $journal): void {
    $tp = lumen_up_table_path($journal['type'] ?? '', $journal['folder'] ?? '');
    if ($tp === null) return;
    $count = (int)($journal['nextId'] ?? 0);
    $records = $count > 0 ? array_fill(0, $count, str_repeat("\0", 32)) : [];
    foreach (($journal['files'] ?? []) as $rel => $e) {
        if (!is_array($e) || !is_int($e['id'] ?? null) || $e['id'] < 0 || $e['id'] >= $count) continue;
        $chunk = (int)($e['chunkSize'] ?? LUMEN_UP_DEFAULT_CHUNK) ?: LUMEN_UP_DEFAULT_CHUNK;
        $records[$e['id']] = pack('PVV', (int)($e['size'] ?? 0), $chunk, 1) . lumen_up_path_tag((string)$rel);
    }
    admin_make_dir(dirname($tp));
    lumen_write_file_atomic($tp, LUMEN_UP_TABLE_MAGIC . pack('VVV', 1, $count, 0) . implode('', $records));
}

/** [size, chunkSize, tag] of a live file-table record, or null. */
function lumen_up_read_table_record($type, $folder, int $id): ?array {
    $tp = lumen_up_table_path($type, $folder);
    if ($tp === null || $id < 0 || !is_file($tp)) return null;
    $fh = @fopen($tp, 'rb');
    if ($fh === false) return null;
    $head = (string)fread($fh, 16);
    $raw = '';
    if (strlen($head) === 16 && substr($head, 0, 4) === LUMEN_UP_TABLE_MAGIC) {
        $h = unpack('Vversion/Vcount', substr($head, 4, 8));
        if ($h['version'] === 1 && $id < $h['count'] && fseek($fh, 16 + $id * 32) === 0) $raw = (string)fread($fh, 32);
    }
    fclose($fh);
    if (strlen($raw) !== 32) return null;
    $r = unpack('Psize/Vchunk/Vflags', substr($raw, 0, 16));
    if (!($r['flags'] & 1) || $r['chunk'] <= 0) return null;
    return [$r['size'], $r['chunk'], substr($raw, 16, 16)];
}

function lumen_up_append_log($type, $folder, int $id, int $index): bool {
    $lp = lumen_up_log_path($type, $folder);
    if ($lp === null) return false;
    $fh = @fopen($lp, 'ab');
    if ($fh === false) return false;
    $ok = @fwrite($fh, lumen_up_log_record($id, $index)) === 16;
    if ($ok) {
        fflush($fh);
        clearstatcache(true, $lp);
        $pos = @filesize($lp);
        if ($pos !== false && intdiv($pos, 16) % LUMEN_UP_LOG_SYNC_EVERY === 0 && function_exists('fsync')) @fsync($fh);
    }
    fclose($fh);
    return $ok;
}

function lumen_up_remove_state_files($type, $folder): void {
    $jp = lumen_up_journal_path($type, $folder);
    // The flock sidecar too, or uploads/state/ slowly fills with dead .lock files.
    foreach ([$jp, lumen_up_log_path($type, $folder), lumen_up_table_path($type, $folder),
              $jp === null ? null : $jp . '.lock'] as $p) {
        if ($p !== null && is_file($p)) @unlink($p);
    }
}

/** Run $fn under the dataset's exclusive lock WITHOUT loading the journal. */
function lumen_up_with_lock($type, $folder, callable $fn) {
    $jp = lumen_up_journal_path($type, $folder);
    if ($jp === null) return [400, ['error' => 'invalid_dataset']];
    lumen_up_ensure_dirs();
    $lock = @fopen($jp . '.lock', 'c');
    if ($lock === false) return [500, ['error' => 'lock_failed']];
    @flock($lock, LOCK_EX);
    try {
        return $fn();
    } finally {
        @flock($lock, LOCK_UN);
        @fclose($lock);
    }
}

/**
 * Run $fn against the dataset journal under an exclusive lock.
 *
 * The lock is held on a sidecar `.lock` file rather than the journal itself, so
 * the atomic rename that publishes the new journal cannot swap the inode out
 * from under a waiting writer.
 */
function lumen_up_journal_locked($type, $folder, callable $fn) {
    $jp = lumen_up_journal_path($type, $folder);
    if ($jp === null) return [400, ['error' => 'invalid_dataset']];
    lumen_up_ensure_dirs();
    $lockPath = $jp . '.lock';
    $lock = @fopen($lockPath, 'c');
    if ($lock === false) return [500, ['error' => 'lock_failed']];
    @flock($lock, LOCK_EX);
    try {
        $journal = lumen_up_load_journal($type, $folder);
        $result = $fn($journal);
        return $result;
    } finally {
        @flock($lock, LOCK_UN);
        @fclose($lock);
    }
}

function lumen_up_save_journal(array $journal): bool {
    $jp = lumen_up_journal_path($journal['type'] ?? '', $journal['folder'] ?? '');
    if ($jp === null) return false;
    $journal['updatedAt'] = lumen_up_now();
    // `files` is a MAP keyed by relative path in the shared format: an empty PHP
    // array would be written as `[]`, which upload_staging.py iterates as a dict.
    if (isset($journal['files']) && is_array($journal['files']) && !$journal['files']) $journal['files'] = new stdClass();
    admin_make_dir(dirname($jp));
    $json = json_encode($journal, JSON_UNESCAPED_UNICODE);
    if ($json === false || !lumen_write_file_atomic($jp, $json)) return false;
    // Compaction: the folded records now live in the journal. A crash before this
    // unlink leaves records that fold again onto bits already set — harmless.
    $lp = lumen_up_log_path($journal['type'] ?? '', $journal['folder'] ?? '');
    if ($lp !== null && is_file($lp)) @unlink($lp);
    return true;
}

// ── Received-chunk bitmap (one bit per chunk, base64 in the journal) ──────────

function lumen_up_bits_len(int $size, int $chunk): int {
    if ($size <= 0) return 0;
    return intdiv($size + $chunk - 1, $chunk);
}

function lumen_up_bitmap_decode(?string $b64, int $nbits): string {
    $nbytes = intdiv($nbits + 7, 8);
    $raw = $b64 ? (base64_decode($b64, true) ?: '') : '';
    if (strlen($raw) < $nbytes) $raw .= str_repeat("\0", $nbytes - strlen($raw));
    $bits = $nbytes > 0 ? substr($raw, 0, $nbytes) : '';
    // Mask the padding bits of the last byte. Nothing we write ever sets them, but
    // a hand-edited or truncated journal could, and the popcount in
    // lumen_up_received would then report MORE bytes received than were ever sent.
    $extra = $nbits & 7;
    if ($extra && $bits !== '') $bits[$nbytes - 1] = chr(ord($bits[$nbytes - 1]) & ((1 << $extra) - 1));
    return $bits;
}

function lumen_up_bitmap_encode(string $bits): string { return base64_encode($bits); }

function lumen_up_bit_get(string $bits, int $i): bool {
    $byte = $i >> 3;
    return $byte < strlen($bits) && (ord($bits[$byte]) & (1 << ($i & 7))) !== 0;
}

function lumen_up_bit_set(string $bits, int $i): string {
    $byte = $i >> 3;
    if ($byte < strlen($bits)) $bits[$byte] = chr(ord($bits[$byte]) | (1 << ($i & 7)));
    return $bits;
}

/** Set bits in the map. Counts a BYTE at a time off a lookup table rather than
 *  walking bit by bit — the padding is already masked off by
 *  lumen_up_bitmap_decode, and this runs on every chunk acknowledgement. */
function lumen_up_bit_count(string $bits, int $nbits = 0): int {
    static $table = null;
    if ($table === null) {
        $table = [];
        for ($b = 0; $b < 256; $b++) {
            $n = 0;
            for ($k = 0; $k < 8; $k++) if ($b & (1 << $k)) $n++;
            $table[$b] = $n;
        }
    }
    $total = 0;
    $len = strlen($bits);
    for ($i = 0; $i < $len; $i++) $total += $table[ord($bits[$i])];
    return $total;
}

function lumen_up_received(array $entry): int {
    $size  = (int)($entry['size'] ?? 0);
    $chunk = (int)($entry['chunkSize'] ?? LUMEN_UP_DEFAULT_CHUNK) ?: LUMEN_UP_DEFAULT_CHUNK;
    $nbits = lumen_up_bits_len($size, $chunk);
    if ($nbits === 0) return 0;
    $bits  = lumen_up_bitmap_decode($entry['bits'] ?? '', $nbits);
    $count = lumen_up_bit_count($bits);
    // Every chunk is `chunk` bytes except the last, which is whatever remains.
    $last = $nbits - 1;
    if (lumen_up_bit_get($bits, $last)) return ($count - 1) * $chunk + ($size - $last * $chunk);
    return $count * $chunk;
}

function lumen_up_missing(array $entry): array {
    $size  = (int)($entry['size'] ?? 0);
    $chunk = (int)($entry['chunkSize'] ?? LUMEN_UP_DEFAULT_CHUNK) ?: LUMEN_UP_DEFAULT_CHUNK;
    $nbits = lumen_up_bits_len($size, $chunk);
    $bits  = lumen_up_bitmap_decode($entry['bits'] ?? '', $nbits);
    $out = [];
    for ($i = 0; $i < $nbits; $i++) if (!lumen_up_bit_get($bits, $i)) $out[] = $i;
    return $out;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

function lumen_up_clamp_chunk($n): int {
    $n = is_numeric($n) ? (int)$n : LUMEN_UP_DEFAULT_CHUNK;
    return max(LUMEN_UP_MIN_CHUNK, min(lumen_up_chunk_limit(), $n));
}

/** Free bytes on the volume holding the staging root, or null when unknown
 *  (disk_free_space disabled, open_basedir). */
function lumen_up_free_bytes(): ?int {
    $probe = lumen_up_staging();
    while (!is_dir($probe) && dirname($probe) !== $probe) $probe = dirname($probe);
    $free = function_exists('disk_free_space') ? @disk_free_space($probe) : false;
    return is_float($free) || is_int($free) ? (int)$free : null;
}

/** A failed write that the disk (or the account's quota) being full explains. PHP
 *  surfaces no errno, so the free space after the failure is what tells. */
function lumen_up_disk_full(int $wanted): bool {
    $free = lumen_up_free_bytes();
    return $free !== null && $free < max($wanted, 1);
}

function lumen_up_plan($datasets, $chunkSize): array {
    if (!is_array($datasets)) return ['ok' => false, 'error' => 'bad_request'];
    $chunkSize = lumen_up_clamp_chunk($chunkSize);
    $out = [];
    // One free-space budget for the whole drop: each dataset spends from it, so
    // several datasets that fit one by one cannot together overrun the disk.
    $free = lumen_up_free_bytes();
    $budget = $free === null ? null : max(0, $free - LUMEN_UP_DISK_RESERVE);
    foreach (array_slice($datasets, 0, LUMEN_UP_MAX_DATASETS) as $raw) {
        if (!is_array($raw)) continue;
        $safe = lumen_up_safe_dataset($raw['type'] ?? null, $raw['folder'] ?? null);
        if ($safe === null) {
            $out[] = ['key' => null, 'type' => $raw['type'] ?? null, 'folder' => $raw['folder'] ?? null,
                      'error' => 'invalid_dataset', 'files' => [], 'rejected' => []];
            continue;
        }
        $out[] = lumen_up_plan_one($safe[0], $safe[1], $raw['files'] ?? [], $chunkSize, $budget);
    }
    return ['ok' => true, 'chunkSize' => $chunkSize, 'datasets' => $out];
}

function lumen_up_plan_one(string $type, string $folder, $files, int $chunkSize, ?int &$budget = null): array {
    $accepted = []; $rejected = []; $seen = [];
    foreach (array_slice(is_array($files) ? $files : [], 0, LUMEN_UP_MAX_FILES) as $f) {
        if (!is_array($f)) continue;
        $rel = lumen_up_safe_rel($f['path'] ?? null);
        if ($rel === null) { $rejected[] = ['path' => substr((string)($f['path'] ?? ''), 0, 200), 'reason' => 'unsafe_path']; continue; }
        if (isset($seen[$rel])) continue;
        $seen[$rel] = true;
        $verdict = lumen_up_classify($type, $rel);
        if ($verdict === null) { $rejected[] = ['path' => $rel, 'reason' => 'not_allowed']; continue; }
        $size = isset($f['size']) && is_numeric($f['size']) ? (int)$f['size'] : -1;
        if ($size < 0) { $rejected[] = ['path' => $rel, 'reason' => 'bad_size']; continue; }
        if ($size > LUMEN_UP_MAX_FILE_SIZE) { $rejected[] = ['path' => $rel, 'reason' => 'too_large']; continue; }
        $accepted[] = ['path' => $rel, 'size' => $size, 'tier' => $verdict[0], 'kind' => $verdict[1]];
    }
    lumen_up_assign_tiers($accepted);

    $refusal = null;
    $result = lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, &$accepted, $rejected, $chunkSize, &$budget, &$refusal) {
        if ($journal === null) $journal = lumen_up_new_journal($type, $folder);
        if (!isset($journal['files']) || !is_array($journal['files'])) $journal['files'] = [];
        lumen_up_ensure_ids($journal);

        // Bytes this drop still has to write: everything not already stored. Refused
        // up front, before the journal changes, when the volume cannot hold it — a
        // full disk mid-transfer stalls every other writer on the host.
        if ($budget !== null) {
            $needed = 0;
            foreach ($accepted as $item) {
                $entry = $journal['files'][$item['path']] ?? null;
                if ($entry && (int)($entry['size'] ?? -1) === $item['size']) {
                    $needed += !empty($entry['done']) ? 0 : $item['size'] - lumen_up_received($entry);
                } else {
                    $needed += $item['size'];
                }
            }
            if ($needed > $budget) { $refusal = ['needed' => $needed, 'free' => $budget]; return null; }
            $budget -= $needed;
        }

        foreach ($accepted as &$item) {
            $rel = $item['path'];
            $entry = $journal['files'][$rel] ?? null;
            // Tiering is a property of the SET, so a second drop that adds coarser
            // levels re-ranks files planned earlier. Refresh it on every branch — a
            // stale tier on a finished file skews lumen_up_state_of's "is this
            // openable yet" test.
            if ($entry !== null) {
                $entry['tier'] = $item['tier'];
                $entry['kind'] = $item['kind'];
                $journal['files'][$rel] = $entry;
            }
            // The operator's edits win over a re-dropped pipeline file (see the
            // Python twin: metadata.json is rewritten in place by the editor while
            // the rest of the dataset is still streaming in).
            if ($rel === 'metadata.json' && !empty($journal['metaLocked']) && $entry && !empty($entry['done'])) {
                // Report the LOCAL size, not the edited file's: totalBytes is summed
                // from local sizes, and mixing the two made receivedBytes overshoot.
                $item['skip'] = 'locked'; $item['received'] = $item['size']; $item['done'] = true;
                continue;
            }
            if ($entry && (int)($entry['size'] ?? -1) === $item['size'] && !empty($entry['done'])) {
                $item['received'] = $item['size']; $item['done'] = true; $item['skip'] = 'complete';
                continue;
            }
            if ($entry && (int)($entry['size'] ?? -1) === $item['size']) {
                $item['received']  = lumen_up_received($entry);
                $item['chunkSize'] = (int)($entry['chunkSize'] ?? $chunkSize);
                $item['missing']   = lumen_up_missing($entry);
                $item['done'] = false;
                $item['fileId'] = $journal['files'][$rel]['id'];
                continue;
            }
            $nbits = lumen_up_bits_len($item['size'], $chunkSize);
            $fresh = [
                'size' => $item['size'], 'chunkSize' => $chunkSize, 'kind' => $item['kind'],
                'tier' => $item['tier'], 'bits' => lumen_up_bitmap_encode(str_repeat("\0", intdiv($nbits + 7, 8))),
                'done' => $item['size'] === 0, 'sha' => null,
            ];
            lumen_up_new_id($journal, $fresh);
            $journal['files'][$rel] = $fresh;
            $item['fileId'] = $fresh['id'];
            $item['received'] = 0;
            $item['chunkSize'] = $chunkSize;
            $item['missing'] = $nbits > 0 ? range(0, $nbits - 1) : [];
            $item['done'] = $item['size'] === 0;
        }
        unset($item);
        $journal['rejected'] = array_slice($rejected, 0, 200);
        // Drop UNFINISHED entries this drop no longer contains, and their partial
        // bytes with them — see the Python twin for why absence is authoritative.
        // Left in place they were never completable, and the "incomplete_files"
        // check then blocked the publish forever.
        $present = [];
        foreach ($accepted as $i) $present[$i['path']] = true;
        foreach (array_keys($journal['files']) as $rel) {
            if (isset($present[$rel]) || !empty($journal['files'][$rel]['done'])) continue;
            unset($journal['files'][$rel]);
            $orphan = lumen_up_file_path($type, $folder, $rel);
            if ($orphan !== null && is_file($orphan)) @unlink($orphan);
        }
        lumen_up_save_journal($journal);
        lumen_up_write_table($journal);
        return $journal;
    });
    if ($refusal !== null) {
        return ['key' => "$type/$folder", 'type' => $type, 'folder' => $folder,
                'error' => 'insufficient_disk', 'neededBytes' => $refusal['needed'],
                'freeBytes' => $refusal['free'], 'files' => [], 'rejected' => array_slice($rejected, 0, 200)];
    }
    $journal = is_array($result) && isset($result['files']) ? $result : lumen_up_new_journal($type, $folder);

    $total = 0; $done = 0;
    foreach ($accepted as $i) { $total += $i['size']; $done += (int)($i['received'] ?? 0); }
    return [
        'key' => "$type/$folder", 'type' => $type, 'folder' => $folder,
        'published' => is_file(data_web() . "/$type/$folder/metadata.json"),
        'state' => lumen_up_state_of($type, $folder, $journal),
        'metaLocked' => !empty($journal['metaLocked']),
        'files' => $accepted, 'rejected' => array_slice($rejected, 0, 200),
        'totalBytes' => $total, 'receivedBytes' => $done,
    ];
}

// ── Chunk ingest ─────────────────────────────────────────────────────────────

/**
 * Verify and store one chunk. $data is the raw request body.
 *
 * As in the Python twin the SHA-256 is checked BEFORE the write, so a staging
 * file is only ever made of bytes that matched what the client hashed.
 */
function lumen_up_write_chunk($type, $folder, $rel, $index, string $data, ?string $sha, ?int $fileId = null): array {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return [400, ['error' => 'invalid_dataset']];
    [$type, $folder] = $safe;

    $dest = lumen_up_file_path($type, $folder, $rel);
    if ($dest === null) return [400, ['error' => 'path_not_allowed']];
    $rel = lumen_up_safe_rel($rel);

    if (!is_int($index) || $index < 0) return [400, ['error' => 'bad_index']];
    if (strlen($data) > LUMEN_UP_MAX_CHUNK) return [413, ['error' => 'chunk_too_large']];
    // The digest is mandatory (twin of the Python check): a chunk without one would
    // land unverified and the finished file's integrity would rest on its size alone.
    if ($sha === null || !preg_match('/^[0-9a-fA-F]{64}$/D', $sha)) return [400, ['error' => 'checksum_required']];
    $actual = hash('sha256', $data);
    if (!hash_equals(strtolower($sha), $actual)) {
        return [422, ['error' => 'checksum_mismatch', 'expected' => $sha, 'actual' => $actual]];
    }

    // Fast path (twin of upload_staging.write_chunk): the planned geometry comes
    // from the file table, the bytes are written outside the lock, and only the
    // 16-byte log append is serialised. metadata.json keeps the journal path: its
    // operator lock lives there.
    $tag = lumen_up_path_tag($rel);
    if ($fileId === null || $rel === 'metadata.json' || !is_file((string)lumen_up_table_path($type, $folder))) {
        return lumen_up_write_chunk_journal($type, $folder, $rel, $index, $data, $dest);
    }
    $record = lumen_up_read_table_record($type, $folder, $fileId);
    // A retired id (re-planned with another size, reset, dropped) or one naming
    // another path: these bytes belong to no file the journal still plans.
    if ($record === null || !hash_equals($record[2], $tag)) return [409, ['error' => 'file_not_planned']];

    [$size, $chunk] = $record;
    $nbits = lumen_up_bits_len($size, $chunk);
    if ($index >= $nbits) return [400, ['error' => 'index_out_of_range']];
    $offset = $index * $chunk;
    $expected = min($chunk, $size - $offset);
    if (strlen($data) !== $expected) {
        return [400, ['error' => 'bad_chunk_length', 'expected' => $expected, 'actual' => strlen($data)]];
    }
    $err = lumen_up_write_at($dest, $offset, $data);
    if ($err !== null) return $err;
    return lumen_up_with_lock($type, $folder, function () use ($type, $folder, $fileId, $index, $tag, $record, $nbits, $data) {
        // Re-read under the lock: a plan or a reset in between may have retired this
        // id, and a record must never name a file it does not belong to.
        $again = lumen_up_read_table_record($type, $folder, $fileId);
        $jp = lumen_up_journal_path($type, $folder);
        if ($again === null || !hash_equals($again[2], $tag) || $again[0] !== $record[0]
            || $again[1] !== $record[1] || !is_file((string)$jp)) {
            return [409, ['error' => 'file_not_planned']];
        }
        if (!lumen_up_append_log($type, $folder, $fileId, $index)) return lumen_up_write_error(strlen($data));
        return [200, ['ok' => true, 'index' => $index, 'chunks' => $nbits]];
    });
}

/** Sparse write at the exact offset, then fsync, so a log record only ever
 *  describes bytes that are on disk. Null on success, else the error answer. */
function lumen_up_write_at(string $dest, int $offset, string $data): ?array {
    admin_make_dir(dirname($dest));
    $fh = @fopen($dest, 'c+b');           // create, never truncate
    if ($fh === false) return lumen_up_write_error(strlen($data));
    $ok = @fseek($fh, $offset) === 0 && @fwrite($fh, $data) === strlen($data);
    $ok = $ok && @fflush($fh);
    if ($ok && function_exists('fsync')) $ok = @fsync($fh);
    $ok = @fclose($fh) && $ok;
    if (!$ok) return lumen_up_write_error(strlen($data));
    admin_fix_file_mode($dest);
    return null;
}

/** A failure costs a re-send, never a corrupt file. A full disk is terminal for the
 *  transfer (507), not a network hiccup to retry forever. */
function lumen_up_write_error(int $wanted): array {
    return lumen_up_disk_full($wanted)
        ? [507, ['error' => 'insufficient_disk', 'neededBytes' => $wanted, 'freeBytes' => lumen_up_free_bytes()]]
        : [500, ['error' => 'write_failed']];
}

function lumen_up_write_chunk_journal(string $type, string $folder, string $rel, int $index, string $data, string $dest): array {
    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, $rel, $index, $data, $dest) {
        if ($journal === null) return [409, ['error' => 'no_plan']];
        $entry = $journal['files'][$rel] ?? null;
        if ($entry === null) return [409, ['error' => 'file_not_planned']];
        if ($rel === 'metadata.json' && !empty($journal['metaLocked']) && !empty($entry['done'])) {
            return [200, ['ok' => true, 'skipped' => 'locked', 'received' => (int)($entry['size'] ?? 0)]];
        }
        $size  = (int)($entry['size'] ?? 0);
        $chunk = (int)($entry['chunkSize'] ?? LUMEN_UP_DEFAULT_CHUNK) ?: LUMEN_UP_DEFAULT_CHUNK;
        $nbits = lumen_up_bits_len($size, $chunk);
        if ($index >= $nbits) return [400, ['error' => 'index_out_of_range']];
        $offset = $index * $chunk;
        $expected = min($chunk, $size - $offset);
        if (strlen($data) !== $expected) {
            return [400, ['error' => 'bad_chunk_length', 'expected' => $expected, 'actual' => strlen($data)]];
        }
        if (!is_int($entry['id'] ?? null)) {
            // A journal from before the chunk log: number it once, durably.
            lumen_up_ensure_ids($journal);
            lumen_up_save_journal($journal);
            lumen_up_write_table($journal);
            $entry = $journal['files'][$rel];
        }
        $err = lumen_up_write_at($dest, $offset, $data);
        if ($err !== null) return $err;
        if (!lumen_up_append_log($type, $folder, $entry['id'], $index)) return lumen_up_write_error(strlen($data));
        $bits = lumen_up_bit_set(lumen_up_bitmap_decode($entry['bits'] ?? '', $nbits), $index);
        $entry['bits'] = lumen_up_bitmap_encode($bits);
        $have = lumen_up_bit_count($bits, $nbits);
        $done = !empty($entry['done']) || $have === $nbits;
        $entry['done'] = $done;
        return [200, ['ok' => true, 'index' => $index, 'chunks' => $nbits, 'have' => $have,
                      'done' => $done, 'received' => lumen_up_received($entry)]];
    });
}

function lumen_up_finalize($type, $folder, $rel, ?string $root): array {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return [400, ['error' => 'invalid_dataset']];
    [$type, $folder] = $safe;
    $dest = lumen_up_file_path($type, $folder, $rel);
    if ($dest === null) return [400, ['error' => 'path_not_allowed']];
    $rel = lumen_up_safe_rel($rel);

    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, $rel, $dest, $root) {
        if ($journal === null) return [409, ['error' => 'no_plan']];
        $entry = $journal['files'][$rel] ?? null;
        if ($entry === null) return [409, ['error' => 'file_not_planned']];
        $size  = (int)($entry['size'] ?? 0);
        $chunk = (int)($entry['chunkSize'] ?? LUMEN_UP_DEFAULT_CHUNK) ?: LUMEN_UP_DEFAULT_CHUNK;
        $nbits = lumen_up_bits_len($size, $chunk);
        $bits  = lumen_up_bitmap_decode($entry['bits'] ?? '', $nbits);
        $missing = [];
        for ($i = 0; $i < $nbits; $i++) if (!lumen_up_bit_get($bits, $i)) $missing[] = $i;
        if ($missing) return [409, ['error' => 'incomplete', 'missing' => array_slice($missing, 0, 64)]];

        if ($size === 0) { admin_make_dir(dirname($dest)); if (!is_file($dest)) @touch($dest); }
        clearstatcache(true, $dest);
        $onDisk = @filesize($dest);
        if ($onDisk === false) return [409, ['error' => 'missing_on_disk']];
        if ($onDisk !== $size) {
            $entry['bits'] = lumen_up_bitmap_encode(str_repeat("\0", intdiv($nbits + 7, 8)));
            $entry['done'] = false;
            lumen_up_new_id($journal, $entry);
            $journal['files'][$rel] = $entry;
            lumen_up_save_journal($journal);
            lumen_up_write_table($journal);
            return [409, ['error' => 'size_mismatch', 'expected' => $size, 'actual' => $onDisk]];
        }

        [$ok, $reason] = lumen_up_validate_file($type, $rel, $dest, $entry['kind'] ?? null);
        if (!$ok) {
            $entry['done'] = false; $entry['invalid'] = $reason;
            $journal['files'][$rel] = $entry;
            lumen_up_save_journal($journal);
            return [422, ['error' => 'invalid_content', 'reason' => $reason]];
        }
        unset($entry['invalid']);
        $entry['done'] = true;
        if ($root) $entry['sha'] = substr((string)$root, 0, 128);
        $journal['files'][$rel] = $entry;
        lumen_up_save_journal($journal);
        return [200, ['ok' => true, 'path' => $rel, 'size' => $size,
                      'state' => lumen_up_state_of($type, $folder, $journal)]];
    });
}

// ── Content validation ───────────────────────────────────────────────────────

function lumen_up_read_json(string $path): ?array {
    if (!is_file($path)) return null;
    $sz = @filesize($path);
    if ($sz === false || $sz > LUMEN_UP_MAX_JSON) return null;
    $raw = @file_get_contents($path);
    if ($raw === false) return null;
    $d = json_decode($raw, true);
    return is_array($d) ? $d : null;
}

function lumen_up_head(string $path, int $n): string {
    $fh = @fopen($path, 'rb');
    if ($fh === false) return '';
    $head = (string)@fread($fh, $n);
    @fclose($fh);
    return $head;
}

function lumen_up_validate_file(string $type, string $rel, string $path, ?string $kind): array {
    if ($kind === 'metadata' || $rel === 'metadata.json') {
        $meta = lumen_up_read_json($path);
        if ($meta === null) return [false, 'metadata_not_json'];
        return lumen_up_validate_metadata($meta, $type);
    }
    if ($kind === 'manifest') {
        $man = lumen_up_read_json($path);
        if ($man === null) return [false, 'manifest_not_json'];
        return lumen_up_validate_manifest($man);
    }
    if (in_array($kind, ['thumbnail', 'preview', 'image'], true)) {
        $head = lumen_up_head($path, 16);
        if (strncmp($head, 'RIFF', 4) !== 0 && strncmp($head, "\x89PNG\r\n\x1a\n", 8) !== 0) return [false, $kind . '_not_image'];
        return [true, null];
    }
    if ($kind === 'planes_manifest' || $kind === 'mips_manifest') {
        $doc = lumen_up_read_json($path);
        $schema = $kind === 'planes_manifest' ? 'lumen-planes-v1' : 'lumen-mips-v1';
        if ($doc === null || ($doc['schema'] ?? null) !== $schema) return [false, $kind . '_invalid'];
        return [true, null];
    }
    if ($kind === 'planes_pack' || $kind === 'mips_pack') {
        // Magic, version 1 and a file long enough for its own entry table (16 + 12·C·TY·TX,
        // SPEC §3.2; a MIP pack has the same layout, §12).
        $magic = $kind === 'planes_pack' ? 'LPLN' : 'LMIP';
        $head = lumen_up_head($path, 16);
        if (strlen($head) < 16 || strncmp($head, $magic, 4) !== 0) return [false, $kind . '_bad_magic'];
        $h = unpack('vver/vch/vtx/vty', substr($head, 4, 8));
        clearstatcache(true, $path);
        if ($h['ver'] !== 1 || !$h['ch'] || !$h['tx'] || !$h['ty'] || (int)@filesize($path) < 16 + 12 * $h['ch'] * $h['tx'] * $h['ty']) return [false, $kind . '_bad_header'];
        return [true, null];
    }
    if ($kind === 'index') {
        clearstatcache(true, $path);
        $sz = @filesize($path);
        if ($sz === false || $sz > LUMEN_UP_INDEX_V3_MAX) return [false, 'index_too_large'];
        $shape = lumen_up_index_v3_shape((string)@file_get_contents($path));
        return [$shape[0], $shape[1]];
    }
    if ($kind === 'extra' && substr($rel, -4) === '.glb') {
        if (strncmp(lumen_up_head($path, 4), 'glTF', 4) !== 0) return [false, 'glb_bad_magic'];
        return [true, null];
    }
    if ($kind === 'extra' && strncmp($rel, 'tracks.json', 11) === 0 && substr($rel, -3) !== '.gz') {
        if (lumen_up_read_json($path) === null) return [false, 'tracks_not_json'];
        return [true, null];
    }
    return [true, null];
}

/**
 * Mirror of js/core/brick-loader.js `_validateManifest`, minus the parts that
 * only matter once decoding starts.
 *
 * Checking merely that `levels` is non-empty was too weak: a manifest missing
 * per-level dimensions passed the import, reported "integrity verified", and then
 * made the viewer reject it at mount time. Catch it while it is still in staging.
 */
const LUMEN_UP_BRICK_SIZE = 64;   // twin of js/core/brick-loader.js BRICK_SIZE
const LUMEN_UP_ENCODINGS = ['raw-u8', 'raw-u8-gzip', 'raw-rgba-gzip', 'webp-lossless'];

// ── Brick pyramid v3 (format 4) — twin of upload_staging._index_v3_shape /
// _validate_manifest_v3 / _cross_check_v3 (the layout is documented there).
const LUMEN_UP_BRICKS_V3_SCHEMA = 'iribhm-bricks-v3';
const LUMEN_UP_INDEX_V3_MAX = 33554432;    // 32 MiB: ~0.8 M brick slots × 4 channels; read whole under a 128 MiB memory_limit

/** [ok, reason, levels [[gx, gy, gz, packs]], channels] of an index.bin: magic,
 *  version and EXACT length. */
function lumen_up_index_v3_shape(string $data): array {
    if (strlen($data) < 12 || strncmp($data, 'LBIX', 4) !== 0) return [false, 'index_bad_magic', [], 0];
    if (strlen($data) > LUMEN_UP_INDEX_V3_MAX) return [false, 'index_too_large', [], 0];
    $h = unpack('vver/vlevels/vch', substr($data, 4, 6));
    if ($h['ver'] !== 1 || !$h['levels'] || !$h['ch']) return [false, 'index_bad_header', [], 0];
    $pos = 12 + 16 * $h['levels'];
    if (strlen($data) < $pos) return [false, 'index_truncated', [], 0];
    $levels = [];
    $expected = $pos;
    for ($i = 0; $i < $h['levels']; $i++) {
        $l = array_values(unpack('V4', substr($data, 12 + 16 * $i, 16)));
        $levels[] = $l;
        $expected += 10 * $h['ch'] * $l[0] * $l[1] * $l[2];
    }
    if (strlen($data) !== $expected) return [false, 'index_bad_length', [], 0];
    return [true, null, $levels, $h['ch']];
}

/** [[tree key, index info]]: ['', index] for a 3d tree, ['tNNN', index] per frame;
 *  [null, null] for a malformed timepoint row. */
function lumen_up_v3_trees(array $man): array {
    $tps = $man['timepoints'] ?? null;
    if ($tps === null) return [['', $man['index'] ?? null]];
    if (!is_array($tps) || !$tps) return [[null, null]];
    $out = [];
    foreach ($tps as $row) {
        $key = is_array($row) ? ($row['path'] ?? null) : null;
        $out[] = is_string($key) && preg_match('/^t[0-9]{3,6}$/D', $key) ? [$key, $row['index'] ?? null] : [null, null];
    }
    return $out;
}

function lumen_up_validate_manifest_v3(array $man): array {
    if (($man['version'] ?? null) !== 3) return [false, 'manifest_v3_bad_version'];
    if (!is_int($man['channels'] ?? null) || $man['channels'] < 1) return [false, 'manifest_bad_channels'];
    if (($man['brickSize'] ?? null) !== LUMEN_UP_BRICK_SIZE || ($man['apron'] ?? null) !== 1) return [false, 'manifest_bad_brick_size'];
    $p = $man['brickPacking'] ?? null;
    if (!is_array($p) || ($p['mode'] ?? null) !== 'grid' || ($p['cols'] ?? null) !== 9
        || ($p['rows'] ?? null) !== 8 || ($p['slice'] ?? null) !== 66) return [false, 'manifest_bad_packing_grid'];
    if (($man['encoding'] ?? null) !== 'webp-lossless') return [false, 'manifest_bad_encoding'];
    $levels = $man['levels'] ?? null;
    if (!is_array($levels) || !$levels || array_keys($levels) !== range(0, count($levels) - 1)) return [false, 'manifest_no_levels'];
    foreach ($levels as $i => $level) {
        if (!is_array($level) || ($level['level'] ?? null) !== $i) return [false, "manifest_level_{$i}_out_of_order"];
        foreach (['dimensions', 'gridSize'] as $key) {
            $d = $level[$key] ?? null;
            if (!is_array($d)) return [false, "manifest_level_{$i}_bad_{$key}"];
            foreach (['x', 'y', 'z'] as $a) {
                if (!is_int($d[$a] ?? null) || $d[$a] <= 0) return [false, "manifest_level_{$i}_bad_{$key}"];
            }
        }
    }
    foreach (lumen_up_v3_trees($man) as [$key, $info]) {
        if ($key === null) return [false, 'manifest_v3_bad_timepoints'];
        $want = $key !== '' ? "$key/index.bin" : 'index.bin';
        if (!is_array($info) || ($info['url'] ?? null) !== $want || !is_int($info['bytes'] ?? null)
            || !is_string($info['sha256'] ?? null) || !preg_match('/^[0-9a-f]{64}$/D', $info['sha256'])) {
            return [false, 'manifest_v3_bad_index'];
        }
    }
    return [true, null];
}

/** Every tree's index.bin is the one the manifest hashed, matches its levels and
 *  channels, and every brick it lists lies inside a pack that arrived. */
function lumen_up_cross_check_v3(string $dir, array $man): array {
    $errors = [];
    $levels = $man['levels'] ?? [];
    foreach (lumen_up_v3_trees($man) as [$key, $info]) {
        $tree = $key !== '' ? "$dir/bricks/$key" : "$dir/bricks";
        $label = $key !== '' ? $key : 'bricks';
        clearstatcache(true, "$tree/index.bin");
        $sz = @filesize("$tree/index.bin");
        if ($sz === false) { $errors[] = "missing_index:$label"; continue; }
        $data = $sz <= LUMEN_UP_INDEX_V3_MAX ? (string)@file_get_contents("$tree/index.bin") : '';
        if (strlen($data) !== $info['bytes'] || hash('sha256', $data) !== $info['sha256']) { $errors[] = "index_hash_mismatch:$label"; continue; }
        [$ok, $reason, $idxLevels, $channels] = lumen_up_index_v3_shape($data);
        if (!$ok) { $errors[] = "$reason:$label"; continue; }
        if (count($idxLevels) !== count($levels) || $channels !== ($man['channels'] ?? null)) { $errors[] = "index_shape_mismatch:$label"; continue; }
        $pos = 12 + 16 * count($idxLevels);
        $prefix = $key !== '' ? "$key/" : '';
        foreach ($idxLevels as $k => [$gx, $gy, $gz]) {
            $g = $levels[$k]['gridSize'] ?? [];
            if ([$gx, $gy, $gz] !== [$g['x'] ?? null, $g['y'] ?? null, $g['z'] ?? null]) { $errors[] = "index_grid_mismatch:$label:l$k"; break; }
            $n = $gx * $gy * $gz;
            for ($c = 0; $c < $channels; $c++) {
                $extent = [];
                for ($b = 0; $b < $n; $b++, $pos += 10) {
                    $e = unpack('vpack/Voffset/Vlength', $data, $pos);
                    if ($e['length'] === 0) continue;
                    $end = $e['offset'] + $e['length'];
                    if ($end > ($extent[$e['pack']] ?? 0)) $extent[$e['pack']] = $end;
                }
                foreach ($extent as $pack => $end) {
                    $rel = sprintf('l%d/c%d/p%05d.bin', $k, $c, $pack);
                    clearstatcache(true, "$tree/$rel");
                    $size = @filesize("$tree/$rel");
                    if ($size === false) $errors[] = "missing_pack:$prefix$rel";
                    elseif ($size < $end) $errors[] = "truncated_pack:$prefix$rel";
                }
                if (count($errors) >= 20) return $errors;
            }
        }
    }
    return $errors;
}

function lumen_up_validate_manifest(array $man): array {
    if (($man['schema'] ?? null) === LUMEN_UP_BRICKS_V3_SCHEMA) return lumen_up_validate_manifest_v3($man);
    $levels = $man['levels'] ?? null;
    if (!is_array($levels) || !$levels || array_keys($levels) !== range(0, count($levels) - 1)) return [false, 'manifest_no_levels'];
    if (array_key_exists('channels', $man) && $man['channels'] !== null
        && !(is_int($man['channels']) && $man['channels'] >= 1)) return [false, 'manifest_bad_channels'];
    // The decoder, the GPU atlas and the shaders are all built on 64-voxel bricks.
    if (array_key_exists('brickSize', $man) && $man['brickSize'] !== LUMEN_UP_BRICK_SIZE) return [false, 'manifest_bad_brick_size'];
    foreach ($levels as $i => $level) {
        if (!is_array($level)) return [false, "manifest_level_{$i}_not_object"];
        $lvl = $level['level'] ?? null;
        if (!is_int($lvl) || $lvl < 0) return [false, "manifest_level_{$i}_bad_index"];
        // A level is addressed by its number everywhere (lod<N>/ pack paths, the
        // quality ladder): listed out of order, one level's bricks mount as another's.
        if ($lvl !== $i) return [false, "manifest_level_{$i}_out_of_order"];
        $dims = $level['dimensions'] ?? null;
        if (!is_array($dims)) return [false, "manifest_level_{$i}_no_dimensions"];
        foreach (['x', 'y', 'z'] as $axis) {
            $v = $dims[$axis] ?? null;
            if ((!is_int($v) && !is_float($v)) || $v <= 0) return [false, "manifest_level_{$i}_bad_{$axis}"];
        }
        if (array_key_exists('brickSize', $level) && $level['brickSize'] !== LUMEN_UP_BRICK_SIZE) {
            return [false, "manifest_level_{$i}_bad_brick_size"];
        }
    }
    $transport = $man['brickTransport'] ?? null;
    $encoding = is_array($transport) ? ($transport['encoding'] ?? null) : null;
    if ($encoding !== null && !in_array($encoding, LUMEN_UP_ENCODINGS, true)) return [false, 'manifest_bad_encoding'];
    // An absent packing is not "vertical": decoding a grid mosaic linearly scrambles
    // the volume silently. When present it must name a mode the decoder knows.
    $packing = $man['brickPacking'] ?? null;
    if ($packing !== null) {
        if (!is_array($packing) || !in_array($packing['mode'] ?? null, ['grid', 'vertical'], true)) {
            return [false, 'manifest_bad_packing_mode'];
        }
        if ($packing['mode'] === 'grid') {
            foreach (['cols', 'rows'] as $k) {
                if (array_key_exists($k, $packing) && !(is_int($packing[$k]) && $packing[$k] >= 1)) {
                    return [false, 'manifest_bad_packing_grid'];
                }
            }
        }
    }
    if ($encoding === 'webp-lossless' && !(is_array($packing) && ($packing['mode'] ?? null) === 'grid')) {
        return [false, 'manifest_lossless_needs_grid'];
    }
    return [true, null];
}

function lumen_up_validate_metadata(array $meta, string $type): array {
    if (!isset($meta['type']) || !in_array($meta['type'], LUMEN_UP_TYPES, true)) return [false, 'metadata_bad_type'];
    if ($meta['type'] !== $type) return [false, 'metadata_type_mismatch'];
    if (!isset($meta['dimensions']) || !is_array($meta['dimensions'])) return [false, 'metadata_no_dimensions'];
    foreach (['x', 'y', 'z', 'c'] as $axis) {
        $v = $meta['dimensions'][$axis] ?? null;
        if (!is_int($v) && !is_float($v)) return [false, 'metadata_bad_dimensions'];
        if ($v <= 0) return [false, 'metadata_bad_dimensions'];
    }
    if ($meta['type'] === '2d') return lumen_up_validate_2d_meta($meta);
    if (!isset($meta['channels']) || !is_array($meta['channels']) || !$meta['channels']) return [false, 'metadata_no_channels'];
    return [true, null];
}

/** A '2d' dataset mounts from its `image` block, not from channels; the file names
 *  are pinned to the allowlist so metadata cannot point elsewhere. */
function lumen_up_validate_2d_meta(array $meta): array {
    $image = $meta['image'] ?? null;
    if (!is_array($image)) return [false, 'metadata_no_image'];
    if (($image['native'] ?? null) !== 'image.webp' || ($image['preview'] ?? null) !== 'preview.webp') return [false, 'metadata_bad_image'];
    foreach (['width', 'height'] as $k) {
        $v = $image[$k] ?? null;
        if ((!is_int($v) && !is_float($v)) || $v <= 0) return [false, 'metadata_bad_image'];
    }
    return [true, null];
}

function lumen_up_check_bricks(string $dir): array {
    if (!is_file("$dir/bricks/manifest.json")) return ['missing_manifest'];
    $man = lumen_up_read_json("$dir/bricks/manifest.json");
    if ($man === null) return ['manifest_not_json'];
    [$ok, $reason] = lumen_up_validate_manifest($man);
    $errors = $ok ? [] : [$reason ?: 'manifest_invalid'];
    if (($man['schema'] ?? null) === LUMEN_UP_BRICKS_V3_SCHEMA) {
        return $ok ? array_merge($errors, lumen_up_cross_check_v3($dir, $man)) : $errors;
    }
    return array_merge($errors, lumen_up_cross_check_packs($dir, $man));
}

/** Both display copies must have arrived: the page paints the preview at once
 *  and swaps in the native image, so neither may be missing or empty. */
function lumen_up_check_2d_files(string $dir): array {
    $errors = [];
    foreach (LUMEN_UP_2D_FILES as $rel => [$tier, $kind]) {
        if (!is_file("$dir/$rel") || filesize("$dir/$rel") === 0) $errors[] = "missing_$kind";
    }
    return $errors;
}

function lumen_up_validate_dataset($type, $folder): array {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return ['ok' => false, 'errors' => ['invalid_dataset']];
    [$type, $folder] = $safe;
    $dir = lumen_up_dataset_dir($type, $folder);
    $journal = lumen_up_load_journal($type, $folder);
    if ($dir === null || $journal === null) return ['ok' => false, 'errors' => ['not_staged']];

    $errors = []; $warnings = [];
    if (!is_file("$dir/metadata.json")) {
        $errors[] = 'missing_metadata';
    } else {
        $meta = lumen_up_read_json("$dir/metadata.json");
        if ($meta === null) $errors[] = 'metadata_not_json';
        else { [$ok, $r] = lumen_up_validate_metadata($meta, $type); if (!$ok) $errors[] = $r ?: 'metadata_invalid'; }
    }
    $errors = array_merge($errors, in_array($type, LUMEN_UP_VOLUME_TYPES, true)
        ? lumen_up_check_bricks($dir) : lumen_up_check_2d_files($dir));

    $incomplete = [];
    foreach (($journal['files'] ?? []) as $rel => $e) if (empty($e['done'])) $incomplete[] = $rel;
    if ($incomplete) { $errors[] = 'incomplete_files'; sort($incomplete); $warnings = array_merge($warnings, array_slice($incomplete, 0, 20)); }

    $stray = lumen_up_find_stray($dir, $type);
    if ($stray) { $errors[] = 'stray_files'; $warnings = array_merge($warnings, array_slice($stray, 0, 20)); }

    return ['ok' => !$errors, 'errors' => array_values($errors), 'warnings' => array_values($warnings)];
}

/** The manifest's brickToPack index is the authority: every pack it references
 *  must exist and be long enough to contain the slice claimed of it.
 *
 *  A brickToPack url is relative to the folder its OWN timepoint is mounted from
 *  — js/core/brick-loader.js resolves it against `.../bricks/t007`, not against
 *  `bricks/`. A timelapse is therefore walked frame by frame, prefixing each index
 *  with that frame's `path`; checking the root index bare would hunt for a
 *  single-timepoint layout inside a timelapse and report every pack missing. The root
 *  index is a copy of the first frame's, so it only serves a manifest that
 *  declares no timepoints at all. Twin of upload_staging.py:_cross_check_packs. */
function lumen_up_cross_check_packs(string $dir, array $manifest): array {
    $needed = [];
    $timepoints = $manifest['timepoints'] ?? null;

    if (is_array($timepoints) && $timepoints) {
        foreach ($timepoints as $key => $row) {
            if (!is_array($row)) continue;
            $path = $row['path'] ?? null;
            $prefix = (is_string($path) && $path !== '') ? $path : (string)$key;
            // No fallback to the root index: it is the FIRST frame's, and every
            // frame packs its own bricks at its own offsets, so reusing it would
            // invent truncations. A frame that indexes nothing is asserted nothing
            // about — its files are still covered by their own hashes.
            $unsafe = lumen_up_collect_pack_extents($row['brickTransport'] ?? null, $needed, $prefix);
            if ($unsafe) return $unsafe;
        }
    } else {
        $unsafe = lumen_up_collect_pack_extents($manifest['brickTransport'] ?? null, $needed, null);
        if ($unsafe) return $unsafe;
    }

    $errors = [];
    foreach ($needed as $rel => $end) {
        $pack = "$dir/bricks/$rel";
        if (!is_file($pack)) $errors[] = "missing_pack:$rel";
        elseif ((int)@filesize($pack) < $end) $errors[] = "truncated_pack:$rel";
        if (count($errors) >= 20) break;
    }
    return $errors;
}

/** Fold one brickToPack index into {pack path: highest byte claimed of it}.
 *  Returns a non-empty array only to abort on an unsafe url; the extents it
 *  gathers are accumulated into $needed by reference. */
function lumen_up_collect_pack_extents($transport, array &$needed, ?string $prefix): array {
    if (!is_array($transport)) return [];
    $index = $transport['brickToPack'] ?? null;
    if (!is_array($index)) return [];
    foreach ($index as $entry) {
        if (!is_array($entry)) continue;
        $url = $entry['url'] ?? null;
        if (!is_string($url)) continue;
        $rel = lumen_up_safe_rel($prefix !== null ? "$prefix/$url" : $url);
        if ($rel === null) return ['manifest_unsafe_pack_url'];
        $end = (int)($entry['offset'] ?? 0) + (int)($entry['length'] ?? 0);
        if ($end > ($needed[$rel] ?? 0)) $needed[$rel] = $end;
    }
    return [];
}

/** Every file physically present that the allowlist would refuse. */
function lumen_up_find_stray(string $dir, string $type): array {
    $stray = [];
    if (!is_dir($dir)) return $stray;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY);
    foreach ($it as $file) {
        if (!$file->isFile()) continue;
        $rel = str_replace('\\', '/', substr($file->getPathname(), strlen($dir) + 1));
        if (lumen_up_classify($type, $rel) === null) {
            $stray[] = $rel;
            if (count($stray) >= 50) break;
        }
    }
    return $stray;
}

// ── State ────────────────────────────────────────────────────────────────────

function lumen_up_age(?string $iso): float {
    if (!$iso) return 0.0;
    $ts = strtotime($iso);
    return $ts === false ? 0.0 : max(0.0, time() - $ts);
}

function lumen_up_state_of($type, $folder, ?array $journal = null): string {
    if ($journal === null) $journal = lumen_up_load_journal($type, $folder);
    if ($journal === null) return LUMEN_UP_STATE_UPLOADING;
    $files = is_array($journal['files'] ?? null) ? $journal['files'] : [];
    if (!$files) return LUMEN_UP_STATE_UPLOADING;

    $pending = false;
    foreach ($files as $e) if (!is_array($e) || empty($e['done'])) { $pending = true; break; }
    if (!$pending) return LUMEN_UP_STATE_STAGED;

    // Openable once metadata plus a mount (brick manifest, or a '2d' preview) landed.
    $coreOk = true; $hasMount = false;
    foreach ($files as $e) {
        if (!is_array($e)) { $coreOk = false; continue; }
        if ((int)($e['tier'] ?? 9) <= LUMEN_UP_TIER_PREVIEW && empty($e['done'])) $coreOk = false;
        if (in_array($e['kind'] ?? '', ['manifest', 'preview'], true) && !empty($e['done'])) $hasMount = true;
    }
    $hasMeta = !empty($files['metadata.json']['done']);
    $state = ($coreOk && $hasMeta && $hasMount) ? LUMEN_UP_STATE_EDITABLE : LUMEN_UP_STATE_UPLOADING;

    $last = $journal['lastChunkAt'] ?? ($journal['updatedAt'] ?? null);
    if ($last && lumen_up_age($last) > LUMEN_UP_STALE_AFTER) return LUMEN_UP_STATE_STALLED;
    return $state;
}

function lumen_up_describe($type, $folder): ?array {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return null;
    [$type, $folder] = $safe;
    $journal = lumen_up_load_journal($type, $folder);
    if ($journal === null) return null;
    $files = is_array($journal['files'] ?? null) ? $journal['files'] : [];
    $total = 0; $got = 0; $done = 0;
    foreach ($files as $e) {
        if (!is_array($e)) continue;
        $total += (int)($e['size'] ?? 0);
        $got   += !empty($e['done']) ? (int)($e['size'] ?? 0) : lumen_up_received($e);
        if (!empty($e['done'])) $done++;
    }
    $dir = lumen_up_dataset_dir($type, $folder);
    $meta = $dir ? lumen_up_read_json("$dir/metadata.json") : null;
    $last = $journal['lastChunkAt'] ?? ($journal['updatedAt'] ?? ($journal['createdAt'] ?? null));
    $state = lumen_up_state_of($type, $folder, $journal);
    return [
        'key' => "$type/$folder", 'type' => $type, 'folder' => $folder,
        'name' => ($meta['name'] ?? null) ?: $folder,
        'state' => $state,
        'totalBytes' => $total, 'receivedBytes' => $got,
        'fileCount' => count($files), 'doneCount' => $done,
        'metaLocked' => !empty($journal['metaLocked']),
        'rejected' => $journal['rejected'] ?? [],
        'publishedExists' => is_file(data_web() . "/$type/$folder/metadata.json"),
        'updatedAt' => $journal['updatedAt'] ?? null,
        // The journal itself is only rewritten at plan/file completion; a long file
        // streams for hours in the chunk log alone, which still counts as activity.
        'lastActivityAt' => lumen_up_latest($journal['updatedAt'] ?? null, $journal['lastChunkAt'] ?? null),
        // Only an INCOMPLETE import is on the clock (see lumen_up_gc) — showing a
        // countdown on a finished one would promise a deletion that never comes.
        'expiresInS' => ($last && $state !== LUMEN_UP_STATE_STAGED)
            ? max(0, (int)(LUMEN_UP_STALE_AFTER - lumen_up_age($last))) : null,
        'hasThumbnail' => $dir ? is_file("$dir/thumbnail.webp") : false,
    ];
}

function lumen_up_latest(?string $a, ?string $b): ?string {
    if (!$a) return $b ?: null;
    if (!$b) return $a;
    return lumen_up_age($a) <= lumen_up_age($b) ? $a : $b;
}

function lumen_up_list(): array {
    $out = [];
    $dir = lumen_up_state();
    if (!is_dir($dir)) return $out;
    $names = scandir($dir) ?: [];
    sort($names);
    foreach ($names as $f) {
        if (substr($f, -5) !== '.json') continue;
        $stem = substr($f, 0, -5);
        $sep = strpos($stem, '__');
        if ($sep === false) continue;
        try {
            $info = lumen_up_describe(substr($stem, 0, $sep), substr($stem, $sep + 2));
        } catch (Throwable $e) {
            error_log("upload journal $f unreadable: " . $e->getMessage());
            continue;
        }
        if ($info) $out[] = $info;
    }
    return $out;
}

// ── Metadata edits while streaming ───────────────────────────────────────────

// Fields the server COMPUTES for the editor's view of a staged dataset (see
// lumen_staged_dataset). They are derived state, not dataset facts — and the
// editor round-trips whatever it was given, so without this they would be written
// into metadata.json and then survive publication, leaving a published dataset
// permanently flagged "staging". Twin: upload_staging.py _COMPUTED_META_KEYS.
const LUMEN_UP_COMPUTED = ['staging', 'stagingState', 'stagingEditable', 'path', 'key',
                           'totalBytes', 'receivedBytes', 'publishedExists', 'expiresInS'];

function lumen_up_read_metadata($type, $folder): ?array {
    $dir = lumen_up_dataset_dir($type, $folder);
    return $dir === null ? null : lumen_up_read_json("$dir/metadata.json");
}

function lumen_up_write_metadata($type, $folder, $meta): array {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return [400, ['error' => 'invalid_dataset']];
    [$type, $folder] = $safe;
    $dir = lumen_up_dataset_dir($type, $folder);
    if ($dir === null || !is_array($meta)) return [400, ['error' => 'bad_body']];

    $existing = lumen_read_json_doc("$dir/metadata.json") ?: [];
    $merged = array_merge($existing, array_diff_key($meta, array_flip(LUMEN_UP_COMPUTED)));
    if (isset($merged['volumeSources'])) {
        $merged['volumeSources'] = lumen_canonical_volume_sources($merged['volumeSources'], $type, $folder)[0];
    }
    $merged['type'] = $type;
    $merged['folderName'] = $folder;
    // One id shape everywhere: '<type>/<folder>'. It is what the catalog publishes
    // once this dataset is, and what every link the platform builds addresses.
    $merged['id'] = "$type/$folder";
    $merged['configured'] = true;
    $merged['lastModified'] = date('c');
    [$ok, $reason] = lumen_up_validate_metadata($merged, $type);
    if (!$ok) return [400, ['error' => $reason]];

    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, $dir, $merged) {
        if ($journal === null) return [409, ['error' => 'not_staged']];
        admin_make_dir($dir);
        if (!lumen_write_json_doc("$dir/metadata.json", $merged)) return [500, ['error' => 'write_failed']];
        $journal['metaLocked'] = true;
        $entry = $journal['files']['metadata.json'] ?? ['chunkSize' => LUMEN_UP_DEFAULT_CHUNK, 'kind' => 'metadata', 'tier' => LUMEN_UP_TIER_CORE];
        clearstatcache(true, "$dir/metadata.json");
        $entry['size'] = (int)@filesize("$dir/metadata.json");
        $entry['done'] = true;
        $entry['bits'] = lumen_up_bitmap_encode("\1");
        lumen_up_new_id($journal, $entry);
        $journal['files']['metadata.json'] = $entry;
        lumen_up_save_journal($journal);
        lumen_up_write_table($journal);
        return [200, ['ok' => true]];
    });
}

function lumen_up_write_thumbnail($type, $folder, string $bytes): array {
    $dir = lumen_up_dataset_dir($type, $folder);
    if ($dir === null) return [400, ['error' => 'invalid_dataset']];
    $isWebp = strncmp($bytes, 'RIFF', 4) === 0 && substr($bytes, 8, 4) === 'WEBP';
    if (!$isWebp && strncmp($bytes, "\x89PNG\r\n\x1a\n", 8) !== 0) return [400, ['error' => 'not_an_image']];
    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $dir, $bytes) {
        if ($journal === null) return [409, ['error' => 'not_staged']];
        admin_make_dir($dir);
        if (!lumen_write_file_atomic("$dir/thumbnail.webp", $bytes)) return [500, ['error' => 'write_failed']];
        $entry = $journal['files']['thumbnail.webp'] ?? ['chunkSize' => LUMEN_UP_DEFAULT_CHUNK, 'kind' => 'thumbnail', 'tier' => LUMEN_UP_TIER_CORE];
        $entry['size'] = strlen($bytes);
        $entry['done'] = true;
        $entry['bits'] = lumen_up_bitmap_encode("\1");
        lumen_up_new_id($journal, $entry);
        $journal['files']['thumbnail.webp'] = $entry;
        lumen_up_save_journal($journal);
        lumen_up_write_table($journal);
        return [200, ['ok' => true]];
    });
}

// ── Publish / discard / GC ───────────────────────────────────────────────────

function lumen_up_rrmdir(string $dir): void {
    if (!is_dir($dir)) return;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) { $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname()); }
    @rmdir($dir);
}

function lumen_up_rcopy(string $src, string $dst): bool {
    admin_make_dir($dst);
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($src, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST);
    foreach ($it as $f) {
        $rel = substr($f->getPathname(), strlen($src) + 1);
        $target = $dst . '/' . $rel;
        if ($f->isDir()) { admin_make_dir($target); continue; }
        if (!@copy($f->getPathname(), $target)) return false;
        admin_fix_file_mode($target);
    }
    return true;
}

function lumen_up_publish($type, $folder, bool $overwrite, bool $hidden): array {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return [400, ['error' => 'invalid_dataset']];
    [$type, $folder] = $safe;
    $src = lumen_up_dataset_dir($type, $folder);
    if ($src === null || !is_dir($src)) return [404, ['error' => 'not_staged']];

    lumen_up_recover_publish_leftovers();
    $destBase = data_web() . "/$type";
    $dest = "$destBase/$folder";
    if (is_dir($dest) && !$overwrite) return [409, ['error' => 'already_exists']];

    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, $src, $dest, $destBase, $hidden): array {
        // Validated INSIDE the journal lock: a chunk acknowledged between a check
        // made outside it and the move would be published unvalidated.
        $verdict = lumen_up_validate_dataset($type, $folder);
        if (empty($verdict['ok'])) return [409, array_merge(['error' => 'validation_failed'], $verdict)];
        $carried = ['carriedKeys' => [], 'carriedGallery' => false];
        $meta = lumen_read_json_doc("$src/metadata.json") ?: [];
        $changed = false;
        if (is_dir($dest)) {
            // Re-publishing over a live dataset replaces what the pipeline measures,
            // not what the operator curated: those keys are carried over unless the
            // new upload states them itself (twin of upload_staging.publish_dataset).
            $old = lumen_read_json_doc("$dest/metadata.json") ?: [];
            foreach (LUMEN_UP_CURATED_KEYS as $k) {
                if (array_key_exists($k, $old) && !array_key_exists($k, $meta)) {
                    $meta[$k] = $old[$k];
                    $carried['carriedKeys'][] = $k;
                    $changed = true;
                }
            }
        }
        if ($hidden) { $meta['hidden'] = true; $changed = true; }
        if ($changed && !lumen_write_json_doc("$src/metadata.json", $meta)) return [500, ['error' => 'publish_failed']];
        admin_make_dir($destBase);
        $replaced = null;
        if (is_dir($dest)) {
            $replaced = "$destBase/.replaced-$folder-" . time();
            if (!@rename($dest, $replaced)) return [500, ['error' => 'publish_failed']];
        }
        if (!@rename($src, $dest)) {
            // Cross-device staging: copy into a sibling temp, then rename into
            // place so $dest is never partially populated.
            $tmp = "$destBase/.incoming-$folder-" . time();
            lumen_up_rrmdir($tmp);
            if (!lumen_up_rcopy($src, $tmp)) {
                lumen_up_rrmdir($tmp);
                if ($replaced !== null) @rename($replaced, $dest);
                return lumen_up_disk_full(1 << 20) ? [507, ['error' => 'insufficient_disk', 'freeBytes' => lumen_up_free_bytes()]] : [500, ['error' => 'publish_failed']];
            }
            if (!@rename($tmp, $dest)) {
                lumen_up_rrmdir($tmp);
                if ($replaced !== null) @rename($replaced, $dest);
                return [500, ['error' => 'publish_failed']];
            }
            lumen_up_rrmdir($src);
        }
        if ($replaced !== null) {
            $carried['carriedGallery'] = lumen_up_carry_gallery($replaced, $dest);
            lumen_up_rrmdir($replaced);
        }
        lumen_catalog_invalidate();
        lumen_up_remove_state_files($type, $folder);
        @rmdir(lumen_up_staging() . "/$type");
        return [200, array_merge(['ok' => true, 'id' => "$type/$folder", 'hidden' => $hidden], $carried)];
    });
}

// Twin of upload_staging.CURATED_KEYS (itself the copy of preprocess/run_preprocess.py
// CURATED_KEYS). `formatVersion` is pipeline-owned and never carried over.
const LUMEN_UP_CURATED_KEYS = [
    'name', 'description', 'stage', 'stageNumeric', 'embryo', 'line', 'staining',
    'reporter', 'hidden', 'gallery', 'tags', 'notes', 'created',
    'orientation', 'orientationAxes', 'upsideDown', 'defaultView', 'exposure',
    'linkedTrackingId', 'relatedIds',
];

/** Twin of upload_staging._carry_gallery: move the replaced dataset's gallery/ into
 *  the new one, then keep only the gallery entries whose file is really there. */
function lumen_up_carry_gallery(string $oldDir, string $newDir): bool {
    $src = "$oldDir/gallery";
    $dst = "$newDir/gallery";
    $moved = false;
    if (is_dir($src) && !file_exists($dst)) {
        $moved = @rename($src, $dst);
        if (!$moved) {
            $moved = lumen_up_rcopy($src, $dst);
            if (!$moved) lumen_up_rrmdir($dst);
        }
    }
    $meta = lumen_read_json_doc("$newDir/metadata.json");
    if (is_array($meta) && isset($meta['gallery']) && is_array($meta['gallery'])) {
        $kept = [];
        foreach ($meta['gallery'] as $e) {
            if (is_array($e) && lumen_up_gallery_file_present($dst, $e['file'] ?? null)) $kept[] = $e;
        }
        if ($kept !== $meta['gallery']) {
            if ($kept) $meta['gallery'] = $kept; else unset($meta['gallery']);
            lumen_write_json_doc("$newDir/metadata.json", $meta);
        }
    }
    return $moved;
}

function lumen_up_gallery_file_present(string $gdir, $name): bool {
    if (!is_string($name)) return false;
    $name = trim(str_replace('\\', '/', $name), '/');
    if (strncmp($name, 'gallery/', 8) === 0) $name = substr($name, 8);
    if ($name === '' || strpos($name, '/') !== false || $name[0] === '.') return false;
    return is_file("$gdir/$name");
}

/**
 * Settle what an interrupted publish left in DATA_WEB/<type>/ (twin of
 * upload_staging.recover_publish_leftovers). `.replaced-<folder>-<ts>` is the
 * previous copy of a dataset: put back when <folder> itself is missing (the request
 * died between the two renames), deleted otherwise. `.incoming-<folder>-<ts>` is a
 * partial cross-volume copy, always deleted. PHP has no start-up hook, so this runs
 * on the admin paths that list or publish datasets; a tree with no dot-folder costs
 * one scandir per type. Returns one line per action.
 */
function lumen_up_recover_publish_leftovers(): array {
    $log = [];
    foreach (LUMEN_UP_TYPES as $type) {
        $base = data_web() . "/$type";
        if (!is_dir($base)) continue;
        $names = @scandir($base) ?: [];
        foreach ($names as $name) {
            if ($name === '.' || $name === '..' || $name[0] !== '.' || !is_dir("$base/$name") || is_link("$base/$name")) continue;
            if (preg_match('/^\.replaced-(.+)-(\d+)\z/', $name, $m)) {
                $folder = $m[1];
                $live = "$base/$folder";
                if (lumen_up_safe_dataset($type, $folder) !== null && !file_exists($live)) {
                    $log[] = @rename("$base/$name", $live)
                        ? "restored $type/$folder from an interrupted publish"
                        : "FAILED restoring $type/$folder";
                    continue;
                }
                lumen_up_rrmdir("$base/$name");
                $log[] = (is_dir("$base/$name") ? 'could not fully remove ' : 'removed ') . "$type/$name";
            } elseif (preg_match('/^\.incoming-(.+)-(\d+)\z/', $name)) {
                lumen_up_rrmdir("$base/$name");
                $log[] = (is_dir("$base/$name") ? 'could not fully remove ' : 'removed ') . "$type/$name";
            }
        }
    }
    if ($log) lumen_catalog_invalidate();
    return $log;
}

function lumen_up_discard($type, $folder): array {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return [400, ['error' => 'invalid_dataset']];
    [$type, $folder] = $safe;
    $dir = lumen_up_dataset_dir($type, $folder);
    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, $dir) {
        if ($dir !== null) lumen_up_rrmdir($dir);
        lumen_up_remove_state_files($type, $folder);
        @rmdir(lumen_up_staging() . "/$type");
        return [200, ['ok' => true]];
    });
}

/**
 * One byte range of a file of $size bytes (RFC 9110 §14). Twin of dev_server.py
 * _parse_byte_range, answer for answer:
 *   [start, end] (inclusive) — "a-b", "a-" (to the end) or "-n" (the LAST n bytes);
 *                              an end beyond the file is clamped;
 *   null  — absent, malformed or multi-part: the whole file is sent (200), which a
 *           server may always do;
 *   false — unsatisfiable (a start at or past the end, "-0", any range of an empty
 *           file): answer 416 with "Content-Range: bytes * /size".
 * @return array{0:int,1:int}|null|false
 */
function lumen_up_parse_range(string $header, int $size) {
    if ($header === '' || !preg_match('/^\s*bytes\s*=\s*([0-9]{0,19})\s*-\s*([0-9]{0,19})\s*\z/', $header, $m)) return null;
    [$lo, $hi] = [$m[1], $m[2]];
    if ($lo === '' && $hi === '') return null;
    if ($lo === '') {
        $n = (int)$hi;
        if ($n === 0 || $size <= 0) return false;
        return [max(0, $size - $n), $size - 1];
    }
    $start = (int)$lo;
    if ($hi !== '' && (int)$hi < $start) return null;
    if ($start >= $size) return false;
    return [$start, $hi !== '' ? min((int)$hi, $size - 1) : $size - 1];
}

// ── Staged datasets in the admin editor ──────────────────────────────────────
// A staged dataset is addressed as "staging:<type>/<folder>". The prefix is the
// whole routing decision: it tells the editor to read/write the staging store
// instead of DATA_WEB, and it tells the viewer to stream bytes through the
// authenticated blob proxy instead of a static DATA_WEB URL (js/pages/viewer.js
// _datasetBase). Twin of dev_server.py's _STAGING_PREFIX helpers.

const LUMEN_STAGING_PREFIX = 'staging:';

function lumen_split_staged_id(string $id): array {
    $body  = substr($id, strlen(LUMEN_STAGING_PREFIX));
    $slash = strpos($body, '/');
    return $slash === false ? [$body, ''] : [substr($body, 0, $slash), substr($body, $slash + 1)];
}

function lumen_staged_blob_url(string $type, string $folder, string $rel): string {
    return 'api/upload.php?action=blob&ds=' . rawurlencode("$type/$folder") . '&path=' . $rel;
}

function lumen_staged_rows(): array {
    $rows = [];
    foreach (lumen_up_list() as $info) {
        $type = $info['type']; $folder = $info['folder'];
        $meta = lumen_up_read_metadata($type, $folder) ?: [];
        $editable = in_array($info['state'], [LUMEN_UP_STATE_EDITABLE, LUMEN_UP_STATE_STAGED], true);
        $rows[] = [
            'id'            => LUMEN_STAGING_PREFIX . "$type/$folder",
            'path'          => LUMEN_STAGING_PREFIX . "$type/$folder",
            'name'          => ($meta['name'] ?? null) ?: ($info['name'] ?: $folder),
            'folderName'    => $folder,
            'type'          => $type,
            'stage'         => $meta['stage'] ?? null,
            'stageNumeric'  => $meta['stageNumeric'] ?? 0,
            'embryo'        => $meta['embryo'] ?? null,
            'channels'      => $meta['channels'] ?? [],
            'dimensions'    => $meta['dimensions'] ?? [],
            'configured'    => !empty($meta['configured']),
            'hidden'        => true,                    // never in the public catalog
            'thumbnail'     => !empty($info['hasThumbnail']) ? lumen_staged_blob_url($type, $folder, 'thumbnail.webp') : null,
            'staging'         => true,
            'stagingState'    => $info['state'],
            'stagingEditable' => $editable,
            'totalBytes'      => $info['totalBytes'],
            'receivedBytes'   => $info['receivedBytes'],
            'publishedExists' => $info['publishedExists'],
            'expiresInS'      => $info['expiresInS'] ?? null,
        ];
    }
    return $rows;
}

function lumen_staged_dataset(string $type, string $folder): ?array {
    $info = lumen_up_describe($type, $folder);
    if ($info === null) return null;
    $meta = lumen_up_read_metadata($type, $folder);
    if ($meta === null) return null;
    $meta['id']   = LUMEN_STAGING_PREFIX . "$type/$folder";
    $meta['path'] = LUMEN_STAGING_PREFIX . "$type/$folder";
    $meta['folderName'] = $folder;
    $meta['type'] = $type;
    $meta['staging'] = true;
    $meta['stagingState'] = $info['state'];
    $meta['stagingEditable'] = in_array($info['state'], [LUMEN_UP_STATE_EDITABLE, LUMEN_UP_STATE_STAGED], true);
    $meta['hidden'] = true;
    // Rewrite the pipeline's DATA_WEB-relative source paths onto the proxy so the
    // admin preview can mount a dataset that is not web-served yet.
    if (isset($meta['volumeSources']) && is_array($meta['volumeSources'])) {
        $out = [];
        foreach ($meta['volumeSources'] as $src) {
            if (!is_array($src)) continue;
            $src['path'] = lumen_staged_blob_url($type, $folder, '');
            if (!empty($src['manifestPath'])) $src['manifestPath'] = lumen_staged_blob_url($type, $folder, 'bricks/manifest.json');
            $out[] = $src;
        }
        $meta['volumeSources'] = $out;
    }
    return $meta;
}

/**
 * Reclaim INCOMPLETE imports untouched for longer than the grace period.
 *
 * A dataset in LUMEN_UP_STATE_STAGED is deliberately exempt: it is complete, it
 * passed validation, and the only thing left is a human clicking Publish.
 * Reclaiming that after a week away would delete tens of gigabytes of finished
 * work. The grace period covers uploads that DIED — see the Python twin.
 */
function lumen_up_gc(int $maxAge = LUMEN_UP_STALE_AFTER): array {
    return lumen_up_gc_and_list($maxAge)[0];
}

/** lumen_up_gc() plus the descriptions of what it kept — the admin list needs both,
 *  and walking every journal twice per poll was half its cost. */
function lumen_up_gc_and_list(int $maxAge = LUMEN_UP_STALE_AFTER): array {
    $removed = []; $kept = [];
    foreach (lumen_up_list() as $info) {
        $last = $info['lastActivityAt'] ?? ($info['updatedAt'] ?? null);
        $expired = !empty($last) && lumen_up_age($last) > $maxAge;
        if ($expired && ($info['state'] ?? '') !== LUMEN_UP_STATE_STAGED) {
            lumen_up_discard($info['type'], $info['folder']);
            $removed[] = $info['key'];
        } else {
            $kept[] = $info;
        }
    }
    return [['removed' => $removed, 'kept' => count($kept)], $kept];
}
