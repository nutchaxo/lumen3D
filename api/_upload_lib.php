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

const LUMEN_UP_TIER_CORE = 0, LUMEN_UP_TIER_PREVIEW = 1, LUMEN_UP_TIER_MID = 2,
      LUMEN_UP_TIER_FULL = 3, LUMEN_UP_TIER_EXTRA = 4;

const LUMEN_UP_STATE_UPLOADING = 'uploading';
const LUMEN_UP_STATE_EDITABLE  = 'editable';
const LUMEN_UP_STATE_STAGED    = 'staged';
const LUMEN_UP_STATE_STALLED   = 'stalled';

function lumen_up_root(): string     { return admin_root() . '/uploads'; }
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

const LUMEN_UP_DOWNLOAD_EXT = ['ims','tif','tiff','png','jpg','jpeg','webp','gif',
                               'zip','txt','md','csv','json','pdf','xml','gz','h5','hdf5'];

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
    if (!in_array($type, ['fixed', 'live', 'tracking'], true)) return null;

    if ($rel === 'metadata.json')  return [LUMEN_UP_TIER_CORE, 'metadata'];
    if ($rel === 'thumbnail.webp') return [LUMEN_UP_TIER_CORE, 'thumbnail'];
    $rootExtra = ['model.glb' => LUMEN_UP_TIER_FULL, 'tracks.json' => LUMEN_UP_TIER_PREVIEW,
                  'tracks.json.gz' => LUMEN_UP_TIER_PREVIEW, 'meta.json' => LUMEN_UP_TIER_CORE];
    if (isset($rootExtra[$rel])) return [$rootExtra[$rel], 'extra'];

    if (strncmp($rel, 'download/', 9) === 0) {
        $name = substr($rel, 9);
        if (strpos($name, '/') !== false) return null;
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,180}$/', $name)) return null;
        $dot = strrpos($name, '.');
        $ext = $dot === false ? '' : strtolower(substr($name, $dot + 1));
        if (!in_array($ext, LUMEN_UP_DOWNLOAD_EXT, true)) return null;
        return [LUMEN_UP_TIER_EXTRA, 'download'];
    }

    if (strncmp($rel, 'bricks/', 7) !== 0) return null;
    $inner = substr($rel, 7);
    if ($inner === 'manifest.json') return [LUMEN_UP_TIER_CORE, 'manifest'];

    $timepoint = null;
    if (preg_match('#^t(\d{1,6})/(.+)$#', $inner, $m)) {
        if ($type !== 'live' && $type !== 'tracking') return null;
        $timepoint = (int)$m[1];
        $inner = $m[2];
        if ($inner === 'manifest.json') return [LUMEN_UP_TIER_CORE, 'manifest'];
    }
    if (!preg_match('#^lod(\d{1,2})/(c\d{1,2}|rgba)/pack_\d{1,6}\.bin$#', $inner, $m)) return null;
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
    if (!preg_match('#^lod(\d{1,2})/#', $inner, $m)) return null;
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
    if (!in_array($type, ['fixed', 'live', 'tracking'], true)) return null;
    if ($folder === '.' || $folder === '..' || strlen($folder) > 180) return null;
    if (!preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/', $folder)) return null;
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

function lumen_up_write_guard(string $path, string $body): void {
    if (!is_dir(dirname($path))) return;
    if (!is_file($path) || @file_get_contents($path) !== $body) @file_put_contents($path, $body);
}

/**
 * Create the staging root and (re)assert both directory guards.
 *
 * Written at runtime rather than relying on the shipped files: DATA_WEB is in the
 * updater's protect list, so a deployed host would otherwise never receive its
 * execution ban through an update, and a staging root created at runtime would
 * have no deny rule at all until the next release.
 */
function lumen_up_ensure_dirs(): void {
    admin_make_dir(lumen_up_staging());
    admin_make_dir(lumen_up_state());
    lumen_up_write_guard(lumen_up_root() . '/.htaccess',
        "# Lumen3D upload staging — bytes here have NOT been validated yet and must\n"
      . "# never be reachable at a URL. The admin preview reads them through the\n"
      . "# authenticated api/upload.php?action=blob proxy instead.\n"
      . "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n"
      . "<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n"
      . "php_flag engine off\n");

    // Execution ban for the PUBLISHED tree. DATA_WEB is web-served by construction,
    // so it is the one directory that is both operator-writable and reachable. The
    // import allowlist already refuses anything the pipeline does not emit, but a
    // dataset can also arrive by SFTP or rsync, which bypasses it entirely.
    admin_make_dir(data_web());
    lumen_up_write_guard(data_web() . '/.htaccess',
        "# Lumen3D — published dataset tree. Generated: keep in sync with the copy in\n"
      . "# the repository root (DATA_WEB/.htaccess).\n"
      . "<IfModule mod_php.c>\n    php_flag engine off\n</IfModule>\n"
      . "<IfModule mod_php7.c>\n    php_flag engine off\n</IfModule>\n"
      . "<IfModule mod_php5.c>\n    php_flag engine off\n</IfModule>\n"
      . "<FilesMatch \"\\.(php|php[0-9]|phtml|phps|phar|cgi|pl|py|sh|htaccess)\$\">\n"
      . "    <IfModule mod_authz_core.c>\n        Require all denied\n    </IfModule>\n"
      . "    <IfModule !mod_authz_core.c>\n        Order allow,deny\n        Deny from all\n    </IfModule>\n"
      . "</FilesMatch>\n"
      . "<IfModule mod_mime.c>\n    RemoveHandler .php .phtml .phar .cgi .pl .py .sh\n"
      . "    RemoveType .php .phtml .phar\n</IfModule>\n"
      . "Options -Indexes -ExecCGI -Includes\n"
      . "<IfModule mod_headers.c>\n    Header set X-Content-Type-Options \"nosniff\"\n</IfModule>\n");
}

// ── Journal ──────────────────────────────────────────────────────────────────

function lumen_up_now(): string { return gmdate('Y-m-d\TH:i:s+00:00'); }

function lumen_up_new_journal(string $type, string $folder): array {
    return ['version' => 1, 'type' => $type, 'folder' => $folder,
            'createdAt' => lumen_up_now(), 'updatedAt' => lumen_up_now(),
            'files' => [], 'rejected' => [], 'metaLocked' => false, 'publishedAt' => null];
}

function lumen_up_load_journal($type, $folder): ?array {
    $p = lumen_up_journal_path($type, $folder);
    if ($p === null || !is_file($p)) return null;
    $raw = @file_get_contents($p);
    if ($raw === false) return null;
    $d = json_decode($raw, true);
    return is_array($d) ? $d : null;
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
    admin_make_dir(dirname($jp));
    $tmp = $jp . '.tmp' . getmypid();
    if (@file_put_contents($tmp, json_encode($journal, JSON_UNESCAPED_UNICODE)) === false) return false;
    if (!@rename($tmp, $jp)) { @unlink($tmp); return false; }
    admin_fix_file_mode($jp);
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

function lumen_up_plan($datasets, $chunkSize): array {
    if (!is_array($datasets)) return ['ok' => false, 'error' => 'bad_request'];
    $chunkSize = lumen_up_clamp_chunk($chunkSize);
    $out = [];
    foreach (array_slice($datasets, 0, LUMEN_UP_MAX_DATASETS) as $raw) {
        if (!is_array($raw)) continue;
        $safe = lumen_up_safe_dataset($raw['type'] ?? null, $raw['folder'] ?? null);
        if ($safe === null) {
            $out[] = ['key' => null, 'type' => $raw['type'] ?? null, 'folder' => $raw['folder'] ?? null,
                      'error' => 'invalid_dataset', 'files' => [], 'rejected' => []];
            continue;
        }
        $out[] = lumen_up_plan_one($safe[0], $safe[1], $raw['files'] ?? [], $chunkSize);
    }
    return ['ok' => true, 'chunkSize' => $chunkSize, 'datasets' => $out];
}

function lumen_up_plan_one(string $type, string $folder, $files, int $chunkSize): array {
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
        $accepted[] = ['path' => $rel, 'size' => $size, 'tier' => $verdict[0], 'kind' => $verdict[1]];
    }
    lumen_up_assign_tiers($accepted);

    $result = lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, &$accepted, $rejected, $chunkSize) {
        if ($journal === null) $journal = lumen_up_new_journal($type, $folder);
        if (!isset($journal['files']) || !is_array($journal['files'])) $journal['files'] = [];

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
                continue;
            }
            $nbits = lumen_up_bits_len($item['size'], $chunkSize);
            $journal['files'][$rel] = [
                'size' => $item['size'], 'chunkSize' => $chunkSize, 'kind' => $item['kind'],
                'tier' => $item['tier'], 'bits' => lumen_up_bitmap_encode(str_repeat("\0", intdiv($nbits + 7, 8))),
                'done' => $item['size'] === 0, 'sha' => null,
            ];
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
        return $journal;
    });
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
function lumen_up_write_chunk($type, $folder, $rel, $index, string $data, ?string $sha): array {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return [400, ['error' => 'invalid_dataset']];
    [$type, $folder] = $safe;

    $dest = lumen_up_file_path($type, $folder, $rel);
    if ($dest === null) return [400, ['error' => 'path_not_allowed']];
    $rel = lumen_up_safe_rel($rel);

    if (!is_int($index) || $index < 0) return [400, ['error' => 'bad_index']];
    if (strlen($data) > LUMEN_UP_MAX_CHUNK) return [413, ['error' => 'chunk_too_large']];
    if ($sha) {
        $actual = hash('sha256', $data);
        if (!hash_equals(strtolower($sha), $actual)) {
            return [422, ['error' => 'checksum_mismatch', 'expected' => $sha, 'actual' => $actual]];
        }
    }

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

        admin_make_dir(dirname($dest));
        $fh = @fopen($dest, 'c+b');           // create, never truncate
        if ($fh === false) return [500, ['error' => 'write_failed']];
        $ok = @fseek($fh, $offset) === 0 && @fwrite($fh, $data) === strlen($data);
        @fclose($fh);
        if (!$ok) return [500, ['error' => 'write_failed']];
        admin_fix_file_mode($dest);

        $bits = lumen_up_bitmap_decode($entry['bits'] ?? '', $nbits);
        $bits = lumen_up_bit_set($bits, $index);
        $entry['bits'] = lumen_up_bitmap_encode($bits);
        $have = lumen_up_bit_count($bits, $nbits);
        $entry['done'] = $have === $nbits;
        $journal['files'][$rel] = $entry;
        $journal['lastChunkAt'] = lumen_up_now();
        lumen_up_save_journal($journal);
        return [200, ['ok' => true, 'index' => $index, 'chunks' => $nbits, 'have' => $have,
                      'done' => (bool)$entry['done'], 'received' => lumen_up_received($entry)]];
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
            $journal['files'][$rel] = $entry;
            lumen_up_save_journal($journal);
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
    if ($kind === 'thumbnail') {
        $head = lumen_up_head($path, 16);
        if (strncmp($head, 'RIFF', 4) !== 0 && strncmp($head, "\x89PNG\r\n\x1a\n", 8) !== 0) return [false, 'thumbnail_not_image'];
        return [true, null];
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
function lumen_up_validate_manifest(array $man): array {
    $levels = $man['levels'] ?? null;
    if (!is_array($levels) || !$levels) return [false, 'manifest_no_levels'];
    foreach ($levels as $i => $level) {
        if (!is_array($level)) return [false, "manifest_level_{$i}_not_object"];
        $lvl = $level['level'] ?? null;
        if (!is_int($lvl) || $lvl < 0) return [false, "manifest_level_{$i}_bad_index"];
        $dims = $level['dimensions'] ?? null;
        if (!is_array($dims)) return [false, "manifest_level_{$i}_no_dimensions"];
        foreach (['x', 'y', 'z'] as $axis) {
            $v = $dims[$axis] ?? null;
            if ((!is_int($v) && !is_float($v)) || $v <= 0) return [false, "manifest_level_{$i}_bad_{$axis}"];
        }
    }
    $packing = $man['brickPacking'] ?? null;
    if (is_array($packing) && isset($packing['mode'])
        && !in_array($packing['mode'], ['grid', 'vertical'], true)) {
        return [false, 'manifest_bad_packing_mode'];
    }
    return [true, null];
}

function lumen_up_validate_metadata(array $meta, string $type): array {
    if (!isset($meta['type']) || !in_array($meta['type'], ['fixed', 'live', 'tracking'], true)) return [false, 'metadata_bad_type'];
    if ($meta['type'] !== $type) return [false, 'metadata_type_mismatch'];
    if (!isset($meta['dimensions']) || !is_array($meta['dimensions'])) return [false, 'metadata_no_dimensions'];
    foreach (['x', 'y', 'z', 'c'] as $axis) {
        $v = $meta['dimensions'][$axis] ?? null;
        if (!is_int($v) && !is_float($v)) return [false, 'metadata_bad_dimensions'];
        if ($v <= 0) return [false, 'metadata_bad_dimensions'];
    }
    if (!isset($meta['channels']) || !is_array($meta['channels']) || !$meta['channels']) return [false, 'metadata_no_channels'];
    return [true, null];
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
    if (!is_file("$dir/bricks/manifest.json")) {
        $errors[] = 'missing_manifest';
    } else {
        $man = lumen_up_read_json("$dir/bricks/manifest.json");
        if ($man === null) {
            $errors[] = 'manifest_not_json';
        } else {
            [$mok, $mreason] = lumen_up_validate_manifest($man);
            if (!$mok) $errors[] = $mreason ?: 'manifest_invalid';
            $errors = array_merge($errors, lumen_up_cross_check_packs($dir, $man));
        }
    }

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
 *  with that frame's `path`; checking the root index bare would hunt for a fixed
 *  dataset's layout inside a timelapse and report every pack missing. The root
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
    $files = $journal['files'] ?? [];
    if (!$files) return LUMEN_UP_STATE_UPLOADING;

    $pending = false;
    foreach ($files as $e) if (empty($e['done'])) { $pending = true; break; }
    if (!$pending) return LUMEN_UP_STATE_STAGED;

    $coreOk = true; $hasManifest = false;
    foreach ($files as $e) {
        if ((int)($e['tier'] ?? 9) <= LUMEN_UP_TIER_PREVIEW && empty($e['done'])) $coreOk = false;
        if (($e['kind'] ?? '') === 'manifest' && !empty($e['done'])) $hasManifest = true;
    }
    $hasMeta = !empty($files['metadata.json']['done']);
    $state = ($coreOk && $hasMeta && $hasManifest) ? LUMEN_UP_STATE_EDITABLE : LUMEN_UP_STATE_UPLOADING;

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
    $files = $journal['files'] ?? [];
    $total = 0; $got = 0; $done = 0;
    foreach ($files as $e) {
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
        // Only an INCOMPLETE import is on the clock (see lumen_up_gc) — showing a
        // countdown on a finished one would promise a deletion that never comes.
        'expiresInS' => ($last && $state !== LUMEN_UP_STATE_STAGED)
            ? max(0, (int)(LUMEN_UP_STALE_AFTER - lumen_up_age($last))) : null,
        'hasThumbnail' => $dir ? is_file("$dir/thumbnail.webp") : false,
    ];
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
        $info = lumen_up_describe(substr($stem, 0, $sep), substr($stem, $sep + 2));
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

    $existing = lumen_up_read_json("$dir/metadata.json") ?: [];
    $merged = array_merge($existing, array_diff_key($meta, array_flip(LUMEN_UP_COMPUTED)));
    $merged['type'] = $type;
    $merged['folderName'] = $folder;
    $merged['id'] = $folder;
    $merged['configured'] = true;
    $merged['lastModified'] = date('c');
    [$ok, $reason] = lumen_up_validate_metadata($merged, $type);
    if (!$ok) return [400, ['error' => $reason]];

    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, $dir, $merged) {
        if ($journal === null) return [409, ['error' => 'not_staged']];
        admin_make_dir($dir);
        $tmp = "$dir/metadata.json.tmp" . getmypid();
        if (@file_put_contents($tmp, json_encode($merged, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)) === false) return [500, ['error' => 'write_failed']];
        @rename($tmp, "$dir/metadata.json");
        admin_fix_file_mode("$dir/metadata.json");
        $journal['metaLocked'] = true;
        $entry = $journal['files']['metadata.json'] ?? ['chunkSize' => LUMEN_UP_DEFAULT_CHUNK, 'kind' => 'metadata', 'tier' => LUMEN_UP_TIER_CORE];
        clearstatcache(true, "$dir/metadata.json");
        $entry['size'] = (int)@filesize("$dir/metadata.json");
        $entry['done'] = true;
        $entry['bits'] = lumen_up_bitmap_encode("\1");
        $journal['files']['metadata.json'] = $entry;
        lumen_up_save_journal($journal);
        return [200, ['ok' => true]];
    });
}

function lumen_up_write_thumbnail($type, $folder, string $bytes): array {
    $dir = lumen_up_dataset_dir($type, $folder);
    if ($dir === null) return [400, ['error' => 'invalid_dataset']];
    if (strncmp($bytes, 'RIFF', 4) !== 0 && strncmp($bytes, "\x89PNG\r\n\x1a\n", 8) !== 0) return [400, ['error' => 'not_an_image']];
    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $dir, $bytes) {
        if ($journal === null) return [409, ['error' => 'not_staged']];
        admin_make_dir($dir);
        if (@file_put_contents("$dir/thumbnail.webp", $bytes) === false) return [500, ['error' => 'write_failed']];
        admin_fix_file_mode("$dir/thumbnail.webp");
        $entry = $journal['files']['thumbnail.webp'] ?? ['chunkSize' => LUMEN_UP_DEFAULT_CHUNK, 'kind' => 'thumbnail', 'tier' => LUMEN_UP_TIER_CORE];
        $entry['size'] = strlen($bytes);
        $entry['done'] = true;
        $entry['bits'] = lumen_up_bitmap_encode("\1");
        $journal['files']['thumbnail.webp'] = $entry;
        lumen_up_save_journal($journal);
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

    $verdict = lumen_up_validate_dataset($type, $folder);
    if (empty($verdict['ok'])) return [409, array_merge(['error' => 'validation_failed'], $verdict)];

    $destBase = data_web() . "/$type";
    $dest = "$destBase/$folder";
    if (is_dir($dest) && !$overwrite) return [409, ['error' => 'already_exists']];

    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, $src, $dest, $destBase, $hidden) {
        if ($hidden) {
            $meta = lumen_up_read_json("$src/metadata.json") ?: [];
            $meta['hidden'] = true;
            @file_put_contents("$src/metadata.json", json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
        }
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
                return [500, ['error' => 'publish_failed']];
            }
            if (!@rename($tmp, $dest)) {
                lumen_up_rrmdir($tmp);
                if ($replaced !== null) @rename($replaced, $dest);
                return [500, ['error' => 'publish_failed']];
            }
            lumen_up_rrmdir($src);
        }
        if ($replaced !== null) lumen_up_rrmdir($replaced);
        $jp = lumen_up_journal_path($type, $folder);
        if ($jp && is_file($jp)) @unlink($jp);
        // The flock sidecar too, or uploads/state/ slowly fills with dead
        // .lock files for datasets that no longer exist.
        if ($jp && is_file($jp . '.lock')) @unlink($jp . '.lock');
        @rmdir(lumen_up_staging() . "/$type");
        return [200, ['ok' => true, 'id' => "$type/$folder", 'hidden' => $hidden]];
    });
}

function lumen_up_discard($type, $folder): array {
    $safe = lumen_up_safe_dataset($type, $folder);
    if ($safe === null) return [400, ['error' => 'invalid_dataset']];
    [$type, $folder] = $safe;
    $dir = lumen_up_dataset_dir($type, $folder);
    return lumen_up_journal_locked($type, $folder, function ($journal) use ($type, $folder, $dir) {
        if ($dir !== null) lumen_up_rrmdir($dir);
        $jp = lumen_up_journal_path($type, $folder);
        if ($jp && is_file($jp)) @unlink($jp);
        // The flock sidecar too, or uploads/state/ slowly fills with dead
        // .lock files for datasets that no longer exist.
        if ($jp && is_file($jp . '.lock')) @unlink($jp . '.lock');
        @rmdir(lumen_up_staging() . "/$type");
        return [200, ['ok' => true]];
    });
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
    $removed = []; $kept = 0;
    foreach (lumen_up_list() as $info) {
        $expired = !empty($info['updatedAt']) && lumen_up_age($info['updatedAt']) > $maxAge;
        if ($expired && ($info['state'] ?? '') !== LUMEN_UP_STATE_STAGED) {
            lumen_up_discard($info['type'], $info['folder']);
            $removed[] = $info['key'];
        } else {
            $kept++;
        }
    }
    return ['removed' => $removed, 'kept' => $kept];
}
