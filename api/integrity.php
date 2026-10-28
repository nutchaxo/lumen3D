<?php
/**
 * Lumen3D — dataset integrity check-up (PHP twin of the dev_server.py route)
 * ======================================================================
 *   GET ?action=list                       every published and staged dataset (cheap)
 *   GET ?action=check&dataset=<type>/<folder>            one published dataset
 *   GET ?action=check&dataset=staging:<type>/<folder>    one dataset still being imported
 *
 * Read-only; every action needs the admin session (released as soon as auth is
 * decided, like the other entry points). Engine: api/_integrity_lib.php.
 */
declare(strict_types=1);

require_once __DIR__ . '/_integrity_lib.php';

header('X-Content-Type-Options: nosniff');

admin_session_start();
$authed = admin_is_auth();
if (session_status() === PHP_SESSION_ACTIVE) session_write_close();

if (!$authed) admin_json_out(['error' => 'Not authenticated'], 401);
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') admin_json_out(['error' => 'Method not allowed (use GET)'], 405);

lumen_migrate_dataset_types();
header('Cache-Control: no-store');

$params = [];
foreach (['dataset'] as $k) {
    $v = lumen_str($_GET[$k] ?? null);
    if ($v !== null) $params[$k] = $v;
}
// A timelapse's manifest can be large: give the check room, and if PHP still dies (memory,
// time) answer with the reason instead of an empty 500 the page can only call "no answer".
@ini_set('memory_limit', '1024M');
@set_time_limit(300);
register_shutdown_function(function () {
    $e = error_get_last();
    if (!$e || !in_array($e['type'], [E_ERROR, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) return;
    if (($_GET['action'] ?? '') !== 'check') return;
    while (ob_get_level() > 0) @ob_end_clean();
    if (!headers_sent()) { http_response_code(200); header('Content-Type: application/json; charset=utf-8'); }
    echo json_encode(['ok' => true, 'result' => ['id' => (string)($_GET['dataset'] ?? ''), 'name' => (string)($_GET['dataset'] ?? ''),
        'status' => 'error', 'findings' => [lumen_int_finding('error', 'check_failed',
            'PHP stopped: ' . $e['message'] . ' (memory_limit=' . ini_get('memory_limit') . ', max_execution_time=' . ini_get('max_execution_time') . 's)')]]],
        JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
});
[$status, $payload] = lumen_int_handle(lumen_str($_GET['action'] ?? null) ?? '', $params);
admin_json_out($payload, $status);
