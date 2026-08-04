<?php
/**
 * Lumen3D — dataset import API (PHP twin of the dev_server.py /api/upload.php routes)
 * ===================================================================================
 *   POST ?action=plan            { datasets:[{type,folder,files:[{path,size}]}] }
 *   POST ?action=chunk&ds=&path=&index=&sha256=      RAW body = the chunk bytes
 *   POST ?action=file_done       { path, root }
 *   POST ?action=publish|discard|gc|save_metadata|save_thumbnail
 *   GET  ?action=limits|list|state|validate|metadata|blob
 *
 * Every action requires an authenticated admin session — including the reads: the
 * staging store holds bytes that have not passed validation and its existence
 * must not be probeable anonymously. Writes additionally require the CSRF header.
 *
 * Chunks travel as the RAW request body, not base64 inside JSON: base64 costs
 * +33% on the wire and would push a multi-megabyte string through json_decode on
 * every chunk. All chunk parameters ride in the query string instead.
 */
declare(strict_types=1);

require_once __DIR__ . '/_upload_lib.php';

admin_session_start();
$authed = admin_is_auth();
$csrfOk = admin_check_csrf();
// CRITICAL for throughput: PHP's file-backed sessions hold an exclusive lock for
// the whole request, so without this every parallel chunk POST would queue behind
// the previous one and the import would run at single-stream speed. Auth and CSRF
// are already decided above; nothing below needs $_SESSION.
if (session_status() === PHP_SESSION_ACTIVE) session_write_close();

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if (!$authed) admin_json_out(['error' => 'Not authenticated'], 401);

const LUMEN_UP_WRITE_ACTIONS = ['plan', 'chunk', 'file_done', 'publish', 'discard',
                                'save_metadata', 'save_thumbnail', 'gc'];

if (in_array($action, LUMEN_UP_WRITE_ACTIONS, true)) {
    if ($method !== 'POST') admin_json_out(['error' => 'Method not allowed (use POST)'], 405);
    if (!$csrfOk)           admin_json_out(['error' => 'Invalid or missing CSRF token'], 403);
    lumen_up_ensure_dirs();
}

$ds = (string)($_GET['ds'] ?? '');
$slash = strpos($ds, '/');
$type   = $slash === false ? $ds : substr($ds, 0, $slash);
$folder = $slash === false ? ''  : substr($ds, $slash + 1);

/** JSON request body (never read for `chunk` — that body is raw octets). */
function lumen_up_body(): array {
    static $cached = null;
    if ($cached !== null) return $cached;
    $raw = file_get_contents('php://input');
    $d = $raw === false ? null : json_decode($raw, true);
    return $cached = (is_array($d) ? $d : []);
}

/** Emit [status, payload] from the library uniformly. */
function lumen_up_out($result): void {
    if (is_array($result) && count($result) === 2 && is_int($result[0]) && is_array($result[1])) {
        admin_json_out($result[1], $result[0]);
    }
    admin_json_out(is_array($result) ? $result : ['ok' => true]);
}

switch ($action) {

case 'limits':
    // The client sizes its chunks from this. Unlike Python, a PHP host has a hard
    // post_max_size — exceeding it makes PHP discard the body with no error, so
    // advertising the real ceiling is what keeps the import from stalling.
    admin_json_out([
        'ok' => true,
        'chunkSize'    => min(LUMEN_UP_DEFAULT_CHUNK, lumen_up_chunk_limit()),
        'maxChunkSize' => lumen_up_chunk_limit(),
        'parallel'     => 3,
        'staleAfterS'  => LUMEN_UP_STALE_AFTER,
        'backend'      => 'php',
        'postMaxSize'  => ini_get('post_max_size'),
    ]);

case 'list':
    lumen_up_gc();
    admin_json_out(['ok' => true, 'datasets' => lumen_up_list()]);

case 'state':
    $info = lumen_up_describe($type, $folder);
    admin_json_out($info ? array_merge(['ok' => true], $info) : ['error' => 'not_staged'], $info ? 200 : 404);

case 'validate':
    admin_json_out(lumen_up_validate_dataset($type, $folder));

case 'metadata':
    $meta = lumen_up_read_metadata($type, $folder);
    admin_json_out($meta ?: ['error' => 'not_staged'], $meta ? 200 : 404);

case 'blob':
    lumen_up_serve_blob($type, $folder, (string)($_GET['path'] ?? ''));
    exit;

case 'plan':
    $body = lumen_up_body();
    $r = lumen_up_plan($body['datasets'] ?? null, $body['chunkSize'] ?? LUMEN_UP_DEFAULT_CHUNK);
    admin_json_out($r, empty($r['ok']) ? 400 : 200);

case 'chunk':
    $index = isset($_GET['index']) && is_numeric($_GET['index']) ? (int)$_GET['index'] : -1;
    $data = file_get_contents('php://input');
    if ($data === false) admin_json_out(['error' => 'short_body'], 400);
    // A body larger than post_max_size arrives EMPTY (PHP discards it silently).
    // Report that as a distinct error so the client can renegotiate its chunk size
    // instead of retrying the same oversized request forever.
    $declared = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($declared > 0 && strlen($data) !== $declared) {
        admin_json_out(['error' => 'body_truncated', 'maxChunkSize' => lumen_up_chunk_limit(),
                        'declared' => $declared, 'received' => strlen($data)], 413);
    }
    lumen_up_out(lumen_up_write_chunk($type, $folder, $_GET['path'] ?? '', $index, $data, $_GET['sha256'] ?? null));

case 'file_done':
    $body = lumen_up_body();
    lumen_up_out(lumen_up_finalize($type, $folder, $body['path'] ?? '', $body['root'] ?? null));

case 'save_metadata':
    $body = lumen_up_body();
    lumen_up_out(lumen_up_write_metadata($type, $folder, $body['metadata'] ?? null));

case 'save_thumbnail':
    $body = lumen_up_body();
    $image = (string)($body['image'] ?? '');
    if (strncmp($image, 'data:image/', 11) !== 0) admin_json_out(['error' => 'Invalid image format'], 400);
    $comma = strpos($image, ',');
    $bytes = $comma === false ? false : base64_decode(substr($image, $comma + 1), true);
    if ($bytes === false || $bytes === '' || strlen($bytes) > 5242880) admin_json_out(['error' => 'Invalid image'], 400);
    lumen_up_out(lumen_up_write_thumbnail($type, $folder, $bytes));

case 'publish':
    $body = lumen_up_body();
    lumen_up_out(lumen_up_publish($type, $folder, !empty($body['overwrite']),
                                  array_key_exists('hidden', $body) ? (bool)$body['hidden'] : true));

case 'discard':
    lumen_up_out(lumen_up_discard($type, $folder));

case 'gc':
    admin_json_out(array_merge(['ok' => true], lumen_up_gc()));
}

admin_json_out(['error' => "Unknown action: $action"], 400);

/**
 * Stream one staged file to an authenticated admin.
 *
 * The ONLY way bytes leave the staging store before publication, and what lets
 * the operator preview and edit a dataset while the rest of it is still arriving.
 * Served as opaque octets with nosniff, so a file that somehow carried markup can
 * never be interpreted as a document. Range is honoured for viewer retries.
 */
function lumen_up_serve_blob(string $type, string $folder, string $rel): void {
    $path = lumen_up_file_path($type, $folder, $rel);
    if ($path === null || !is_file($path)) { http_response_code(404); header('Content-Type: application/json'); echo '{"error":"Not found"}'; return; }
    clearstatcache(true, $path);
    $size = (int)@filesize($path);

    $start = 0; $end = $size - 1; $status = 200;
    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if (strncmp($range, 'bytes=', 6) === 0) {
        [$lo, $hi] = array_pad(explode('-', substr($range, 6), 2), 2, '');
        $s = $lo === '' ? 0 : (int)$lo;
        $e = $hi === '' ? $size - 1 : (int)$hi;
        if ($s >= 0 && $s <= $e && $e < $size) { $start = $s; $end = $e; $status = 206; }
    }
    $length = $end - $start + 1;

    http_response_code($status);
    header('Content-Type: application/octet-stream');
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . $length);
    header('Accept-Ranges: bytes');
    header('Cache-Control: no-store');
    if ($status === 206) header("Content-Range: bytes $start-$end/$size");
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') return;

    // Stream in blocks: a pack is several MB and a download original can be tens
    // of gigabytes — readfile() would try to buffer the whole thing.
    while (ob_get_level() > 0) ob_end_clean();
    $fh = @fopen($path, 'rb');
    if ($fh === false) return;
    @fseek($fh, $start);
    $remaining = $length;
    while ($remaining > 0 && !feof($fh)) {
        $block = fread($fh, (int)min($remaining, 1048576));
        if ($block === false || $block === '') break;
        echo $block;
        $remaining -= strlen($block);
        if (connection_aborted()) break;
        @flush();
    }
    @fclose($fh);
}
