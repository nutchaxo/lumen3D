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
[$status, $payload] = lumen_int_handle(lumen_str($_GET['action'] ?? null) ?? '', $params);
admin_json_out($payload, $status);
