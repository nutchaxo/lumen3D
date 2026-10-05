<?php
/**
 * IRIBHM Microscopy Platform — Dataset CRUD API
 * ===============================================
 * Read and write dataset metadata.json files.
 * Also handles catalog.json regeneration.
 *
 * Endpoints:
 *   GET  ?action=list              → [{id, name, type, stage, thumbnail, configured}, ...]
 *   GET  ?action=get&id=<id>       → full metadata.json object
 *   POST ?action=save&id=<id>      → writes metadata.json, returns {ok}
 *   POST ?action=rebuild_catalog   → regenerates DATA_WEB/catalog.json
 *
 * Every metadata.json write is a read-modify-write under a per-file lock, written
 * through a temp sibling + rename: a reader (the catalog, a viewer) never sees a
 * truncated document, and two concurrent saves can no longer lose one another.
 */

declare(strict_types=1);

// catalog.php includes this file purely for rebuild_catalog(); in that mode it must
// not emit JSON headers, must not start an admin session, and must not run the
// router at the bottom. Everything outside these guards is pure library code.
define('LUMEN_DATASETS_AS_LIB', defined('LUMEN_DATASETS_LIB'));

if (!LUMEN_DATASETS_AS_LIB) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
}

require_once __DIR__ . '/_admin_lib.php';   // admin_check_csrf, admin_record_event, etc.
// Datasets still being imported are listed and edited through this same API, so
// the staging library must be loaded for EVERY action — `list` needs
// lumen_staged_rows() just as much as the staging-id branch below needs the
// LUMEN_STAGING_PREFIX constant. Requiring it only inside that branch made a
// plain ?action=list fatal on PHP hosts.
require_once __DIR__ . '/_upload_lib.php';

// ── Session / Auth ───────────────────────────────────────────────────────────
if (!LUMEN_DATASETS_AS_LIB) {
    // admin_session_start() (not a bare session_start) so the hardened cookie
    // params — HttpOnly, SameSite=Lax, Secure under HTTPS — apply here too.
    admin_session_start();
    admin_update_finish_pending();   // no-op unless a prior update parked busy files
    // A host installed before the type vocabulary was unified still has its bytes
    // under DATA_WEB/fixed and DATA_WEB/wholemount, and nothing reads those words any
    // more. The rename happens once, here, before the first scandir — silent and
    // immediate when there is nothing to migrate. Deliberately NOT at include time:
    // library mode is the shape catalog.php and admin.php pull this file in, and a
    // library include must not move directories as a side effect. Every entry point
    // that needs the conversion states it itself.
    lumen_migrate_dataset_types();
    // Auth and CSRF are read from $_SESSION below, never written: the session lock is
    // released now, so this request neither waits behind a slow one of admin.php nor
    // holds a save's disk work over every other admin call (see api/admin.php).
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
}

function require_auth(): void {
    if (empty($_SESSION['admin_authenticated'])) {
        json_out(['error' => 'Unauthorized'], 401);
    }
}

// No `: never` return type — 8.1+ syntax that would parse-error (500) on the
// advertised PHP >= 7.4 floor. It exits anyway.
function json_out(array $data, int $code = 200) {
    http_response_code($code);
    [$status, $json] = admin_json_body($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($status) http_response_code($status);
    echo $json;
    exit;
}

// ── Paths ────────────────────────────────────────────────────────────────────
$ROOT      = dirname(__DIR__);                  // WebPlatform root
$DATA_WEB  = data_web();
$TYPES     = LUMEN_DATASET_TYPES;   // one shared vocabulary — see api/_admin_lib.php

// ── Helpers ──────────────────────────────────────────────────────────────────

function read_json(string $path): ?array {
    if (!file_exists($path)) return null;
    $raw = @file_get_contents($path);
    return $raw !== false ? (json_decode($raw, true) ?: null) : null;
}

/** A document about to be written back: `{}` maps survive the round trip. */
function read_json_doc(string $path): ?array {
    return lumen_read_json_doc($path) ?: null;
}

/** Atomic write (temp sibling + rename). json_encode returns false on malformed
 *  UTF-8; writing that would blank the file — refused instead (Rule 1.1). */
function write_json(string $path, array $data): bool {
    $ok = lumen_write_json_doc($path, $data);
    if ($ok) lumen_catalog_invalidate();
    return $ok;
}

// ── Dataset gallery (operator-attached images) ───────────────────────────────
// Twin of dev_server.py _gallery_* : same folder (DATA_WEB/<type>/<folder>/gallery/),
// same metadata.json shape, same reconciliation rules — an operator can move a host
// between the two backends without the galleries changing meaning.
const GALLERY_DIRNAME    = 'gallery';
const MAX_GALLERY_BYTES  = 8388608;
const MAX_GALLERY_ITEMS  = 40;
const GALLERY_CAPTION_MAX = 400;

/** Extension from the MAGIC BYTES, never from the client-supplied filename. */
function gallery_ext(string $raw): ?string {
    if (substr($raw, 0, 4) === 'RIFF' && substr($raw, 8, 4) === 'WEBP') return 'webp';
    if (substr($raw, 0, 8) === "\x89PNG\r\n\x1a\n")                     return 'png';
    if (substr($raw, 0, 3) === "\xff\xd8\xff")                          return 'jpg';
    if (substr($raw, 0, 6) === 'GIF87a' || substr($raw, 0, 6) === 'GIF89a') return 'gif';
    return null;
}

function gallery_stem(string $name): string {
    $name = str_replace('\\', '/', $name);
    $parts = explode('/', $name);
    $name = (string)end($parts);
    $dot = strrpos($name, '.');
    if ($dot !== false) $name = substr($name, 0, $dot);
    $stem = strtolower((string)preg_replace('/[^A-Za-z0-9_-]+/', '-', $name));
    $stem = trim($stem, '-');
    return $stem === '' ? 'image' : substr($stem, 0, 60);
}

/** Validate an entry's `file`: a bare name in gallery/, never a path (it becomes a URL). */
function gallery_rel($file): ?string {
    if (!is_string($file)) return null;
    $name = trim(str_replace('\\', '/', $file), '/');
    if (strncmp($name, GALLERY_DIRNAME . '/', strlen(GALLERY_DIRNAME) + 1) === 0) {
        $name = substr($name, strlen(GALLERY_DIRNAME) + 1);
    }
    if (strpos($name, '/') !== false) return null;
    return preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(webp|png|jpg|jpeg|gif)$/D', $name) ? $name : null;
}

/**
 * Clamp to $limit CHARACTERS, never bytes. A byte-wise cut of an accented caption
 * would leave a half-written UTF-8 sequence, json_encode would then return false and
 * write_json would blank metadata.json — the dataset's only source of truth. mbstring
 * is not guaranteed on a shared host, hence the codepoint-wise fallback.
 */
function gallery_clean_text($value, int $limit = GALLERY_CAPTION_MAX): string {
    if (!is_string($value)) return '';
    $v = trim(str_replace(["\r", "\n"], ' ', $value));
    if (function_exists('mb_substr')) return mb_substr($v, 0, $limit, 'UTF-8');
    $chars = preg_split('//u', $v, -1, PREG_SPLIT_NO_EMPTY);
    if (is_array($chars)) return implode('', array_slice($chars, 0, $limit));
    // Input was not valid UTF-8: cut on bytes, then drop any dangling partial sequence.
    return (string)preg_replace('/[\x80-\xFF]*$/', '', substr($v, 0, $limit));
}

// Grid-sized copies (twin of dev_server.py GALLERY_THUMB_*): gallery/thumbs/<file>.webp,
// or .jpg where GD cannot encode WebP, at most GALLERY_THUMB_PX on the long side.
// A plain sub-folder: dot-segments are never served, and gallery_reconcile lists files only.
const GALLERY_THUMB_DIRNAME = 'thumbs';
const GALLERY_THUMB_PX = 320;
const GALLERY_THUMB_MAX_SOURCE_PIXELS = 50000000;

/** Relative path (from gallery/) of the current thumbnail of $name, or null. A
 *  thumbnail older than its source is stale and does not count. */
function gallery_thumb_existing(string $gdir, string $name): ?string {
    clearstatcache();
    $src = @filemtime($gdir . '/' . $name);
    if ($src === false) return null;
    foreach (['webp', 'jpg'] as $ext) {
        $rel = GALLERY_THUMB_DIRNAME . "/$name.$ext";
        $t = @filemtime($gdir . '/' . $rel);
        if ($t !== false && $t >= $src) return $rel;
    }
    return null;
}

function gallery_thumb_webp_ok(): bool {
    if (!function_exists('imagewebp') || !function_exists('gd_info')) return false;
    return !empty(gd_info()['WebP Support']);
}

/** Write the thumbnail of gallery/$name with GD. Its relative path, or null when GD
 *  is missing or the image cannot (or should not) be decoded. */
function gallery_make_thumb(string $gdir, string $name): ?string {
    if (!function_exists('imagecreatefromstring') || !function_exists('imagecopyresampled')) return null;
    $path = $gdir . '/' . $name;
    $info = @getimagesize($path);
    if (!is_array($info) || $info[0] <= 0 || $info[1] <= 0) return null;
    if ($info[0] * $info[1] > GALLERY_THUMB_MAX_SOURCE_PIXELS) return null;
    // GD holds a decoded image as 4 bytes per pixel (+ the file and a resized copy):
    // under a 128 MiB memory_limit a 50 MP canvas would be a fatal error, and every later
    // save of the dataset (which re-syncs the thumbnails) would die on it too.
    $limit = lumen_up_ini_bytes((string)ini_get('memory_limit'));
    if ($limit > 0) {
        $room = $limit - memory_get_usage(true) - (int)@filesize($path) - 16777216;
        if ($info[0] * $info[1] * 5 > $room) return null;
    }
    $raw = @file_get_contents($path);
    $src = $raw === false ? false : @imagecreatefromstring($raw);
    if ($src === false) return null;
    // EXIF orientation of a camera JPEG (Pillow's exif_transpose on the Python side).
    if (($info[2] ?? 0) === IMAGETYPE_JPEG && function_exists('exif_read_data')) {
        $o = (int)((@exif_read_data($path)['Orientation'] ?? 1));
        if (in_array($o, [2, 4, 5, 7], true) && function_exists('imageflip')) imageflip($src, IMG_FLIP_HORIZONTAL);
        $turn = [3 => 180, 4 => 180, 5 => 270, 6 => 270, 7 => 90, 8 => 90][$o] ?? 0;
        if ($turn) { $r = imagerotate($src, $turn, 0); if ($r !== false) { imagedestroy($src); $src = $r; } }
    }
    $w = imagesx($src); $h = imagesy($src);
    $scale = min(1.0, GALLERY_THUMB_PX / max($w, $h));
    $tw = max(1, (int)round($w * $scale)); $th = max(1, (int)round($h * $scale));
    $dst = imagecreatetruecolor($tw, $th);
    $webp = gallery_thumb_webp_ok();
    if ($webp) {
        imagealphablending($dst, false);
        imagesavealpha($dst, true);
        imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
    } else {
        imagefill($dst, 0, 0, imagecolorallocate($dst, 255, 255, 255));
        imagealphablending($dst, true);
    }
    imagecopyresampled($dst, $src, 0, 0, 0, 0, $tw, $th, $w, $h);
    imagedestroy($src);
    ob_start();
    $ok = $webp ? imagewebp($dst, null, 80) : imagejpeg($dst, null, 85);
    $bytes = (string)ob_get_clean();
    imagedestroy($dst);
    if (!$ok || $bytes === '') return null;
    $tdir = $gdir . '/' . GALLERY_THUMB_DIRNAME;
    if (!is_dir($tdir) && !admin_make_dir($tdir)) return null;
    $rel = GALLERY_THUMB_DIRNAME . "/$name." . ($webp ? 'webp' : 'jpg');
    if (!lumen_write_file_atomic($gdir . '/' . $rel, $bytes)) return null;
    $stale = $tdir . "/$name." . ($webp ? 'jpg' : 'webp');
    if (is_file($stale)) @unlink($stale);
    return $rel;
}

/** Every gallery image gets a current thumbnail; a thumbnail whose image is gone is
 *  removed. Run on add, delete, save and the lazy `gallery_thumbs` action. */
function gallery_sync_thumbs(string $ds_dir): void {
    $gdir = $ds_dir . '/' . GALLERY_DIRNAME;
    if (!is_dir($gdir)) return;
    $names = [];
    foreach (scandir($gdir) ?: [] as $f) {
        if (is_file("$gdir/$f") && gallery_rel($f) === $f) $names[$f] = true;
    }
    foreach (array_keys($names) as $n) {
        if (gallery_thumb_existing($gdir, (string)$n) === null) gallery_make_thumb($gdir, (string)$n);
    }
    $tdir = $gdir . '/' . GALLERY_THUMB_DIRNAME;
    if (!is_dir($tdir)) return;
    foreach (scandir($tdir) ?: [] as $t) {
        if ($t === '.' || $t === '..' || !is_file("$tdir/$t")) continue;
        $dot = strrpos($t, '.');
        $base = $dot === false ? '' : substr($t, 0, $dot);
        $ext = $dot === false ? '' : substr($t, $dot + 1);
        if (!in_array($ext, ['webp', 'jpg'], true) || !isset($names[$base])) @unlink("$tdir/$t");
    }
}

function gallery_entry(string $name, array $src, ?string $gdir = null): array {
    $item = ['file' => $name];
    // Derived from the disk, never from the posted entry.
    $thumb = $gdir !== null ? gallery_thumb_existing($gdir, $name) : null;
    if ($thumb !== null) $item['thumb'] = $thumb;
    $title   = gallery_clean_text($src['title'] ?? '', 120);
    $caption = gallery_clean_text($src['caption'] ?? '');
    if ($title !== '')   $item['title'] = $title;
    if ($caption !== '') $item['caption'] = $caption;
    if (isset($src['added']) && is_string($src['added'])) $item['added'] = substr($src['added'], 0, 40);
    return $item;
}

/**
 * Make metadata.json's `gallery` agree with what is on disk: drop entries whose file is
 * missing or malformed, append files the incoming list does not know about (so a Save
 * carrying an older draft cannot erase a concurrent upload). $fallback is the gallery as
 * it stood before the edit — a re-appended file recovers its caption from it.
 */
function gallery_reconcile(array $meta, string $ds_dir, $fallback = null): array {
    $gdir = $ds_dir . DIRECTORY_SEPARATOR . GALLERY_DIRNAME;
    $rows = [];
    if (is_dir($gdir)) {
        foreach (scandir($gdir) ?: [] as $f) {
            $p = $gdir . DIRECTORY_SEPARATOR . $f;
            if (!is_file($p) || gallery_rel($f) === null) continue;
            $rows[] = [$f, (int)@filemtime($p)];
        }
        usort($rows, fn($a, $b) => $a[1] === $b[1] ? strcmp($a[0], $b[0]) : $a[1] <=> $b[1]);
    }
    $on_disk = array_map(fn($r) => $r[0], $rows);
    $disk_set = array_flip($on_disk);

    $prior = [];
    foreach ((is_array($fallback) ? $fallback : []) as $entry) {
        if (!is_array($entry)) continue;
        $key = gallery_rel($entry['file'] ?? null);
        if ($key !== null) $prior[$key] = $entry;
    }

    $out = [];
    $seen = [];
    $incoming = isset($meta['gallery']) && is_array($meta['gallery']) ? $meta['gallery'] : [];
    foreach ($incoming as $entry) {
        if (!is_array($entry)) continue;
        $name = gallery_rel($entry['file'] ?? null);
        if ($name === null || isset($seen[$name]) || !isset($disk_set[$name])) continue;
        $seen[$name] = true;
        $out[] = gallery_entry($name, $entry, $gdir);
    }
    foreach ($on_disk as $name) {
        if (isset($seen[$name])) continue;
        $out[] = gallery_entry($name, $prior[$name] ?? [], $gdir);
    }
    return array_slice($out, 0, MAX_GALLERY_ITEMS);
}

/** The largest gallery image this host accepts as a raw request body: the platform's
 *  ceiling, lowered to post_max_size when PHP is configured tighter (a body over it
 *  arrives empty). The admin reads it from the `list` answer. */
function gallery_max_bytes(): int {
    $post = lumen_up_ini_bytes((string)(ini_get('post_max_size') ?: '8M'));
    return $post > 0 ? min(MAX_GALLERY_BYTES, $post) : MAX_GALLERY_BYTES;
}

/** @return array{0:int,1:array} (http status, payload) */
function gallery_add(string $id, string $ds_dir, array $body): array {
    if (!is_dir($ds_dir)) return [404, ['error' => 'Dataset not found']];
    $raw = isset($body['raw']) && is_string($body['raw']) ? $body['raw'] : null;
    if ($raw === null) {
        // Legacy JSON form: a data: URL. The magic-byte check below applies to both.
        $image = lumen_str($body['image'] ?? null) ?? '';
        if (strncmp($image, 'data:image/', 11) !== 0) return [400, ['error' => 'Invalid image format']];
        $comma = strpos($image, ',');
        $raw = $comma === false ? false : base64_decode(substr($image, $comma + 1), false);
    }
    if ($raw === false || $raw === '') return [400, ['error' => 'Invalid image data']];
    if (strlen($raw) > MAX_GALLERY_BYTES) return [400, ['error' => 'Image too large']];
    $ext = gallery_ext($raw);
    if ($ext === null) return [400, ['error' => 'Not a valid image (expected WebP/PNG/JPEG/GIF)']];

    $meta_path = $ds_dir . DIRECTORY_SEPARATOR . 'metadata.json';
    return lumen_with_lock($meta_path, function () use ($id, $ds_dir, $meta_path, $raw, $ext, $body) {
        $meta = read_json_doc($meta_path) ?: [];
        $current = gallery_reconcile($meta, $ds_dir);
        if (count($current) >= MAX_GALLERY_ITEMS) {
            return [409, ['error' => 'Gallery full (max ' . MAX_GALLERY_ITEMS . ' images)']];
        }

        $gdir = $ds_dir . DIRECTORY_SEPARATOR . GALLERY_DIRNAME;
        if (!is_dir($gdir) && !admin_make_dir($gdir)) return [500, ['error' => 'Write failed']];
        $stem = gallery_stem(lumen_str($body['filename'] ?? null) ?? lumen_str($body['name'] ?? null) ?? '');
        $name = "$stem.$ext";
        $i = 1;
        while (is_file($gdir . DIRECTORY_SEPARATOR . $name)) { $name = "$stem-$i.$ext"; $i++; }
        if (@file_put_contents($gdir . DIRECTORY_SEPARATOR . $name, $raw) === false) {
            return [500, ['error' => 'Write failed']];
        }
        admin_fix_file_mode($gdir . DIRECTORY_SEPARATOR . $name);
        gallery_make_thumb($gdir, $name);

        $entry = gallery_entry($name, [
            'title'   => $body['title'] ?? '',
            'caption' => $body['caption'] ?? '',
            'added'   => date('c'),
        ], $gdir);
        $current[] = $entry;
        $meta['gallery'] = $current;
        $meta['lastModified'] = date('c');
        if (!write_json($meta_path, $meta)) return [500, ['error' => 'Write failed']];
        return [200, [
            'ok' => true, 'item' => $entry, 'gallery' => $current,
            'url' => 'DATA_WEB/' . $id . '/' . GALLERY_DIRNAME . '/' . $name,
        ]];
    });
}

/** @return array{0:int,1:array} */
function gallery_delete(string $ds_dir, $file): array {
    $name = gallery_rel($file);
    if ($name === null) return [400, ['error' => 'Invalid file']];
    $target = $ds_dir . DIRECTORY_SEPARATOR . GALLERY_DIRNAME . DIRECTORY_SEPARATOR . $name;
    if (is_file($target) && !@unlink($target)) return [500, ['error' => 'Delete failed']];
    foreach (['webp', 'jpg'] as $ext) {
        $t = $ds_dir . '/' . GALLERY_DIRNAME . '/' . GALLERY_THUMB_DIRNAME . "/$name.$ext";
        if (is_file($t)) @unlink($t);
    }

    $meta_path = $ds_dir . DIRECTORY_SEPARATOR . 'metadata.json';
    return lumen_with_lock($meta_path, function () use ($meta_path, $ds_dir) {
        $meta = read_json_doc($meta_path) ?: [];
        $meta['gallery'] = gallery_reconcile($meta, $ds_dir);
        $meta['lastModified'] = date('c');
        if (!write_json($meta_path, $meta)) return [500, ['error' => 'Write failed']];
        return [200, ['ok' => true, 'gallery' => $meta['gallery']]];
    });
}

/** Lazy thumbnails for a gallery that predates them (twin of dev_server.py
 *  _gallery_thumbs). @return array{0:int,1:array} */
function gallery_thumbs(string $ds_dir): array {
    $meta_path = $ds_dir . DIRECTORY_SEPARATOR . 'metadata.json';
    if (!is_file($meta_path)) return [404, ['error' => 'Dataset not found']];
    return lumen_with_lock($meta_path, function () use ($meta_path, $ds_dir) {
        $meta = read_json_doc($meta_path);
        if (!is_array($meta)) return [500, ['error' => 'Unreadable metadata']];
        gallery_sync_thumbs($ds_dir);
        $gallery = gallery_reconcile($meta, $ds_dir);
        if ($gallery !== ($meta['gallery'] ?? [])) {
            if ($gallery) $meta['gallery'] = $gallery; else unset($meta['gallery']);
            if (!write_json($meta_path, $meta)) return [500, ['error' => 'Write failed']];
        }
        return [200, ['ok' => true, 'gallery' => $gallery]];
    });
}

/**
 * Disk directory of a dataset id ('<type>/<folder>').
 *
 * Resolved THROUGH the traversal gate, not by substituting separators: it is
 * admin_safe_dataset() that proves the type is one of the four and the folder is a
 * single safe component, and every write action on this endpoint ends up here. Any
 * id the gate refuses must never reach the filesystem — a `save` on an unresolvable
 * id would otherwise mint a parallel tree beside the real dataset instead of failing.
 */
/**
 * Bytes of a posted thumbnail `{image: "data:image/…;base64,…"}`, or exit 400.
 * Strict base64, a size cap and the MAGIC BYTES (WebP or PNG — what the editor
 * produces and what the staged twin accepts): the file is served as an image to
 * every visitor, so arbitrary bytes must not land under that name.
 */
const MAX_THUMBNAIL_BYTES = 5242880;
function thumbnail_bytes(array $body): string {
    $img = lumen_str($body['image'] ?? null) ?? '';
    if (strncmp($img, 'data:image/', 11) !== 0) json_out(['error' => 'Invalid image format'], 400);
    $comma = strpos($img, ',');
    $bytes = $comma === false ? false : base64_decode(substr($img, $comma + 1), true);
    if ($bytes === false || $bytes === '') json_out(['error' => 'Base64 decode failed'], 400);
    if (strlen($bytes) > MAX_THUMBNAIL_BYTES) json_out(['error' => 'Image too large'], 400);
    $ext = gallery_ext($bytes);
    if ($ext !== 'webp' && $ext !== 'png') json_out(['error' => 'not_an_image'], 400);
    return $bytes;
}

function dataset_dir(string $id): string {
    $safe = admin_safe_dataset($id);
    if ($safe === null) json_out(['error' => 'Invalid id'], 400);
    return $safe[2];
}

/**
 * metadata.json of a published dataset, its identity re-asserted from the directory
 * it was read from. Twin of dev_server.py _get_dataset(): the folder is the
 * authority for `id`, `type` and `folderName`, so a file that lost one of them
 * (an earlier save wrote the posted body verbatim, and the editor deliberately
 * leaves `type` out of what it posts) still mounts in the editor.
 */
function get_dataset_meta(string $id, string $ds_dir): ?array {
    $meta = read_json_doc($ds_dir . DIRECTORY_SEPARATOR . 'metadata.json');
    if (!$meta) return null;
    [$type, $folder] = explode('/', $id, 2);
    $meta['id']         = $id;
    $meta['type']       = $type;
    $meta['folderName'] = $folder;
    return $meta;
}

/**
 * Merge a posted metadata body into the stored file. Twin of dev_server.py
 * _save_dataset(): a stored key survives unless the body carries it (an explicit
 * null erases it), and the identity fields are re-asserted from the directory on
 * every write. Writing the body verbatim dropped `type` — the editor never posts
 * it — after which the admin refused to mount the dataset ("invalid type") while
 * the public pages, which derive the type from the directory, kept working.
 * @return array [status, payload]
 */
function save_dataset_meta(string $id, string $ds_dir, array $body): array {
    if (!is_dir($ds_dir) && !admin_make_dir($ds_dir)) return [500, ['error' => 'Write failed']];
    $path   = $ds_dir . DIRECTORY_SEPARATOR . 'metadata.json';
    return lumen_with_lock($path, function () use ($id, $ds_dir, $path, $body) {
        $stored = read_json_doc($path);
        $meta   = is_array($stored) ? $stored : [];
        gallery_sync_thumbs($ds_dir);
        foreach ($body as $k => $v) $meta[$k] = $v;
        [$type, $folder] = explode('/', $id, 2);
        $meta['id']           = $id;
        $meta['type']         = $type;
        $meta['folderName']   = $folder;
        $meta['configured']   = true;
        $meta['lastModified'] = date('c');
        // The posted `gallery` decides ORDER and CAPTIONS only; which files exist is
        // decided by the folder. Keeps a stale draft from resurrecting a deleted image
        // or dropping one uploaded while the form was open.
        $gallery = gallery_reconcile($meta, $ds_dir, is_array($stored) ? ($stored['gallery'] ?? null) : null);
        if ($gallery) $meta['gallery'] = $gallery; else unset($meta['gallery']);
        if (!write_json($path, $meta)) return [500, ['error' => 'Write failed']];
        return [200, ['ok' => true, 'path' => $path]];
    });
}

/** $ds_dir is passed in: the caller has already walked the directory, and a folder
 *  name the id gate would refuse must not abort the whole listing. */
function thumbnail_url(string $id, string $ds_dir): ?string {
    return file_exists($ds_dir . DIRECTORY_SEPARATOR . 'thumbnail.webp')
        ? 'DATA_WEB/' . $id . '/thumbnail.webp' : null;
}

function list_datasets(): array {
    global $DATA_WEB, $TYPES;
    $result = [];
    foreach ($TYPES as $type) {
        $type_dir = $DATA_WEB . DIRECTORY_SEPARATOR . $type;
        if (!is_dir($type_dir)) continue;
        foreach (scandir($type_dir) ?: [] as $name) {
            // Dot entries are never datasets: '.', '..', and the '.replaced-*' /
            // '.incoming-*' trees a publish parks for an instant (a crash in between
            // would otherwise list a ghost the id gate then refuses to open).
            if ($name === '' || $name[0] === '.') continue;
            $ds_dir = $type_dir . DIRECTORY_SEPARATOR . $name;
            if (!is_dir($ds_dir)) continue;
            $id   = $type . '/' . $name;
            $meta = read_json($ds_dir . DIRECTORY_SEPARATOR . 'metadata.json');
            $hasBricks = file_exists($ds_dir . DIRECTORY_SEPARATOR . 'bricks' . DIRECTORY_SEPARATOR . 'manifest.json');
            $result[] = [
                'id'          => $id,
                // Same string as the id on purpose: some callers address a dataset by
                // identity and some build DATA_WEB byte URLs out of it, and the staged
                // rows below already carry both keys. A published row without `path`
                // left the admin editor with nothing to build a byte URL from.
                'path'        => $id,
                'name'        => $meta['name'] ?? $name,
                'folderName'  => $name,
                'type'        => $type,
                'stage'       => $meta['stage'] ?? null,
                'stageNumeric'=> $meta['stageNumeric'] ?? 0,
                'embryo'      => $meta['embryo'] ?? null,
                'channels'    => $meta['channels'] ?? [],
                'dimensions'  => $meta['dimensions'] ?? [],
                'thumbnail'   => thumbnail_url($id, $ds_dir),
                'configured'  => !empty($meta['configured']) || !empty($meta['_adminConfigured']),
                'hidden'      => !empty($meta['hidden']),
                'hasBricks'   => $hasBricks,
            ];
        }
    }
    // Sort by stageNumeric then name
    usort($result, fn($a, $b) =>
        ((float)$a['stageNumeric'] <=> (float)$b['stageNumeric']) ?: strcmp((string)$a['name'], (string)$b['name'])
    );
    return $result;
}

/** The public catalog builder lives in _admin_lib.php (rebuild_catalog, lumen_catalog_json):
 *  catalog.php, admin.php and the upload publish path use it without this router. */

// ── Router ───────────────────────────────────────────────────────────────────
if (LUMEN_DATASETS_AS_LIB) {
    return;   // library mode: the caller only wants rebuild_catalog()
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = lumen_str($_GET['action'] ?? null) ?? '';
$id     = trim(lumen_str($_GET['id'] ?? null) ?? '', '/');

// Every action on this endpoint is admin-only — including the reads. `list`
// enumerates HIDDEN datasets (list_datasets() reports them with their folder
// names; only the public catalog filters them out) and `get` returns a raw
// metadata.json. Mirrors dev_server.py, which gates the whole handler.
require_auth();

// CSRF is bound to the ACTION, never to the HTTP method. Gating on
// `$method === 'POST'` meant a state-changing action reached as a top-level GET
// skipped the token entirely, so a logged-in admin following a link could be made
// to flip a dataset public (`?action=set_visibility&id=…` with an empty body).
// admin_require_write() enforces POST *and* the token together.
const DATASET_WRITE_ACTIONS = ['save', 'save_thumbnail', 'rebuild_catalog', 'set_visibility',
                               'gallery_add', 'gallery_delete', 'gallery_thumbs'];
if (in_array($action, DATASET_WRITE_ACTIONS, true)) {
    admin_require_write();   // POST + X-CSRF-Token; exits on failure
}

// ── Datasets still being imported ────────────────────────────────────────────
// A staged dataset is addressed as "staging:<type>/<folder>" and lives in the
// uploads/ store, not DATA_WEB. Routed here, BEFORE the DATA_WEB traversal gate
// below (which would reject the prefixed id): the staging library applies its own
// equivalent gate. Twin of dev_server.py _is_staged_id / _get_staged_dataset.
if (strncmp($id, LUMEN_STAGING_PREFIX, strlen(LUMEN_STAGING_PREFIX)) === 0) {
    [$sType, $sFolder] = lumen_split_staged_id($id);
    switch ($action) {
        case 'get':
            $meta = lumen_staged_dataset($sType, $sFolder);
            json_out($meta ?: ['error' => 'Not found'], $meta ? 200 : 404);
        case 'save':
            $body = lumen_request_json();
            if (!is_array($body)) json_out(['error' => 'Invalid JSON body'], 400);
            [$st, $pl] = lumen_up_write_metadata($sType, $sFolder, $body);
            json_out($pl, $st);
        case 'save_thumbnail':
            $bytes = thumbnail_bytes(lumen_request_json() ?? []);
            [$st, $pl] = lumen_up_write_thumbnail($sType, $sFolder, $bytes);
            if ($st === 200) $pl['path'] = lumen_staged_blob_url($sType, $sFolder, 'thumbnail.webp');
            json_out($pl, $st);
        case 'set_visibility':
            // A staged dataset is never in the public catalog — visibility is a
            // property of publication, decided when it is published.
            json_out(['error' => 'not_published'], 409);
        case 'gallery_add':
        case 'gallery_delete':
        case 'gallery_thumbs':
            // The staging store accepts only what the preprocessing pipeline emits
            // (lumen_up_classify); a gallery is attached once the import is published.
            json_out(['error' => 'not_published'], 409);
        default:
            json_out(['error' => 'Unknown action'], 400);
    }
}

// One traversal gate for every action that takes an id, applied BEFORE any path
// is built from it. `get` used to hand $id straight to dataset_dir(), which only
// string-substitutes separators — `?id=../../../../api` walked out of DATA_WEB.
if ($id !== '' && admin_safe_dataset($id) === null) {
    json_out(['error' => 'Invalid id'], 400);
}

switch ($action) {

    case 'list':
        // Staged imports are listed alongside published datasets so the editor is
        // ONE list: an import becomes editable the moment its coarse LOD lands,
        // long before it is published.
        try {
            lumen_up_recover_publish_leftovers();   // a publish killed between its renames
        } catch (Throwable $e) {
            error_log('datasets.php list: publish recovery failed: ' . $e->getMessage());
        }
        try {
            $staged = lumen_staged_rows();
        } catch (Throwable $e) {
            error_log('datasets.php list: staged rows unavailable: ' . $e->getMessage());
            $staged = [];
        }
        json_out(['datasets' => array_merge(list_datasets(), $staged), 'galleryMaxBytes' => gallery_max_bytes()]);

    case 'get':
        if (!$id) json_out(['error' => 'Missing id'], 400);
        $meta = get_dataset_meta($id, dataset_dir($id));
        if (!$meta) json_out(['error' => 'Not found'], 404);
        json_out($meta);

    case 'save':
        require_auth();
        if (!$id) json_out(['error' => 'Missing id'], 400);
        $body = lumen_request_json();
        if (!is_array($body)) json_out(['error' => 'Invalid JSON body'], 400);
        [$st, $pl] = save_dataset_meta($id, dataset_dir($id), $body);
        json_out($pl, $st);

    case 'save_thumbnail':
        require_auth();
        if (!$id) json_out(['error' => 'Missing id'], 400);
        $bytes = thumbnail_bytes(lumen_request_json() ?? []);
        $ds_dir = dataset_dir($id);
        if (!is_dir($ds_dir)) json_out(['error' => 'Dataset directory does not exist'], 404);
        if (!lumen_write_file_atomic($ds_dir . DIRECTORY_SEPARATOR . 'thumbnail.webp', $bytes)) {
            json_out(['error' => 'Failed to write thumbnail file'], 500);
        }
        lumen_catalog_invalidate();
        json_out(['ok' => true, 'path' => 'DATA_WEB/' . $id . '/thumbnail.webp']);

    case 'gallery_add':
        require_auth();
        if (!$id) json_out(['error' => 'Missing id'], 400);
        $ctype = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? '')))[0]));
        if (strncmp($ctype, 'image/', 6) === 0) {
            // The image as its raw bytes (no base64 inside JSON, +33%); name and
            // caption in the query string. Refused before reading when it cannot fit.
            $len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
            if ($len > gallery_max_bytes()) json_out(['error' => 'too_large', 'limit' => gallery_max_bytes()], 413);
            $raw = file_get_contents('php://input', false, null, 0, MAX_GALLERY_BYTES + 1);
            $body = ['raw' => is_string($raw) ? $raw : '',
                     'filename' => lumen_str($_GET['filename'] ?? null) ?? '',
                     'title'    => lumen_str($_GET['title'] ?? null) ?? '',
                     'caption'  => lumen_str($_GET['caption'] ?? null) ?? ''];
        } else {
            $body = lumen_request_json();
            if (!is_array($body)) json_out(['error' => 'Invalid JSON body'], 400);
        }
        [$st, $pl] = gallery_add($id, dataset_dir($id), $body);
        json_out($pl, $st);

    case 'gallery_delete':
        require_auth();
        if (!$id) json_out(['error' => 'Missing id'], 400);
        $body = lumen_request_json() ?? [];
        [$st, $pl] = gallery_delete(dataset_dir($id), $body['file'] ?? null);
        json_out($pl, $st);

    case 'gallery_thumbs':
        require_auth();
        if (!$id) json_out(['error' => 'Missing id'], 400);
        [$st, $pl] = gallery_thumbs(dataset_dir($id));
        json_out($pl, $st);

    case 'rebuild_catalog':
        require_auth();
        $catalog = rebuild_catalog();
        $catalog_path = $DATA_WEB . DIRECTORY_SEPARATOR . 'catalog.json';
        if (!write_json($catalog_path, $catalog)) json_out(['error' => 'Catalog write failed'], 500);
        json_out(['ok' => true, 'count' => count($catalog)]);

    case 'set_visibility':
        require_auth();
        if (!$id) json_out(['error' => 'Missing id'], 400);
        $body = lumen_request_json() ?? [];
        $meta_path = dataset_dir($id) . DIRECTORY_SEPARATOR . 'metadata.json';
        [$st, $pl] = lumen_with_lock($meta_path, function () use ($meta_path, $body) {
            $meta = read_json_doc($meta_path);
            if (!$meta) return [404, ['error' => 'Not found']];
            $meta['hidden'] = !empty($body['hidden']);
            $meta['_lastModified'] = date('c');
            if (!write_json($meta_path, $meta)) return [500, ['error' => 'Write failed']];
            return [200, ['ok' => true, 'hidden' => $meta['hidden']]];
        });
        if ($st === 200 && is_file($DATA_WEB . DIRECTORY_SEPARATOR . 'catalog.json')) {
            // The static copy only serves hosts without mod_rewrite; keep it from
            // still listing a dataset that was just hidden.
            write_json($DATA_WEB . DIRECTORY_SEPARATOR . 'catalog.json', rebuild_catalog());
        }
        json_out($pl, $st);

    default:
        json_out(['error' => 'Unknown action'], 400);
}
