<?php
/**
 * IRIBHM Microscopy Platform — Usage telemetry beacons (PHP fallback)
 * ===================================================================
 * Public, unauthenticated increment-only beacons (navigator.sendBeacon). Mirrors
 * dev_server.py /api/telemetry.php.
 *
 *   POST ?action=visit
 *   POST ?action=view&id=<type/folder>
 *   POST ?action=download&id=<type/folder>
 */

declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';

$action = $_GET['action'] ?? '';
if (!in_array($action, ['visit', 'view', 'download'], true)) admin_json_out(['error' => 'bad_kind'], 400);

$id = $_GET['id'] ?? (json_decode(file_get_contents('php://input'), true)['id'] ?? null);
if (in_array($action, ['view', 'download'], true)) {
    if (!$id || admin_safe_dataset($id) === null) $id = null;  // still count globally
} else {
    $id = null;
}
admin_record_event($action, $id);
admin_json_out(['ok' => true]);
