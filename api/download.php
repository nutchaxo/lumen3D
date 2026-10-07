<?php
/**
 * IRIBHM Microscopy Platform — download counter (Apache)
 * ======================================================
 * Apache serves DATA_WEB/<type>/<folder>/download/<file> straight from disk, so no
 * PHP ever saw a download and the Downloads statistic stayed at zero on a PHP host.
 * The root .htaccess now sends a full GET of an existing file under download/ here
 * first (never a HEAD, never a Range continuation, never a request already marked
 * lumen_dl=1). This script counts it (lumen_count_download, the twin of
 * dev_server.py _maybe_count_download) and answers a 302 to the same file with the
 * marker, which Apache then serves itself: Range support, the attachment header of
 * DATA_WEB/.htaccess and the host's own static performance are unchanged.
 *
 * The Location is RELATIVE and built from the file's own name only (percent-
 * encoded), so it can only point at the file that was asked for — this endpoint is
 * never an open redirect, whatever lumen_path holds.
 *
 *   GET api/download.php?lumen_path=DATA_WEB/<type>/<folder>/download/<file>
 *       (reached through the rewrite only; php -S counts in router.php instead)
 */

declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';

$rel = lumen_str($_GET['lumen_path'] ?? null) ?? '';
if (!preg_match('#^DATA_WEB/[^/]+/[^/]+/download/(?:[^/]+/)*([^/]+)$#D', $rel, $m)) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo 'Not found';
    exit;
}

lumen_count_download($rel, (string)($_SERVER['REQUEST_METHOD'] ?? 'GET'), isset($_SERVER['HTTP_RANGE']));

// Keep the visitor's own query (minus our routing key) and add the marker that
// lets the second request through to the static file.
$query = $_GET;
unset($query['lumen_path'], $query['lumen_dl']);
$query['lumen_dl'] = '1';

header('Cache-Control: no-store');
header('Location: ' . rawurlencode($m[1]) . '?' . http_build_query($query), true, 302);
exit;
