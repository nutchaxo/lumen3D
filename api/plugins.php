<?php
/**
 * IRIBHM Microscopy Platform — Plugin Discovery API
 * ==================================================
 * Public endpoint (no auth) that enumerates viewer plugins so the platform can
 * auto-incorporate them without a hardcoded manifest. Mirrors the Python
 * dev_server.py /api/plugins route for PHP/legacy hosts.
 *
 * Endpoint:
 *   GET /api/plugins.php   → { "plugins": [ { path, placement, id, ...meta }, ... ] }
 *
 * Side effect: rewrites js/modules/manifest.json (best-effort) so static
 * deploys keep a fresh fallback with no manual build step.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Access-Control-Allow-Origin: *');

$ROOT        = dirname(__DIR__);                                   // WebPlatform root
$MODULES_DIR = $ROOT . DIRECTORY_SEPARATOR . 'js' . DIRECTORY_SEPARATOR . 'modules';
$PLACEMENTS  = ['tools', 'channels', 'shaders'];
// Same guard as dev_server.py _SAFE_FOLDER_RE: one safe path component, no traversal.
$SAFE_FOLDER = '/^[A-Za-z0-9_][A-Za-z0-9._-]*$/';

function discover_plugins(): array {
    global $MODULES_DIR, $PLACEMENTS, $SAFE_FOLDER;
    $plugins = [];
    foreach ($PLACEMENTS as $placement) {
        $base = $MODULES_DIR . DIRECTORY_SEPARATOR . $placement;
        if (!is_dir($base)) continue;
        $entries = scandir($base);
        if ($entries === false) continue;
        sort($entries);
        foreach ($entries as $name) {
            if ($name === '.' || $name === '..') continue;
            if (!preg_match($SAFE_FOLDER, $name)) continue;
            $mod_dir = $base . DIRECTORY_SEPARATOR . $name;
            if (!is_dir($mod_dir)) continue;
            $meta_path = $mod_dir . DIRECTORY_SEPARATOR . 'plugin.json';
            if (!file_exists($meta_path)) continue;
            $raw  = file_get_contents($meta_path);
            $meta = $raw !== false ? json_decode($raw, true) : null;
            if (!is_array($meta)) continue;
            // Preserve the placement-from-directory contract.
            if (!empty($meta['placement']) && $meta['placement'] !== $placement) continue;
            $meta['placement'] = $placement;
            $meta['path']      = $placement . '/' . $name;
            $plugins[] = $meta;
        }
    }
    return $plugins;
}

function write_manifest(array $plugins): void {
    global $MODULES_DIR;
    $light = array_map(fn($p) => [
        'path'      => $p['path'],
        'placement' => $p['placement'],
        'id'        => $p['id'] ?? null,
    ], $plugins);
    @file_put_contents(
        $MODULES_DIR . DIRECTORY_SEPARATOR . 'manifest.json',
        json_encode(['plugins' => $light], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)
    );
}

$plugins = discover_plugins();
write_manifest($plugins);
echo json_encode(['plugins' => $plugins], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
