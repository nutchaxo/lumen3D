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
 *
 * Throttled per client IP and globally (token buckets, lumen_telemetry_allow):
 * a refused beacon answers 429 without touching api/stats.json.
 */

declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';

// Beacons are POSTs (navigator.sendBeacon); a GET would let any third-party page
// count visits with an <img> tag (twin of dev_server.py).
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') admin_json_out(['error' => 'Method not allowed (use POST)'], 405);
// Refused before anything is read or written: a flood costs a hash and two 16-byte
// slot updates per request (lumen_telemetry_allow), never a stats rewrite.
if (!lumen_telemetry_allow(admin_client_ip())) admin_json_out(['error' => 'rate_limited'], 429);

$action = lumen_str($_GET['action'] ?? null) ?? '';
if (!in_array($action, ['visit', 'view', 'download'], true)) admin_json_out(['error' => 'bad_kind'], 400);

// A non-string id (?id[]=x, {"id": 5}) is not an id: counted globally, never a 500.
$id = lumen_str($_GET['id'] ?? null);
if ($id === null && ($body = lumen_request_json()) !== null) $id = lumen_str($body['id'] ?? null);
if (in_array($action, ['view', 'download'], true)) {
    // The id must be well-formed AND name a dataset that exists. admin_safe_dataset()
    // only proves the shape is safe — it deliberately accepts a not-yet-created folder
    // so `save` can mint one. Without the is_dir() check this public, unauthenticated
    // beacon let anyone append unlimited invented dataset keys to api/stats.json,
    // growing the file without bound and flooding the admin stats table.
    $safe = $id ? admin_safe_dataset($id) : null;
    if ($safe === null || !is_file($safe[2] . '/metadata.json')) $id = null;   // still count globally
    else $id = $safe[0] . '/' . $safe[1];                                       // one key per dataset
} else {
    $id = null;
}
admin_record_event($action, $id);
admin_json_out(['ok' => true]);
