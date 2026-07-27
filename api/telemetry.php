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
    // The id must be well-formed AND name a dataset that exists. admin_safe_dataset()
    // only proves the shape is safe — it deliberately accepts a not-yet-created folder
    // so `save` can mint one. Without the is_dir() check this public, unauthenticated
    // beacon let anyone append unlimited invented dataset keys to api/stats.json,
    // growing the file without bound and flooding the admin stats table.
    $safe = $id ? admin_safe_dataset($id) : null;
    if ($safe === null || !is_dir($safe[2])) $id = null;   // still count globally
} else {
    $id = null;
}
admin_record_event($action, $id);
admin_json_out(['ok' => true]);
