<?php
/**
 * IRIBHM Microscopy Platform — Language Discovery API
 * ===================================================
 * Public endpoint (no auth) that enumerates the platform's available locales so
 * the language switcher is built from what actually ships, with no hardcoded
 * list. Mirrors the Python dev_server.py /api/languages route for PHP/legacy hosts.
 *
 * Endpoint:
 *   GET /api/languages.php   → { "languages": [ "en", "fr", "es", ... ] }
 *
 * Side effect: rewrites lang/manifest.json (best-effort) so static deploys keep
 * a fresh fallback with no manual build step. 'en' is always first (fallback).
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Access-Control-Allow-Origin: *');

$ROOT     = dirname(__DIR__);                          // WebPlatform root
$LANG_DIR = $ROOT . DIRECTORY_SEPARATOR . 'lang';

function discover_languages(): array {
    global $LANG_DIR;
    $codes = [];
    foreach ((is_dir($LANG_DIR) ? (scandir($LANG_DIR) ?: []) : []) as $f) {
        if ($f === 'manifest.json') continue;
        if (preg_match('/^([a-z]{2,3}(-[A-Za-z]{2,4})?)\.json$/', $f, $m)) $codes[$m[1]] = true;
    }
    $codes['en'] = true;                                // fallback always present
    $rest = array_keys($codes);
    sort($rest);
    $rest = array_values(array_filter($rest, fn($c) => $c !== 'en'));
    return array_merge(['en'], $rest);
}

function write_manifest(array $codes): void {
    global $LANG_DIR;
    @file_put_contents(
        $LANG_DIR . DIRECTORY_SEPARATOR . 'manifest.json',
        json_encode(['languages' => $codes], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)
    );
}

$codes = discover_languages();
write_manifest($codes);
echo json_encode(['languages' => $codes], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
