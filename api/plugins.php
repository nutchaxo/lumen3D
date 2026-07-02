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
require_once __DIR__ . '/_admin_lib.php';   // admin_compat_satisfies + admin_max_version

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
            // Advertise the locales this plugin ships (lang/<code>.json), mirroring
            // dev_server.py so the client loads only those and falls back to English.
            $shipped = [];
            $lang_dir = $mod_dir . DIRECTORY_SEPARATOR . 'lang';
            if (is_dir($lang_dir)) {
                foreach ((scandir($lang_dir) ?: []) as $lf) {
                    if (preg_match('/^([a-z]{2,3}(-[A-Za-z]{2,4})?)\.json$/', $lf, $m)) $shipped[] = $m[1];
                }
                sort($shipped);
            }
            if ($shipped) $meta['i18nLanguages'] = $shipped;
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

// Filter out admin-disabled plugins HERE (in discovery, before the client builds any
// UI) so the load-order invariant holds; the persisted manifest mirrors the exclusion.
$disabledPath = __DIR__ . DIRECTORY_SEPARATOR . 'disabled-plugins.json';
$disabled = [];
if (is_file($disabledPath)) {
    $dj = json_decode((string)@file_get_contents($disabledPath), true);
    if (is_array($dj) && isset($dj['disabled']) && is_array($dj['disabled'])) $disabled = $dj['disabled'];
}
if ($disabled) {
    $plugins = array_values(array_filter($plugins, fn($p) => !in_array($p['path'], $disabled, true)));
}

// Fail-closed compat gate (mirrors dev_server.py): an incompatible plugin is
// dropped from discovery so its index.js is never loaded on this host either.
$platformVer = admin_max_version($ROOT . '/changelog');
$plugins = array_values(array_filter(
    $plugins,
    fn($p) => admin_compat_satisfies($platformVer, $p['platformCompat'] ?? null)[0]
));

// Fail-closed trust gate: untrusted plugins are excluded; survivors carry a `trust`
// vouch the client re-verifies over the exact bytes it executes.
$approvals = admin_load_trust();
$manifest  = admin_release_manifest();
$trusted = [];
foreach ($plugins as $p) {
    $tr = admin_classify_plugin($p['path'], $MODULES_DIR . '/' . $p['path'], $approvals, $manifest);
    if ($tr['tier'] === 'untrusted') continue;
    $fh = admin_plugin_file_hashes($MODULES_DIR . '/' . $p['path']);
    $p['trust'] = ['tier' => $tr['tier'], 'hash' => $tr['hash'], 'mode' => $tr['mode'] ?? null,
                   'caps' => $tr['caps'] ?? null, 'files' => array_keys($fh)];
    $trusted[] = $p;
}
$plugins = $trusted;

write_manifest($plugins);
echo json_encode(['plugins' => $plugins], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
