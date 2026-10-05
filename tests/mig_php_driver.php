<?php
/* CLI driver of the PHP migrations engine for the cross-backend tests
   (tests/test_mig_php_parity.py). Not a test itself.
     php tests/mig_php_driver.php <request.json>
   request: { dataWeb, uploads, private, ops: [ {op, …} ] } → prints a JSON list:
     {op:'handle', action, params?, body?, rawFile?}   → [status, payload]
     {op:'unit_tiles', dataset, unit}                  → {z: base64 PNG} (server executor)
     {op:'caps'}                                       → lumen_mig_capabilities()          */
declare(strict_types=1);

$req = json_decode((string)file_get_contents($argv[1]), true);
define('LUMEN_DATA_WEB', $req['dataWeb']);
define('LUMEN_UPLOADS_DIR', $req['uploads']);
define('LUMEN_PRIVATE_DIR', $req['private']);
if (!empty($req['zeroBudgetFloor'])) define('LUMEN_MIG_BUDGET_FLOOR', 0);
@mkdir($req['private'], 0777, true);
require __DIR__ . '/../api/_migrations_lib.php';

$out = [];
foreach ($req['ops'] as $op) {
    switch ($op['op']) {
        case 'handle':
            $raw = isset($op['rawFile']) ? (string)file_get_contents($op['rawFile']) : null;
            $out[] = lumen_mig_handle($op['action'], $op['params'] ?? [], $op['body'] ?? [], $raw);
            break;
        case 'unit_tiles':
            [$tiles, $read] = lumen_mig_process_unit(lumen_mig_plan_for($op['dataset']), lumen_mig_parse_key($op['unit']));
            $enc = [];
            foreach ($tiles as $z => $png) $enc[(string)$z] = base64_encode($png);
            $out[] = ['tiles' => (object)$enc, 'bytesRead' => $read];
            break;
        case 'caps':
            $out[] = lumen_mig_capabilities();
            break;
        default:
            $out[] = ['error' => 'unknown op'];
    }
}
echo json_encode($out, JSON_UNESCAPED_SLASHES);
