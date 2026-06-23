<?php
/**
 * IRIBHM Microscopy Platform — Dataset Download Listing API
 * =========================================================
 * Public endpoint (no auth) that lists the files an operator dropped into a
 * dataset's download folder, so the Download Center can render a file explorer
 * with no hardcoded manifest. Mirrors the Python dev_server.py /api/downloads
 * route for PHP/legacy hosts.
 *
 * Endpoint:
 *   GET /api/downloads.php?dataset=<type>/<folder>&path=<subdir>
 *     → { "dataset": "...", "path": "...", "available": true,
 *         "entries": [ { name, kind, ext?, sizeBytes?, count?, path, href? }, ... ] }
 *
 * The listed files live under DATA_WEB/<type>/<folder>/download/ and are already
 * statically downloadable, so no auth is required. Path traversal is blocked on
 * BOTH params: the dataset id (type allowlist + safe-folder regex) and the inner
 * path (no '..'/dotfile/absolute segments, then realpath containment) — Rule 1.4:
 * reject, never partially mount.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Access-Control-Allow-Origin: *');

$ROOT          = dirname(__DIR__);                                   // WebPlatform root
$DATA_WEB      = $ROOT . DIRECTORY_SEPARATOR . 'DATA_WEB';
$ALLOWED_TYPES = ['fixed', 'live', 'tracking'];
// Same guard as dev_server.py _SAFE_FOLDER_RE: one safe path component, no traversal.
$SAFE_FOLDER   = '/^[A-Za-z0-9_][A-Za-z0-9._-]*$/';

function fail(int $status, string $msg): void {
    http_response_code($status);
    echo json_encode(['error' => $msg]);
    exit;
}

/** Resolve a real path and confirm it stays within $rootReal (already realpath'd). */
function within(string $path, string $rootReal): ?string {
    $real = realpath($path);
    if ($real === false) return null;
    if ($real === $rootReal) return $real;
    if (strpos($real, $rootReal . DIRECTORY_SEPARATOR) === 0) return $real;
    return null;
}

$datasetId = isset($_GET['dataset']) ? (string) $_GET['dataset'] : '';
$subpath   = isset($_GET['path']) ? (string) $_GET['path'] : '';

// ── Validate dataset id "<type>/<folder>" ───────────────────────────────────
$parts = explode('/', $datasetId, 2);
if (count($parts) !== 2) fail(400, 'Invalid dataset');
$typeDir = trim($parts[0]);
$folder  = trim($parts[1]);
if (!in_array($typeDir, $ALLOWED_TYPES, true)) fail(400, 'Invalid dataset');
if ($folder === '.' || $folder === '..' || !preg_match($SAFE_FOLDER, $folder)) fail(400, 'Invalid dataset');

$datasetSafe  = $typeDir . '/' . $folder;
$downloadRoot = $DATA_WEB . DIRECTORY_SEPARATOR . $typeDir . DIRECTORY_SEPARATOR . $folder . DIRECTORY_SEPARATOR . 'download';

// ── Validate inner path (segment allowlist) ─────────────────────────────────
if (strpos($subpath, "\0") !== false) fail(400, 'Invalid path');
$rel  = trim(str_replace('\\', '/', $subpath), '/');
$segs = ($rel === '') ? [] : explode('/', $rel);
foreach ($segs as $seg) {
    if ($seg === '' || $seg === '.' || $seg === '..' || $seg[0] === '.') fail(400, 'Invalid path');
}

// No download/ folder provisioned for this dataset → empty listing, not an error.
$rootReal = realpath($downloadRoot);
if ($rootReal === false || !is_dir($rootReal)) {
    echo json_encode(['dataset' => $datasetSafe, 'path' => '', 'available' => false, 'entries' => []]);
    exit;
}

// ── Resolve + contain the target directory ──────────────────────────────────
$targetRaw  = $downloadRoot . ($segs ? DIRECTORY_SEPARATOR . implode(DIRECTORY_SEPARATOR, $segs) : '');
$targetReal = within($targetRaw, $rootReal);
if ($targetReal === null || !is_dir($targetReal)) fail(404, 'Not found');

$relPosix = implode('/', $segs);

$entries = [];
foreach ((scandir($targetReal) ?: []) as $name) {
    if ($name === '.' || $name === '..' || $name[0] === '.') continue;
    $realFull = within($targetReal . DIRECTORY_SEPARATOR . $name, $rootReal);
    if ($realFull === null) continue;  // symlink/junction pointing outside the root
    $childRel = ($relPosix === '') ? $name : ($relPosix . '/' . $name);
    if (is_dir($realFull)) {
        $count = 0;
        foreach ((scandir($realFull) ?: []) as $sub) {
            if ($sub === '.' || $sub === '..' || $sub[0] === '.') continue;
            $count++;
        }
        $entries[] = ['name' => $name, 'kind' => 'dir', 'path' => $childRel, 'count' => $count];
    } elseif (is_file($realFull)) {
        $size = @filesize($realFull);
        $dot  = strrpos($name, '.');
        $ext  = ($dot !== false && $dot < strlen($name) - 1) ? strtoupper(substr($name, $dot + 1)) : 'FILE';
        $entries[] = [
            'name'      => $name,
            'kind'      => 'file',
            'ext'       => $ext,
            'sizeBytes' => $size === false ? null : $size,
            'path'      => $childRel,
            'href'      => 'DATA_WEB/' . $datasetSafe . '/download/' . $childRel,
        ];
    }
}

usort($entries, function ($a, $b) {
    $ad = $a['kind'] === 'dir' ? 0 : 1;
    $bd = $b['kind'] === 'dir' ? 0 : 1;
    if ($ad !== $bd) return $ad - $bd;
    return strcasecmp($a['name'], $b['name']);
});

echo json_encode(
    ['dataset' => $datasetSafe, 'path' => $relPosix, 'available' => true, 'entries' => $entries],
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
);
