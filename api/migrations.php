<?php
/**
 * Lumen3D — dataset migrations API (PHP twin of the dev_server.py route)
 * ======================================================================
 *   GET  ?action=status
 *   POST ?action=plan       { dataset, migration, offset?, limit? }
 *   POST ?action=unit_put&dataset=&migration=&unit=&dry=0|1     RAW body = unit blob
 *   POST ?action=unit_run   { dataset, migration, maxSeconds, dry }
 *   POST ?action=finalize   { dataset, migration, maxSeconds? }   (complete:false ⇒ call again)
 *   POST ?action=cancel     { dataset, migration }
 *   POST ?action=bench      { dataset, units: N }
 *
 * Contract: DOCS/dataset-migrations/SPEC.md §5; engine: api/_migrations_lib.php.
 * Every action needs the admin session; every POST also the CSRF header. The session
 * lock is released as soon as auth is decided: the browser executor keeps several
 * unit_put requests in flight, and a unit_run holds its request for up to 20 s.
 */
declare(strict_types=1);

require_once __DIR__ . '/_migrations_lib.php';

header('X-Content-Type-Options: nosniff');

admin_session_start();
$authed = admin_is_auth();
$csrfOk = admin_check_csrf();
if (session_status() === PHP_SESSION_ACTIVE) session_write_close();

$action = lumen_str($_GET['action'] ?? null) ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if (!$authed) admin_json_out(['error' => 'Not authenticated'], 401);

if (in_array($action, LUMEN_MIG_WRITE_ACTIONS, true)) {
    if ($method !== 'POST') admin_json_out(['error' => 'Method not allowed (use POST)'], 405);
    if (!$csrfOk)           admin_json_out(['error' => 'Invalid or missing CSRF token'], 403);
    lumen_mig_ensure_dirs();
} elseif ($action === 'status') {
    lumen_migrate_dataset_types();
}

$params = [];
foreach (['dataset', 'migration', 'unit', 'dry'] as $k) {
    $v = lumen_str($_GET[$k] ?? null);
    if ($v !== null) $params[$k] = $v;
}
// unit_put's body is the raw unit blob, streamed by the engine; every other POST is JSON.
$body = ($method === 'POST' && $action !== 'unit_put') ? (lumen_request_json() ?? []) : [];

switch ($action) {
case 'status': case 'plan': case 'unit_put': case 'unit_run': case 'finalize': case 'cancel': case 'bench':
    [$status, $payload] = lumen_mig_handle($action, $params, $body);
    admin_json_out($payload, $status);
}

admin_json_out(['error' => 'unknown_action'], 400);
